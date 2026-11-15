/**
 * The lawn a styled house stands on. Scene dressing only — never part of the
 * plan or of exported models.
 *
 * Two layers that share one colour, so they read as one surface:
 *  - soft ground out to the horizon, with slow drifts of tone and no
 *    photograph to repeat;
 *  - around the house, tufts of real blades (one instanced mesh), which keep
 *    clear of the house, its path and its doorstep, and thin out with
 *    distance until only the ground is left.
 *
 * The blades stand still: the view only draws when something changes, and a
 * lawn that waved in the wind would keep every laptop's fan running.
 */
import * as THREE from 'three';
import type { Point } from '../types';
import { parseHex } from './sun';

export interface LawnInput {
  /** Centre of the plan, and its half-size. */
  x: number;
  z: number;
  radius: number;
  color: string;
  /** Where nothing grows: rooms, path, doorstep (plan meters, x/y). */
  keepOut: Point[][];
  /** Bare strip along every keep-out edge (half a wall, and a little). */
  gap: number;
  /** How far past a keep-out edge the grass stays shorter. */
  margin: number;
}

/** The ground's drift pattern repeats every this many meters — far too wide to notice. */
const DRIFT_SPAN = 56;
const DRIFT_CELLS = 14;
const MAX_TUFTS = 60000;
const TUFT_SPACING = 0.17;

