/**
 * Inside the 3D canvas while render mode is on: hands the frame loop to a
 * GPU path tracer, which re-lights the same scene with real light bounces and
 * soft shadows, sample by sample, until the picture is clean.
 *
 * Mounted only while rendering — a priority useFrame takes over drawing, and
 * everything it changes (sky, controls) is put back on unmount.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { DenoiseMaterial, GradientEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RENDER_SAMPLES, RENDER_SIZES, RENDER_TUNING, useRenderStore } from './renderStore';
import { downloadBlob } from '../../serialize';
import { usePlanStore } from '../../store';
import { fileSlug } from '../snapshot';
import { texturesReady } from '../textureSet';

function dataUrlBlob(url: string): Blob {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * The tracer gives every mesh exactly one material (it can't read geometry
 * groups), and a mesh with several shifts every later mesh's material by one.
 * So for the render, stand in one single-material mesh per group.
 */
function splitMultiMaterial(scene: THREE.Scene): { hidden: THREE.Mesh[]; added: THREE.Mesh[] } {
  const targets: THREE.Mesh[] = [];
  scene.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && Array.isArray(m.material) && m.parent) targets.push(m);
  });
  const hidden: THREE.Mesh[] = [];
  const added: THREE.Mesh[] = [];
  for (const mesh of targets) {
    const src = mesh.geometry;
    const materials = mesh.material as THREE.Material[];
    const groups = src.groups.length ? src.groups : [{ start: 0, count: src.index ? src.index.count : src.attributes.position.count, materialIndex: 0 }];
    mesh.updateMatrix();
    for (const g of groups) {
      const material = materials[g.materialIndex ?? 0];
      if (!material || g.count <= 0) continue;
      const geo = new THREE.BufferGeometry();
      if (src.index) {
        for (const [name, attr] of Object.entries(src.attributes)) geo.setAttribute(name, attr);
        geo.setIndex(Array.from(src.index.array.slice(g.start, g.start + g.count)));
      } else {
        for (const [name, attr] of Object.entries(src.attributes)) {
          const a = attr as THREE.BufferAttribute;
          const size = a.itemSize;
          const arr = (a.array as Float32Array).slice(g.start * size, (g.start + g.count) * size);
          geo.setAttribute(name, new THREE.BufferAttribute(arr, size, a.normalized));
        }
      }
      const part = new THREE.Mesh(geo, material);
      part.matrixAutoUpdate = false;
      part.matrix.copy(mesh.matrix);
      part.name = `${mesh.name}#${g.materialIndex}`;
      mesh.parent!.add(part);
      added.push(part);
    }
    mesh.visible = false;
    hidden.push(mesh);
  }
  return { hidden, added };
}

export function PathTrace() {
  // A new size starts the render over: remounting rebuilds the tracer at that size.
  const runNonce = useRenderStore((s) => s.runNonce);
  return <Tracer key={runNonce} />;
}

