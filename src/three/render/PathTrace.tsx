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
import { DenoiseMaterial, GradientEquirectTexture, PhysicalCamera, WebGLPathTracer } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RENDER_SAMPLES, RENDER_SIZES, RENDER_TUNING, useRenderStore } from './renderStore';
import { downloadBlob } from '../../serialize';
import { usePlanStore } from '../../store';
import { fileSlug } from '../snapshot';
import { texturesReady } from '../textureSet';
import { straighten } from '../lens';
import { useViewStore } from '../viewStore';

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

/**
 * The tracer pours every mesh's vertex colours into one RGBA list, so a mesh with plain RGB colours
 * would skew every colour after it. For the render, stand in an RGBA copy of each such mesh.
 */
function rgbaColours(scene: THREE.Scene): { hidden: THREE.Mesh[]; added: THREE.Mesh[] } {
  const targets: THREE.Mesh[] = [];
  scene.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && m.parent && m.geometry?.attributes.color?.itemSize === 3) targets.push(m);
  });
  const hidden: THREE.Mesh[] = [];
  const added: THREE.Mesh[] = [];
  for (const mesh of targets) {
    const src = mesh.geometry;
    const rgb = src.attributes.color as THREE.BufferAttribute;
    const rgba = new Float32Array(rgb.count * 4);
    for (let i = 0; i < rgb.count; i++) {
      rgba[i * 4] = rgb.getX(i);
      rgba[i * 4 + 1] = rgb.getY(i);
      rgba[i * 4 + 2] = rgb.getZ(i);
      rgba[i * 4 + 3] = 1;
    }
    const geo = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) if (name !== 'color') geo.setAttribute(name, attr);
    geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    if (src.index) geo.setIndex(src.index);
    for (const g of src.groups) geo.addGroup(g.start, g.count, g.materialIndex);
    const part = new THREE.Mesh(geo, mesh.material);
    mesh.updateMatrix();
    part.matrixAutoUpdate = false;
    part.matrix.copy(mesh.matrix);
    part.castShadow = mesh.castShadow;
    part.receiveShadow = mesh.receiveShadow;
    part.name = mesh.name;
    mesh.parent!.add(part);
    added.push(part);
    mesh.visible = false;
    hidden.push(mesh);
  }
  return { hidden, added };
}

/**
 * Lit-window panes as the tracer can draw them. A live pane is an unlit card whose painted vertex
 * colours (a warm core several times brighter than white, fading out at its edges) make the glow; the
 * tracer can't light by vertex colour, so each pane's painted grid goes into one small picture, used as
 * its glow and its see-through edge, with the brightest value carried by the glow strength.
 * Panes whose grid can't be read glow evenly in their own colour. Returns the stand-ins and what to dispose.
 */