// ---------- slow drifts of tone, shared by ground and blades ----------

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function wrap(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Smooth noise that repeats every `cells` lattice steps. 0..1. */
function driftNoise(u: number, v: number, cells: number, seed: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (ix: number, iy: number): number => hash2(wrap(ix, cells), wrap(iy, cells), seed);
  const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

/** Lighter/darker (−1…1) and drier/lusher (−1…1) at a spot on the ground, in meters. */
function drift(x: number, z: number): [number, number] {
  const u = (x / DRIFT_SPAN) * DRIFT_CELLS;
  const v = (z / DRIFT_SPAN) * DRIFT_CELLS;
  const tone = driftNoise(u, v, DRIFT_CELLS, 1) * 0.65 + driftNoise(u * 2, v * 2, DRIFT_CELLS * 2, 2) * 0.35;
  const dry = driftNoise(u * 0.5 + 3.3, v * 0.5 + 7.1, DRIFT_CELLS / 2, 3);
  return [tone * 2 - 1, dry * 2 - 1];
}

/** The multiplier a drift puts on the lawn colour. */
function driftTint(x: number, z: number): [number, number, number] {
  const [tone, dry] = drift(x, z);
  const light = 1 + tone * 0.07;
  // Dry patches lean a little yellow, lush ones a little blue-green.
  return [light * (1 + dry * 0.05), light * (1 + dry * 0.01), light * (1 - dry * 0.07)];
}

/** What the texture stores (in light, not screen, units) at tint 1: the ground colour is divided by this to stay true. */
const MAP_UNITY = 0.72;

/** A share of light, 0..1, as the byte an image stores. */
function encode(linear: number): number {
  const v = Math.max(0, Math.min(1, linear));
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}

let driftMap: THREE.DataTexture | null = null;

function groundTexture(): THREE.DataTexture {
  if (driftMap) return driftMap;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [r, g, b] = driftTint((i / size) * DRIFT_SPAN, (j / size) * DRIFT_SPAN);
      const o = (j * size + i) * 4;
      // Written as an ordinary colour image, a little under white so a tint can also brighten.
      data[o] = encode(r * MAP_UNITY);
      data[o + 1] = encode(g * MAP_UNITY);
      data[o + 2] = encode(b * MAP_UNITY);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  driftMap = tex;
  return tex;
}


// ---------- one tuft ----------

/** Three blades leaning apart, one unit tall; darker at the root so tufts shade themselves. */
function tuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  const blades = 3;
  for (let b = 0; b < blades; b++) {
    const turn = (b / blades) * Math.PI * 2 + 0.4;
    const ax = Math.cos(turn);
    const az = Math.sin(turn);
    // Across the blade, and the way it leans.
    const wx = -az;
    const wz = ax;
    const half = 0.5;
    const lean = 0.42;
    const off = 0.18;
    const rows: [number, number, number][] = [
      // height, half-width, shade
      [0, half, 0.68],
      [0.55, half * 0.72, 0.92],
      [1, 0, 1.12],
    ];
    const base = positions.length / 3;
    for (const [h, w, shade] of rows) {
      const out = off + lean * h * h;
      const cx = ax * out;
      const cz = az * out;
      if (w === 0) {
        positions.push(cx, h, cz);
        colors.push(shade, shade, shade);
        normals.push(0, 1, 0);
      } else {
        positions.push(cx - wx * w, h, cz - wz * w, cx + wx * w, h, cz + wz * w);
        colors.push(shade, shade, shade, shade, shade, shade);
        normals.push(0, 1, 0, 0, 1, 0);
      }
    }
    const faces = [base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4];
    index.push(...faces);
    // And again facing the other way: a blade seen from behind keeps its upward normal, so it is lit like the ground.
    for (let f = 0; f < faces.length; f += 3) index.push(faces[f], faces[f + 2], faces[f + 1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // Every blade is lit as the ground is: a lawn reads as one soft surface, not a field of glints.
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(index);
  return geo;
}

// ---------- where grass may grow ----------

interface KeepOut {
  pts: Point[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function prepare(polys: Point[][], margin: number): KeepOut[] {
  const out: KeepOut[] = [];
  for (const pts of polys) {
    if (!Array.isArray(pts) || pts.length < 3) continue;
    if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    out.push({ pts, minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin });
  }
  return out;
}

/** Distance from a point to the nearest keep-out area: 0 inside one, `margin` or more when clear. */
function clearance(x: number, y: number, areas: KeepOut[], margin: number): number {
  let best = margin;
  for (const a of areas) {
    if (x < a.minX || x > a.maxX || y < a.minY || y > a.maxY) continue;
    const pts = a.pts;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const pi = pts[i];
      const pj = pts[j];
      if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
      const dx = pj.x - pi.x;
      const dy = pj.y - pi.y;
      const len = dx * dx + dy * dy;
      const t = len > 0 ? Math.max(0, Math.min(1, ((x - pi.x) * dx + (y - pi.y) * dy) / len)) : 0;
      const d = Math.hypot(x - (pi.x + dx * t), y - (pi.y + dy * t));
      if (d < best) best = d;
    }
    if (inside) return 0;
  }
  return best;
}

// ---------- the lawn ----------

function linear(hex: string): THREE.Color {
  const [r, g, b] = parseHex(hex);
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

function buildGround(input: LawnInput, reach: number): THREE.Mesh {
  const geo = new THREE.CircleGeometry(reach, 96);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (pos.getX(i) + input.x) / DRIFT_SPAN, (-pos.getY(i) + input.z) / DRIFT_SPAN);
  }
  const material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    map: groundTexture(),
    // Pushed back in depth so the path and floors always draw over it.
    polygonOffset: true,
    polygonOffsetFactor: 4,
    polygonOffsetUnits: 4,
  });
  material.color.copy(linear(input.color)).multiplyScalar(1 / MAP_UNITY);
  material.name = 'lawn';
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(input.x, -0.002, input.z);
  mesh.receiveShadow = true;
  mesh.name = 'lawn';
  return mesh;
}

function buildBlades(input: LawnInput): THREE.InstancedMesh | null {
  const { x: cx, z: cz, radius, margin, gap } = input;
  // Blades out to here; past the inner ring they shrink away into the ground.
  const outer = Math.min(radius + 18, Math.max(radius * 2.8, radius + 8));
  const inner = outer * 0.45;
  const spacing = Math.max(TUFT_SPACING, Math.sqrt((Math.PI * outer * outer) / MAX_TUFTS));
  const areas = prepare(input.keepOut, margin);
  const base = linear(input.color);

  const matrices: number[] = [];
  const tints: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3();
  const scale = new THREE.Vector3();

  // A lattice fixed to the ground, not to the house: moving a wall never reshuffles the lawn.
  const i0 = Math.floor((cx - outer) / spacing);
  const i1 = Math.ceil((cx + outer) / spacing);
  const j0 = Math.floor((cz - outer) / spacing);
  const j1 = Math.ceil((cz + outer) / spacing);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = (i + hash2(i, j, 11)) * spacing;
      const pz = (j + hash2(i, j, 12)) * spacing;
      const far = Math.hypot(px - cx, pz - cz);
      if (far > outer) continue;
      // Fewer and shorter toward the rim, so the edge of the blades never shows as a line.
      const fade = far <= inner ? 1 : 1 - (far - inner) / (outer - inner);
      if (fade < 1 && hash2(i, j, 13) > fade * 1.1) continue;
      const clear = clearance(px, pz, areas, margin);
      if (clear <= gap) continue;
      const near = Math.min(1, (clear - gap) / Math.max(0.01, margin - gap));

      const [tone] = drift(px, pz);
      const height = (0.11 + 0.1 * hash2(i, j, 14) + 0.03 * tone) * (0.45 + 0.55 * near) * (0.35 + 0.65 * fade);
      const width = spacing * (0.62 + 0.3 * hash2(i, j, 15));
      at.set(px, 0, pz);
      q.setFromAxisAngle(up, hash2(i, j, 16) * Math.PI * 2);
      scale.set(width, height, width);
      m.compose(at, q, scale);
      for (let k = 0; k < 16; k++) matrices.push(m.elements[k]);

      const [tr, tg, tb] = driftTint(px, pz);
      const own = 0.9 + 0.2 * hash2(i, j, 17);
      tints.push(base.r * tr * own, base.g * tg * own, base.b * tb * own);
    }
  }
  const count = matrices.length / 16;
  if (count === 0) return null;

  const material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });
  material.name = 'grass';
  const mesh = new THREE.InstancedMesh(tuftGeometry(), material, count);
  mesh.instanceMatrix.copyArray(matrices);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(tints), 3);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // One bounding sphere for the lot, so the whole lawn is culled or drawn together.
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 0, cz), outer + 1);
  mesh.name = 'grass';
  return mesh;
}

/** Ground to the horizon, and blades around the house. */
export function buildLawn(input: LawnInput): THREE.Group {
  const group = new THREE.Group();
  group.name = 'garden';
  group.add(buildGround(input, Math.max(input.radius * 14, 160)));
  const blades = buildBlades(input);
  if (blades) group.add(blades);
  return group;
}

export function disposeGarden(object: THREE.Object3D | null): void {
  const materials = new Set<THREE.Material>();
  object?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    materials.add(mesh.material as THREE.Material);
  });
  // The drift texture is shared by every lawn and kept.
  for (const mat of materials) mat.dispose();
}