function Tracer() {
  const get = useThree((s) => s.get);
  const tracer = useRef<WebGLPathTracer | null>(null);
  const ready = useRef(false);
  const denoiser = useRef<FullScreenQuad | null>(null);
  const lastSave = useRef(useRenderStore.getState().saveNonce);

  useEffect(() => {
    let cancelled = false;
    const { gl, scene, camera, invalidate } = get();
    const controls = get().controls as { enabled: boolean } | null;

    const pt = new WebGLPathTracer(gl);
    pt.renderDelay = 0;
    pt.fadeDuration = 0;
    pt.minSamples = 1;
    pt.bounces = RENDER_TUNING.bounces;
    pt.filterGlossyFactor = 0.5;
    // A sample is drawn in 2×2 tiles, one per frame, so the page stays responsive (Cancel works) while tracing.
    pt.tiles.set(1, 1);
    // Trace at the size asked for: a share of the screen, or a fixed width in pixels.
    const wanted = RENDER_SIZES.find((r) => r.id === useRenderStore.getState().size)?.width ?? null;
    const buffer = gl.getDrawingBufferSize(new THREE.Vector2());
    pt.renderScale = wanted ? Math.min(4, wanted / Math.max(1, buffer.x)) : RENDER_TUNING.scale;
    // Show the picture through an edge-keeping denoiser, so it reads clean long before it has fully converged.
    const denoise = new FullScreenQuad(new DenoiseMaterial({ sigma: 2.5, threshold: 0.06, kSigma: 1 }));
    pt.renderToCanvasCallback = (target, renderer) => {
      (denoise.material as DenoiseMaterial).map = target.texture;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      denoise.render(renderer);
      renderer.autoClear = autoClear;
    };
    tracer.current = pt;
    denoiser.current = denoise;

    // The hemisphere "sky light" isn't something a path tracer understands;
    // give it the same sky as a real environment to bounce light from.
    let hemi: THREE.HemisphereLight | null = null;
    scene.traverse((o) => {
      if (!hemi && (o as THREE.HemisphereLight).isHemisphereLight) hemi = o as THREE.HemisphereLight;
    });
    const sky = new GradientEquirectTexture(256);
    const h = hemi as THREE.HemisphereLight | null;
    // Bounced light compounds colour; pull the sky toward neutral so walls keep their own tone.
    const neutral = new THREE.Color('#ffffff');
    sky.topColor.copy(h?.color ?? new THREE.Color('#dfe6ee')).lerp(neutral, RENDER_TUNING.neutralSky);
    sky.bottomColor.copy(h?.groundColor ?? new THREE.Color('#cfc8b8')).lerp(neutral, RENDER_TUNING.neutralSky);
    sky.exponent = 1.5;
    sky.update();
    // With a photographed sky already lighting the scene, trace with that; otherwise the gradient stands in for the sky light.
    const hasSky = scene.environment !== null;
    const prevEnv = scene.environment;
    const prevEnvIntensity = scene.environmentIntensity;
    if (!hasSky) {
      scene.environment = sky;
      scene.environmentIntensity = (h ? h.intensity : 1) * RENDER_TUNING.sky;
    } else {
      scene.environmentIntensity = prevEnvIntensity * RENDER_TUNING.skyPhoto;
    }
    const prevExposure = gl.toneMappingExposure;
    gl.toneMappingExposure = prevExposure * RENDER_TUNING.exposure;

    // Real shadows replace the live view's fake ones; real light units differ from the live view's.
    const hidden: THREE.Object3D[] = [];
    const lights: [THREE.DirectionalLight, number][] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // The lawn's blades are for the live view: traced, each one would shadow the next and the lawn would go dark.
      if ((o as THREE.InstancedMesh).isInstancedMesh && o.visible) {
        o.visible = false;
        hidden.push(o);
        return;
      }
      if (mesh.isMesh && o.visible && (o.name === 'contact-shadow' || (mesh.material as THREE.Material)?.transparent && (mesh.material as THREE.MeshBasicMaterial).isMeshBasicMaterial)) {
        o.visible = false;
        hidden.push(o);
      }
      const light = o as THREE.DirectionalLight;
      if (light.isDirectionalLight) {
        lights.push([light, light.intensity]);
        light.intensity *= scene.environment ? RENDER_TUNING.sunWithSky : RENDER_TUNING.sun;
      }
      const lamp = o as THREE.PointLight;
      if (lamp.isPointLight) {
        lights.push([lamp as unknown as THREE.DirectionalLight, lamp.intensity]);
        lamp.intensity *= RENDER_TUNING.lamp;
      }
    });

    const split = splitMultiMaterial(scene);

    const prevControls = controls?.enabled ?? true;
    if (controls) controls.enabled = false;

    // A house is small: build the tracing structures synchronously, one tick
    // later so "Preparing…" gets painted first.
    const timer = window.setTimeout(async () => {
      await texturesReady(); // the tracer copies the photographs once, up front
      if (cancelled) return;
      try {
        pt.setScene(scene, camera);
        ready.current = true;
        useRenderStore.setState({ phase: 'rendering', samples: 0 });
        invalidate();
      } catch (e) {
        useRenderStore.setState({
          phase: 'error',
          error: e instanceof Error ? e.message : 'This device could not render the scene.',
        });
      }
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ready.current = false;
      tracer.current = null;
      pt.dispose();
      denoise.material.dispose();
      denoise.dispose();
      sky.dispose();
      scene.environment = prevEnv;
      scene.environmentIntensity = prevEnvIntensity;
      gl.toneMappingExposure = prevExposure;
      if (controls) controls.enabled = prevControls;
      for (const o of hidden) o.visible = true;
      for (const m of split.hidden) m.visible = true;
      for (const m of split.added) {
        m.removeFromParent();
        m.geometry.dispose();
      }
      for (const [light, intensity] of lights) light.intensity = intensity;
      invalidate();
    };
    // Built once per render session; a changed scene ends the session (see below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any change to the house mid-render would leave the traced scene stale: stop.
  // A save request is read inside a frame; once a render is finished the
  // canvas only draws on demand, so ask for one.
  useEffect(
    () =>
      useRenderStore.subscribe((s, p) => {
        if (s.saveNonce !== p.saveNonce) get().invalidate();
      }),
    [get],
  );

  useEffect(
    () =>
      usePlanStore.subscribe((s, p) => {
        if (s.walls !== p.walls || s.openings !== p.openings || s.furniture !== p.furniture || s.look !== p.look || s.customItems !== p.customItems) {
          useRenderStore.getState().stop();
        }
      }),
    [],
  );

  useFrame(({ gl, scene, camera, invalidate }) => {
    const pt = tracer.current;
    if (!pt || !ready.current) {
      // Still preparing: keep showing the ordinary view.
      gl.render(scene, camera);
      return;
    }
    const st = useRenderStore.getState();
    const wantsSave = st.saveNonce !== lastSave.current;
    if (pt.samples < RENDER_SAMPLES || wantsSave) {
      pt.renderSample();
      const n = Math.floor(pt.samples);
      if (n !== st.samples) useRenderStore.setState({ samples: Math.min(n, RENDER_SAMPLES) });
      if (pt.samples >= RENDER_SAMPLES && st.phase === 'rendering') useRenderStore.setState({ phase: 'done' });
      if (pt.samples < RENDER_SAMPLES) invalidate();
    }
    if (wantsSave) {
      lastSave.current = st.saveNonce;
      const name = `${fileSlug(usePlanStore.getState().name)}-render.png`;
      const quad = denoiser.current;
      const target = pt.target;
      let url: string;
      if (quad && target && target.width > gl.domElement.width) {
        // The picture was traced larger than the screen: draw it once at its own size to save it.
        const size = gl.getSize(new THREE.Vector2());
        const ratio = gl.getPixelRatio();
        pt.synchronizeRenderSize = false;
        try {
          gl.setPixelRatio(1);
          gl.setSize(target.width, target.height, false);
          (quad.material as DenoiseMaterial).map = target.texture;
          quad.render(gl);
          url = gl.domElement.toDataURL('image/png');
        } finally {
          gl.setPixelRatio(ratio);
          gl.setSize(size.x, size.y, false);
          pt.synchronizeRenderSize = true;
        }
        // Resizing cleared the canvas: put the picture back on screen.
        quad.render(gl);
      } else {
        // Read the canvas in the same frame it was drawn, before the browser clears it.
        url = gl.domElement.toDataURL('image/png');
      }
      downloadBlob(dataUrlBlob(url), name, 'image/png');
    }
  }, 1);

  return null;
}