function glowingPanes(panes: THREE.Mesh[]): { added: THREE.Mesh[]; owned: { dispose: () => void }[] } {
  const added: THREE.Mesh[] = [];
  const owned: { dispose: () => void }[] = [];
  // Each painted pane is a row-major grid of (nu+1)×(nv+1) corners: find nu and nv from its first quad.
  const grids: { mesh: THREE.Mesh; nu: number; nv: number; colors: THREE.BufferAttribute }[] = [];
  const plain: THREE.Mesh[] = [];
  for (const mesh of panes) {
    const geo = mesh.geometry;
    const colors = geo.attributes.color as THREE.BufferAttribute | undefined;
    const index = geo.index;
    const count = geo.attributes.position.count;
    const row = index && index.count >= 3 ? Math.max(index.getX(0), index.getX(1), index.getX(2)) : 0;
    const nu = row - 1;
    const nv = row > 0 ? count / row - 1 : 0;
    if (colors && colors.itemSize === 4 && index && nu >= 1 && Number.isInteger(nv) && nv >= 1 && index.count === nu * nv * 6) {
      grids.push({ mesh, nu, nv, colors });
    } else plain.push(mesh);
  }
  const source = (mesh: THREE.Mesh): THREE.MeshBasicMaterial => mesh.material as THREE.MeshBasicMaterial;
  const standIn = (mesh: THREE.Mesh, material: THREE.Material, uv?: Float32Array): void => {
    const src = mesh.geometry;
    const geo = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(src.attributes)) geo.setAttribute(name, attr);
    if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (src.index) geo.setIndex(src.index);
    const part = new THREE.Mesh(geo, material);
    mesh.updateMatrix();
    part.matrixAutoUpdate = false;
    part.matrix.copy(mesh.matrix);
    part.name = 'window-glow-traced';
    mesh.parent?.add(part);
    added.push(part);
    owned.push(geo);
  };
  const flat = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  for (const mesh of plain) {
    const pane = source(mesh);
    let m = flat.get(pane);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: '#000000', emissive: pane.color ?? new THREE.Color('#ffc98a'), emissiveIntensity: RENDER_TUNING.windowGlow, roughness: 1, metalness: 0, side: pane.side });
      flat.set(pane, m);
      owned.push(m);
    }
    standIn(mesh, m);
  }
  if (grids.length) {
    // One strip of blocks, each padded by a copy of its own edge so neighbours never bleed into it.
    let peak = 0;
    for (const { colors } of grids) for (let i = 0; i < colors.count; i++) peak = Math.max(peak, colors.getX(i), colors.getY(i), colors.getZ(i));
    peak = Math.max(peak, 1e-3);
    const W = grids.reduce((w, g) => w + g.nu + 3, 0);
    const H = Math.max(...grids.map((g) => g.nv + 3));
    const data = new Uint8Array(W * H * 4);
    let x0 = 0;
    const byPane = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const placed: [THREE.Mesh, Float32Array][] = [];
    for (const { mesh, nu, nv, colors } of grids) {
      for (let y = 0; y < nv + 3; y++) {
        for (let x = 0; x < nu + 3; x++) {
          const i = Math.min(nv, Math.max(0, y - 1)) * (nu + 1) + Math.min(nu, Math.max(0, x - 1));
          const o = (y * W + x0 + x) * 4;
          data[o] = Math.round(255 * Math.min(1, colors.getX(i) / peak));
          data[o + 1] = Math.round(255 * Math.min(1, colors.getY(i) / peak));
          data[o + 2] = Math.round(255 * Math.min(1, colors.getZ(i) / peak));
          data[o + 3] = Math.round(255 * Math.max(0, Math.min(1, colors.getW(i))));
        }
      }
      const uv = new Float32Array(colors.count * 2);
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          const k = j * (nu + 1) + i;
          uv[k * 2] = (x0 + i + 1.5) / W;
          uv[k * 2 + 1] = (j + 1.5) / H;
        }
      }
      placed.push([mesh, uv]);
      x0 += nu + 3;
    }
    const atlas = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    atlas.colorSpace = THREE.LinearSRGBColorSpace;
    atlas.magFilter = THREE.LinearFilter;
    atlas.minFilter = THREE.LinearFilter;
    atlas.needsUpdate = true;
    owned.push(atlas);
    for (const [mesh, uv] of placed) {
      const pane = source(mesh);
      let m = byPane.get(pane);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          // Black, so it only glows; its picture's alpha fades the edges out as the live pane does.
          color: '#000000',
          map: atlas,
          transparent: true,
          emissive: (pane.color ?? new THREE.Color('#ffd9a8')).clone().multiplyScalar(peak),
          emissiveMap: atlas,
          emissiveIntensity: RENDER_TUNING.windowGlow,
          roughness: 1,
          metalness: 0,
          side: pane.side,
          depthWrite: false,
        });
        byPane.set(pane, m);
        owned.push(m);
      }
      standIn(mesh, m, uv);
    }
  }
  return { added, owned };
}

/** A share of light as it lands on screen after the renderer's curve (three's Neutral and plain exposure). */
function toScreen(c: THREE.Color, gl: THREE.WebGLRenderer): THREE.Vector3 {
  const e = gl.toneMappingExposure;
  let r = c.r * e;
  let g = c.g * e;
  let b = c.b * e;
  if (gl.toneMapping === THREE.NeutralToneMapping) {
    const start = 0.8 - 0.04;
    const x = Math.min(r, g, b);
    const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    r -= offset;
    g -= offset;
    b -= offset;
    const peak = Math.max(r, g, b);
    if (peak >= start) {
      const d = 1 - start;
      const newPeak = 1 - (d * d) / (peak + d - start);
      const k = 1 - 1 / (0.15 * (peak - newPeak) + 1);
      const s = newPeak / peak;
      r = r * s + (newPeak - r * s) * k;
      g = g * s + (newPeak - g * s) * k;
      b = b * s + (newPeak - b * s) * k;
    }
  }
  const out = { r: 0, g: 0, b: 0 };
  new THREE.Color()
    .setRGB(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)), THREE.LinearSRGBColorSpace)
    .getRGB(out, THREE.SRGBColorSpace);
  return new THREE.Vector3(out.r, out.g, out.b);
}

