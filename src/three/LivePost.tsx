/**
 * How the live 3D view becomes a picture: the scene is drawn once, then
 * shaded where surfaces meet (so walls, furniture and ground sit together),
 * softened away from the house (the scale-model look), and only then mapped
 * to screen colours.
 *
 * All of it is three.js's own passes plus two small shaders — nothing a
 * browser's WebGL2 can't do — and it costs nothing while the view is still:
 * the canvas draws on demand, so these passes only run when something moves.
 *
 * Mounted while the ordinary view is showing; render mode (the path tracer)
 * takes the frame loop instead.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { livePost, POST_TUNING } from './postState';
import { useViewStore } from './viewStore';

const COPY_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Draws the scene with smooth edges into its own buffer, then hands it to the passes after it. */
class ScenePass extends Pass {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quad: FullScreenQuad;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;

  constructor(scene: THREE.Scene, camera: THREE.Camera, samples: number) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: this.target.texture } },
        vertexShader: COPY_VERTEX,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          varying vec2 vUv;
          void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
        `,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(read);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.target.dispose();
    (this.quad.material as THREE.Material).dispose();
    this.quad.dispose();
  }
}

/**
 * Soft focus: whatever sits near the focus distance stays sharp, and things
 * well in front of or behind it blur a little — what a camera does to a
 * scale model. One pass, a couple of dozen taps.
 */
class FocusPass extends Pass {
  readonly uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    tDepth: { value: THREE.Texture | null };
    texel: { value: THREE.Vector2 };
    near: { value: number };
    far: { value: number };
    focus: { value: number };
    band: { value: number };
    maxBlur: { value: number };
  };
  private readonly quad: FullScreenQuad;

  constructor(depth: THREE.Texture) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: depth },
      texel: { value: new THREE.Vector2(1, 1) },
      near: { value: 0.1 },
      far: { value: 1000 },
      focus: { value: 10 },
      band: { value: POST_TUNING.focusBand },
      maxBlur: { value: POST_TUNING.maxBlur },
    };
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: COPY_VERTEX,
        fragmentShader: /* glsl */ `
          #include <packing>
          uniform sampler2D tDiffuse;
          uniform sampler2D tDepth;
          uniform vec2 texel;
          uniform float near;
          uniform float far;
          uniform float focus;
          uniform float band;
          uniform float maxBlur;
          varying vec2 vUv;

          const int TAPS = 22;
          const float GOLDEN = 2.39996323;

          float distanceAt(vec2 uv) {
            return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far);
          }

          // The sky has no distance: keep it only a little soft, so clouds stay clouds.
          bool isSky(vec2 uv) {
            return texture2D(tDepth, uv).x >= 0.99999;
          }

          // 0 = sharp, 1 = as soft as it gets.
          float softness(float dist) {
            float off = (dist - focus) / focus;
            return off < 0.0
              ? smoothstep(band, band + 0.45, -off)
              : smoothstep(band, band + 1.6, off);
          }

          void main() {
            vec4 centre = texture2D(tDiffuse, vUv);
            float dist = distanceAt(vUv);
            float radius = (isSky(vUv) ? 0.35 : softness(dist)) * maxBlur;
            if (radius < 0.5) {
              gl_FragColor = centre;
              return;
            }
            vec3 sum = centre.rgb;
            float weight = 1.0;
            for (int i = 1; i <= TAPS; i++) {
              float r = sqrt(float(i) / float(TAPS)) * radius;
              float a = float(i) * GOLDEN;
              vec2 uv = vUv + vec2(cos(a), sin(a)) * r * texel;
              float d = distanceAt(uv);
              // Something sharp and in front must not smear over the soft ground behind it.
              float w = d >= dist ? 1.0 : clamp(softness(d) * maxBlur - r + 1.0, 0.0, 1.0);
              sum += texture2D(tDiffuse, uv).rgb * w;
              weight += w;
            }
            gl_FragColor = vec4(sum / weight, centre.a);
          }
        `,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
  }

  render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    this.uniforms.tDiffuse.value = read.texture;
    this.uniforms.texel.value.set(1 / read.width, 1 / read.height);
    renderer.setRenderTarget(this.renderToScreen ? null : write);
    this.quad.render(renderer);
  }

  dispose(): void {
    (this.quad.material as THREE.Material).dispose();
    this.quad.dispose();
  }
}

/** Left out of the shading: a lawn's blades would only add noise, and the painted-on ground shadow is not a surface. */
const NO_AO = new Set(['grass', 'contact-shadow']);

/** The shading pass, blind to the lawn's blades. */
class ShadePass extends GTAOPass {
  private skipped: THREE.Object3D[] = [];

  render(
    renderer: THREE.WebGLRenderer,
    write: THREE.WebGLRenderTarget,
    read: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    this.skipped.length = 0;
    this.scene.traverseVisible((o) => {
      if (NO_AO.has(o.name)) this.skipped.push(o);
    });
    for (const o of this.skipped) o.visible = false;
    try {
      super.render(renderer, write, read, deltaTime, maskActive);
    } finally {
      for (const o of this.skipped) o.visible = true;
    }
  }
}

interface Pipeline {
  composer: EffectComposer;
  ao: GTAOPass;
  focus: FocusPass;
  /** The pixel density the buffers were last sized for. */
  ratio: number;
  dispose: () => void;
}

function buildPipeline(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Pipeline {
  const composer = new EffectComposer(gl);
  const samples = Math.min(4, gl.capabilities.maxSamples);
  const scenePass = new ScenePass(scene, camera, samples);
  const ao = new ShadePass(scene, camera, 1, 1);
  ao.updateGtaoMaterial({
    radius: POST_TUNING.aoRadius,
    distanceExponent: 1.4,
    thickness: 1.2,
    scale: 1,
    samples: 12,
    distanceFallOff: 1,
    screenSpaceRadius: false,
  });
  ao.blendIntensity = POST_TUNING.aoStrength;
  const focus = new FocusPass(ao.depthTexture as THREE.Texture);
  const output = new OutputPass();
  composer.addPass(scenePass);
  composer.addPass(ao);
  composer.addPass(focus);
  composer.addPass(output);
  return {
    composer,
    ao,
    focus,
    ratio: gl.getPixelRatio(),
    dispose: () => {
      scenePass.dispose();
      ao.dispose();
      focus.dispose();
      output.dispose();
      composer.dispose();
    },
  };
}

export function LivePost() {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const pipeline = useRef<Pipeline | null>(null);
  const failed = useRef(false);

  useEffect(() => {
    const { gl, scene, camera, invalidate } = get();
    let built: Pipeline | null = null;
    try {
      built = buildPipeline(gl, scene, camera);
    } catch {
      failed.current = true;
    }
    pipeline.current = built;
    if (import.meta.env.DEV) (window as unknown as { __pipeline?: Pipeline | null }).__pipeline = built;
    invalidate();
    return () => {
      pipeline.current = null;
      built?.dispose();
      gl.setRenderTarget(null);
      invalidate();
    };
  }, [get]);

  useEffect(() => {
    const p = pipeline.current;
    if (!p) return;
    p.ratio = dpr;
    p.composer.setPixelRatio(dpr);
    p.composer.setSize(size.width, size.height);
    get().invalidate();
  }, [size, dpr, get]);

  useEffect(() => {
    const draw = (): void => {
      const { gl, scene, camera, controls } = get();
      const p = pipeline.current;
      if (!p || failed.current) {
        gl.render(scene, camera);
        return;
      }
      const cam = camera as THREE.PerspectiveCamera;
      const view = useViewStore.getState();
      // Sharp at whatever the camera is turning around: the house.
      const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target;
      p.focus.enabled = !view.walking && !!target;
      if (target) p.focus.uniforms.focus.value = Math.max(0.5, cam.position.distanceTo(target));
      p.focus.uniforms.near.value = cam.near;
      p.focus.uniforms.far.value = cam.far;
      const ratio = gl.getPixelRatio();
      p.focus.uniforms.maxBlur.value = POST_TUNING.maxBlur * ratio;
      p.focus.uniforms.band.value = POST_TUNING.focusBand;
      p.ao.blendIntensity = POST_TUNING.aoStrength;
      try {
        // Snapshot changes the canvas density for one frame: follow it.
        if (ratio !== p.ratio) {
          p.ratio = ratio;
          p.composer.setPixelRatio(ratio);
        }
        p.composer.render();
      } catch {
        // A device that can't run the passes still gets its model.
        failed.current = true;
        gl.setRenderTarget(null);
        gl.render(scene, camera);
      }
    };
    livePost.draw = draw;
    return () => {
      if (livePost.draw === draw) livePost.draw = null;
    };
  }, [get]);

  // Taking a priority slot hands this component the drawing of every frame.
  useFrame(() => livePost.draw?.(), 1);

  return null;
}