const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
});

function srgbByte(linear: number): number {
  const v = Math.max(0, Math.min(1, linear));
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}

/** Meters of lawn one repeat of the traced grass covers. */
const GRASS_TILE = 2.4;
/** The brightest blade tip the grass picture stores, as a share of the lawn colour. */
const GRASS_PEAK = 1.2;

/**
 * The lawn's blades seen from above, as one seamless picture: dark roots, lighter tips, each tuft a
 * little greener or drier, laid out like the live view's tufts. The tracer can't afford the blades
 * themselves, so the ground carries their look. Returns the picture and its average (in light).
 */
function grassTile(): { texture: THREE.CanvasTexture; mean: number } {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const css = (shade: number, dry: number): string => {
    const v = shade / GRASS_PEAK;
    return `rgb(${srgbByte(v * (1 + dry * 0.05))},${srgbByte(v * (1 + dry * 0.01))},${srgbByte(v * (1 - dry * 0.07))})`;
  };
  const px = size / GRASS_TILE;
  // Draw a shape and its copies across the picture's edges, so the tile repeats without a seam.
  const wrapped = (x: number, y: number, reach: number, draw: (x: number, y: number) => void): void => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (x + ox < -reach || x + ox > size + reach || y + oy < -reach || y + oy > size + reach) continue;
        draw(x + ox, y + oy);
      }
    }
  };
  // Earth and thatch between the tufts.
  ctx.fillStyle = css(0.5, 0.2);
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 2 + rand() * 6;
    ctx.fillStyle = css(0.38 + rand() * 0.3, rand() * 2 - 0.6);
    wrapped(x, y, r, (cx, cy) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  // Tufts on a jittered lattice as the live lawn plants them, in two layers so no grid shows.
  const blade = (x: number, y: number, a: number, len: number, half: number, own: number, dry: number): void => {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rx = x + ca * len * 0.15;
    const ry = y + sa * len * 0.15;
    const tx = x + ca * len;
    const ty = y + sa * len;
    wrapped(x, y, len + half, (cx, cy) => {
      const dx = cx - x;
      const dy = cy - y;
      const grad = ctx.createLinearGradient(rx + dx, ry + dy, tx + dx, ty + dy);
      grad.addColorStop(0, css(0.62 * own, dry));
      grad.addColorStop(0.55, css(0.92 * own, dry));
      grad.addColorStop(1, css(1.12 * own, dry));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(rx + dx - sa * half, ry + dy + ca * half);
      ctx.quadraticCurveTo(rx + dx + ca * len * 0.5 - sa * half * 0.8, ry + dy + sa * len * 0.5 + ca * half * 0.8, tx + dx, ty + dy);
      ctx.quadraticCurveTo(rx + dx + ca * len * 0.5 + sa * half * 0.8, ry + dy + sa * len * 0.5 - ca * half * 0.8, rx + dx + sa * half, ry + dy - ca * half);
      ctx.closePath();
      ctx.fill();
    });
  };
  for (const [cells, scale] of [[14, 1], [20, 0.7]] as const) {
    const cell = size / cells;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const x = (i + rand()) * cell;
        const y = (j + rand()) * cell;
        const w = 0.17 * px * (0.62 + 0.3 * rand()) * scale;
        const own = 0.9 + 0.2 * rand();
        const dry = (rand() * 2 - 1) * 0.7;
        const turn = rand() * Math.PI * 2;
        for (let k = 0; k < 3; k++) blade(x, y, turn + (k / 3) * Math.PI * 2 + (rand() - 0.5) * 0.6, w * (0.65 + 0.3 * rand()), w * 0.13, own, dry);
      }
    }
  }
  // How bright the picture is on average, in light, so the lawn can be set to the live view's brightness.
  const data = ctx.getImageData(0, 0, size, size).data;
  let sum = 0;
  for (let o = 0; o < data.length; o += 4 * 7) {
    sum += 0.2126 * SRGB_TO_LINEAR[data[o]] + 0.7152 * SRGB_TO_LINEAR[data[o + 1]] + 0.0722 * SRGB_TO_LINEAR[data[o + 2]];
  }
  const mean = sum / Math.ceil(data.length / (4 * 7));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return { texture, mean };
}

/** The live lawn's own tone (its drift picture and any vertex tint) at each of its corners, in light, as RGBA. */
function lawnTones(lawn: THREE.Mesh, material: THREE.MeshStandardMaterial): Float32Array {
  const geo = lawn.geometry;
  const count = geo.attributes.position.count;
  // Four parts per colour: the tracer merges every mesh's colours, and the rest of the scene stores RGBA.
  const out = new Float32Array(count * 4).fill(1);
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  const map = material.map;
  const image = map?.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  if (map && uv && image?.data && image.width && image.height && image.data.length >= image.width * image.height * 4) {
    const { data, width: w, height: h } = image as { data: ArrayLike<number>; width: number; height: number };
    const srgb = map.colorSpace === THREE.SRGBColorSpace;
    if (map.matrixAutoUpdate) map.updateMatrix();
    const p = new THREE.Vector2();
    const at = (x: number, y: number, k: number): number => {
      const v = data[(((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4) + k];
      return srgb ? SRGB_TO_LINEAR[v] : v / 255;
    };
    for (let i = 0; i < count; i++) {
      p.set(uv.getX(i), uv.getY(i)).applyMatrix3(map.matrix);
      const fx = p.x * w - 0.5;
      const fy = p.y * h - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const sx = fx - x0;
      const sy = fy - y0;
      for (let k = 0; k < 3; k++) {
        const a = at(x0, y0, k) + (at(x0 + 1, y0, k) - at(x0, y0, k)) * sx;
        const b = at(x0, y0 + 1, k) + (at(x0 + 1, y0 + 1, k) - at(x0, y0 + 1, k)) * sx;
        out[i * 4 + k] = a + (b - a) * sy;
      }
    }
  }
  const tint = geo.attributes.color as THREE.BufferAttribute | undefined;
  if (material.vertexColors && tint) {
    for (let i = 0; i < count; i++) {
      out[i * 4] *= tint.getX(i);
      out[i * 4 + 1] *= tint.getY(i);
      out[i * 4 + 2] *= tint.getZ(i);
    }
  }
  return out;
}

/**
 * A stand-in for the lawn while tracing: the same ground and tones, with the blades' look painted on.
 * The live lawn is hidden meanwhile; the caller removes the stand-in and disposes what it owns.
 */
function lawnStandIn(lawn: THREE.Mesh, grass: { texture: THREE.Texture; mean: number }): THREE.Mesh | null {
  const live = lawn.material as THREE.MeshStandardMaterial;
  if (Array.isArray(lawn.material) || !live.isMeshStandardMaterial || !lawn.parent) return null;
  const geo = new THREE.BufferGeometry();
  const pos = lawn.geometry.attributes.position as THREE.BufferAttribute;
  geo.setAttribute('position', pos);
  if (lawn.geometry.attributes.normal) geo.setAttribute('normal', lawn.geometry.attributes.normal);
  if (lawn.geometry.index) geo.setIndex(lawn.geometry.index);
  geo.setAttribute('color', new THREE.BufferAttribute(lawnTones(lawn, live), 4));
  // Ground coordinates in meters, so the grass is the same size everywhere.
  lawn.updateWorldMatrix(true, false);
  const uvs = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(lawn.matrixWorld);
    uvs[i * 2] = v.x / GRASS_TILE;
    uvs[i * 2 + 1] = v.z / GRASS_TILE;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  const material = new THREE.MeshStandardMaterial({
    map: grass.texture,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    polygonOffset: live.polygonOffset,
    polygonOffsetFactor: live.polygonOffsetFactor,
    polygonOffsetUnits: live.polygonOffsetUnits,
  });
  // As bright on average as the live lawn's own colour (tuned by eye: the blades shade each other).
  material.color.copy(live.color).multiplyScalar(RENDER_TUNING.grass / Math.max(0.05, grass.mean));
  material.name = 'lawn-traced';
  const mesh = new THREE.Mesh(geo, material);
  mesh.matrixAutoUpdate = false;
  lawn.updateMatrix();
  mesh.matrix.copy(lawn.matrix);
  mesh.name = 'lawn-traced';
  lawn.parent.add(mesh);
  return mesh;
}

/** No single sample may be brighter than this: one lucky bounce off a lamp or glossy roof would stay a white dot. */
function clampSamples(pt: WebGLPathTracer, max: number): void {
  const material = (pt as unknown as { _pathTracer?: { material?: THREE.ShaderMaterial } })._pathTracer?.material;
  const anchor = 'gl_FragColor.a *= opacity;';
  if (!material || typeof material.fragmentShader !== 'string' || !material.fragmentShader.includes(anchor)) return;
  material.fragmentShader = material.fragmentShader.replace(
    anchor,
    `{ float peak = max( gl_FragColor.r, max( gl_FragColor.g, gl_FragColor.b ) );
       if ( peak > ${max.toFixed(3)} ) gl_FragColor.rgb *= ${max.toFixed(3)} / peak; }
     ${anchor}`,
  );
  material.needsUpdate = true;
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
  const showRef = useRef<((renderer: THREE.WebGLRenderer) => void) | null>(null);
  const lastSave = useRef(useRenderStore.getState().saveNonce);
  const targetRef = useRef(RENDER_SAMPLES);

  useEffect(() => {
    let cancelled = false;
    const { gl, scene, camera, invalidate } = get();
    const controls = get().controls as { enabled: boolean } | null;

    // Trace through a camera with a real aperture, focused on what the view turns around; from outside,
    // levelled with the lens shifted, like the live view.
    const live = camera as THREE.PerspectiveCamera;
    const aim = (controls as unknown as { target?: THREE.Vector3 } | null)?.target?.clone() ?? new THREE.Vector3();
    const view = useViewStore.getState();
    const restoreLive = view.view === 'exterior' && view.straight ? straighten(live, aim) : null;
    const lensCam = new PhysicalCamera();
    lensCam.copy(live);
    restoreLive?.();
    lensCam.focusDistance = live.position.distanceTo(aim);
    lensCam.fStop = RENDER_TUNING.fStop;
    lensCam.apertureBlades = 6;
    lensCam.updateMatrixWorld(true);

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
    // The tracer knows nothing of fog: lay the live view's haze over its picture, from a depth image of the same view.
    const hazeDepth = new THREE.WebGLRenderTarget(1, 1);
    hazeDepth.depthTexture = new THREE.DepthTexture(1, 1);
    const capMats = new Map<string, THREE.ShaderMaterial>();
    const capMaterial = (like: THREE.Material, own: boolean): THREE.ShaderMaterial => {
      const hides = !like.depthWrite || !like.visible;
      const key = `${own}-${like.side}-${hides}`;
      let m = capMats.get(key);
      if (!m) {
        m = new THREE.ShaderMaterial({
          vertexShader: own
            ? 'attribute float haze; varying float vHaze; void main() { vHaze = haze; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
            : 'varying float vHaze; void main() { vHaze = 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'varying float vHaze; void main() { gl_FragColor = vec4(vHaze, vHaze, vHaze, 1.0); }',
          side: like.side,
          depthWrite: !hides,
          colorWrite: !hides,
        });
        capMats.set(key, m);
      }
      return m;
    };
    // Read the haze as it stands now (its reach follows the camera), as a fixed copy for this render.
    const fogOf = scene.fog && (scene.fog as THREE.Fog).isFog ? (scene.fog as THREE.Fog).clone() : null;
    const cam = lensCam;
    const prevExposure = gl.toneMappingExposure;
    gl.toneMappingExposure = prevExposure * RENDER_TUNING.exposure;
    const haze = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          tDepth: { value: hazeDepth.depthTexture },
          tCap: { value: hazeDepth.texture },
          // Laid over the finished picture, so the colour goes in as it would land on screen in the live view.
          color: { value: fogOf ? toScreen(fogOf.color, gl) : new THREE.Vector3(1, 1, 1) },
          near: { value: fogOf?.near ?? 1e9 },
          far: { value: fogOf?.far ?? 2e9 },
          cameraNear: { value: cam.near },
          cameraFar: { value: cam.far },
          projInverse: { value: cam.projectionMatrixInverse.clone() },
          camWorld: { value: cam.matrixWorld.clone() },
          skyBand: { value: RENDER_TUNING.skyHaze },
        },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: /* glsl */ `
          #include <packing>
          uniform sampler2D tDepth, tCap;
          uniform vec3 color;
          uniform float near, far, cameraNear, cameraFar, skyBand;
          uniform mat4 projInverse, camWorld;
          varying vec2 vUv;
          void main() {
            float d = texture2D(tDepth, vUv).x;
            float a;
            if (d >= 1.0) {
              // The sky: thick haze at the horizon thinning upward, so the far land runs into it with no line.
              vec4 p = projInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
              vec3 dir = normalize((camWorld * vec4(p.xyz / p.w, 0.0)).xyz);
              a = 1.0 - smoothstep(0.0, skyBand, dir.y);
            } else {
              // The land: the live view's fog curve, by distance along the view.
              float z = -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
              a = min(smoothstep(near, far, z), texture2D(tCap, vUv).r);
            }
            gl_FragColor = vec4(color, a);
          }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    // A lens darkens a little toward its corners (the live view does the same).
    const vignette = new FullScreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vec2 d = vUv - 0.5;
            float v = 1.0 - 0.22 * smoothstep(0.32, 0.85, length(d * vec2(1.0, 0.82)) * 1.25);
            gl_FragColor = vec4(vec3(v), 1.0);
          }
        `,
        blending: THREE.CustomBlending,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const show = (renderer: THREE.WebGLRenderer): void => {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      denoise.render(renderer);
      if (fogOf) haze.render(renderer);
      vignette.render(renderer);
      renderer.autoClear = autoClear;
    };
    pt.renderToCanvasCallback = (target, renderer) => {
      (denoise.material as DenoiseMaterial).map = target.texture;
      show(renderer);
    };
    tracer.current = pt;
    denoiser.current = denoise;
    showRef.current = show;

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

    // Everything the tracer should see differently from the live view. Done right before the scene is
    // handed over: the house may rebuild while textures load, and a mesh made since would slip through.
    const hidden: THREE.Object3D[] = [];
    const lights: [THREE.Light, number][] = [];
    // Leaf cards are wound both ways; the tracer drops a one-sided face seen from behind, so trace them two-sided.
    const sided = new Map<THREE.Material, THREE.Side>();
    // A lit window is a see-through card the tracer would skip: trace it as a glowing surface instead.
    const glowOwned: { dispose: () => void }[] = [];
    const standIns: THREE.Mesh[] = [];
    let grass: { texture: THREE.Texture; mean: number } | null = null;
    let split: { hidden: THREE.Mesh[]; added: THREE.Mesh[] } = { hidden: [], added: [] };
    const prepare = (): void => {
      const lawns: THREE.Mesh[] = [];
      const panes: THREE.Mesh[] = [];
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && o.visible) {
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (m?.name === 'planting' && !sided.has(m)) {
              sided.set(m, m.side);
              m.side = THREE.DoubleSide;
            }
          }
          if (!Array.isArray(mesh.material) && mesh.material?.name === 'window-glow') {
            panes.push(mesh);
            return;
          }
          if (o.name === 'lawn' && !(o as THREE.InstancedMesh).isInstancedMesh) lawns.push(mesh);
        }
        // The lawn's blades are for the live view: traced, each one would shadow the next and the lawn would go dark.
        if ((o as THREE.InstancedMesh).isInstancedMesh && o.visible) {
          o.visible = false;
          hidden.push(o);
          return;
        }
        // Real shadows replace the live view's fake ones.
        if (mesh.isMesh && o.visible && (o.name === 'contact-shadow' || (mesh.material as THREE.Material)?.transparent && (mesh.material as THREE.MeshBasicMaterial).isMeshBasicMaterial)) {
          o.visible = false;
          hidden.push(o);
        }
        // Real light units differ from the live view's.
        const light = o as THREE.DirectionalLight;
        if (light.isDirectionalLight) {
          lights.push([light, light.intensity]);
          light.intensity *= scene.environment ? RENDER_TUNING.sunWithSky : RENDER_TUNING.sun;
        }
        const lamp = o as THREE.PointLight;
        if (lamp.isPointLight) {
          lights.push([lamp, lamp.intensity]);
          lamp.intensity *= RENDER_TUNING.lamp;
        }
      });

      if (panes.length) {
        const glow = glowingPanes(panes);
        for (const m of panes) {
          m.visible = false;
          hidden.push(m);
        }
        standIns.push(...glow.added);
        glowOwned.push(...glow.owned);
      }

      // The lawn's blades stay hidden (above); the ground under them takes on their look instead.
      if (lawns.length) {
        const tile = grassTile();
        grass = tile;
        for (const lawn of lawns) {
          const stand = lawnStandIn(lawn, tile);
          if (!stand) continue;
          standIns.push(stand);
          lawn.visible = false;
          hidden.push(lawn);
        }
      }

      split = splitMultiMaterial(scene);
      const recoloured = rgbaColours(scene);
      split.hidden.push(...recoloured.hidden);
      split.added.push(...recoloured.added);

      // Foliage and glossy metal take longer to settle: give such a frame more samples.
      let hard = sided.size > 0;
      scene.traverseVisible((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!hard && (o as THREE.Mesh).isMesh && m?.isMeshStandardMaterial && m.metalness >= 0.5 && m.roughness <= 0.45) hard = true;
      });
      const target = Math.round(RENDER_SAMPLES * (hard ? RENDER_TUNING.hardSamples : 1));
      targetRef.current = target;
      useRenderStore.setState({ target });
    };
    clampSamples(pt, RENDER_TUNING.clamp);

    const prevControls = controls?.enabled ?? true;
    if (controls) controls.enabled = false;

    // A house is small: build the tracing structures synchronously, one tick
    // later so "Preparing…" gets painted first.
    const timer = window.setTimeout(async () => {
      await texturesReady(); // the tracer copies the photographs once, up front
      if (cancelled) return;
      try {
        prepare();
        pt.setScene(scene, lensCam);
        if (fogOf) {
          // One depth image of what the tracer sees (the camera holds still while it traces).
          const size = gl.getDrawingBufferSize(new THREE.Vector2());
          hazeDepth.setSize(size.x, size.y);
          const fog = scene.fog;
          const bg = scene.background;
          scene.background = null;
          // Its colour holds how much haze each surface may take: all of it, or what a far hill allows itself.
          const worn: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
          scene.traverseVisible((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.material) return;
            worn.push([mesh, mesh.material]);
            mesh.material = capMaterial(mesh.material, !!mesh.geometry.attributes.haze);
          });
          const clear = gl.getClearColor(new THREE.Color());
          const clearAlpha = gl.getClearAlpha();
          gl.setClearColor(0xffffff, 1);
          gl.setRenderTarget(hazeDepth);
          gl.clear();
          try {
            gl.render(scene, lensCam);
          } finally {
            for (const [mesh, material] of worn) mesh.material = material;
            gl.setRenderTarget(null);
            gl.setClearColor(clear, clearAlpha);
          }
          scene.fog = fog;
          scene.background = bg;
        }
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
      (haze.material as THREE.Material).dispose();
      haze.dispose();
      (vignette.material as THREE.Material).dispose();
      vignette.dispose();
      hazeDepth.depthTexture?.dispose();
      for (const m of capMats.values()) m.dispose();
      hazeDepth.dispose();
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
      for (const [m, side] of sided) m.side = side;
      for (const o of glowOwned) o.dispose();
      for (const m of standIns) {
        m.removeFromParent();
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      (grass as { texture: THREE.Texture } | null)?.texture.dispose();
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
    const target = targetRef.current;
    if (pt.samples < target || wantsSave) {
      pt.renderSample();
      const n = Math.floor(pt.samples);
      if (n !== st.samples) useRenderStore.setState({ samples: Math.min(n, target) });
      if (pt.samples >= target && st.phase === 'rendering') useRenderStore.setState({ phase: 'done' });
      if (pt.samples < target) invalidate();
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
          showRef.current?.(gl);
          url = gl.domElement.toDataURL('image/png');
        } finally {
          gl.setPixelRatio(ratio);
          gl.setSize(size.x, size.y, false);
          pt.synchronizeRenderSize = true;
        }
        // Resizing cleared the canvas: put the picture back on screen.
        showRef.current?.(gl);
      } else {
        // Read the canvas in the same frame it was drawn, before the browser clears it.
        url = gl.domElement.toDataURL('image/png');
      }
      downloadBlob(dataUrlBlob(url), name, 'image/png');
    }
  }, 1);

  return null;
}
