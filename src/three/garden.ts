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
 * Inside the fence the grass is a mown lawn: short, close and a little
 * brighter, with a strip of longer grass the mower misses along the fence.
 * Outside it is meadow — taller, sparser, yellower, with flowers in it —
 * and the ground itself shifts tone to match.
 *
 * The blades stand still: the view only draws when something changes, and a
 * lawn that waved in the wind would keep every laptop's fan running.
 */
import * as THREE from 'three';
import type { Point } from '../types';
import type { Rect } from './footprint';
import type { Terrain } from './grounds';
import type { SitePlan } from './site';
import { mixHex, parseHex } from './sun';

export interface LawnInput {
  /** Ground height at a point (level when not given). */
  height?: (x: number, z: number) => number;
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
  /** The fenced lot: mown inside, meadow outside. Read from the terrain's site when not given. */
  lot?: Rect;
}

/** Where the lawn ends and the meadow begins, and what crosses the meadow. */
interface Zones {
  lot: Rect | null;
  lane: SitePlan['lane'];
  /** Areas that are not in `keepOut` but should be: the path's run out to the lane. */
  extra: Point[][];
}

function zonesOf(input: LawnInput): Zones {
  const site = (input.height as Terrain | undefined)?.site;
  return { lot: input.lot ?? site?.lot ?? null, lane: site?.lane ?? null, extra: site?.walk ? [site.walk] : [] };
}

/** How far a point is inside the fence: positive in the lot, negative out in the meadow. */
function fenceDepth(x: number, z: number, lot: Rect): number {
  const ix = Math.min(x - lot.x0, lot.x1 - x);
  const iz = Math.min(z - lot.y0, lot.y1 - z);
  if (ix >= 0 && iz >= 0) return Math.min(ix, iz);
  return -Math.hypot(Math.max(0, -ix), Math.max(0, -iz));
}

function distToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
  return Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
}

/** Tint on the lawn colour: mown grass a touch brighter and greener, meadow drier and yellower. */
const LAWN_TINT: [number, number, number] = [1.03, 1.07, 0.97];
const MEADOW_TINT: [number, number, number] = [1.1, 1.02, 0.8];
/** How far the blades run out into the meadow past the fence. */
const MEADOW_REACH = 9;
/** The strip along the inside of the fence the mower doesn't reach. */
const FENCE_BAND = 0.45;

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
        colors.push(shade, shade, shade, 1);
        normals.push(0, 1, 0);
      } else {
        positions.push(cx - wx * w, h, cz - wz * w, cx + wx * w, h, cz + wz * w);
        colors.push(shade, shade, shade, 1, shade, shade, shade, 1);
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
  // Four components, as everywhere else in the scene (the path tracer expects RGBA).
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geo.setIndex(index);
  return geo;
}

/** A flower head: a little five-petalled star facing up, yellow at the heart, one unit across. */
function flowerGeometry(): THREE.BufferGeometry {
  const positions: number[] = [0, 0.15, 0];
  const colors: number[] = [1, 0.78, 0.3, 1];
  const normals: number[] = [0, 1, 0];
  const index: number[] = [];
  const points = 10;
  for (let k = 0; k < points; k++) {
    const a = (k / points) * Math.PI * 2;
    const r = k % 2 ? 0.22 : 0.5;
    positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    colors.push(1, 1, 1, 1);
    normals.push(0, 1, 0);
  }
  // Wound to face up: anticlockwise seen from above (x right, z toward the viewer).
  for (let k = 0; k < points; k++) index.push(0, 1 + ((k + 1) % points), 1 + k);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
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

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function linear(hex: string): THREE.Color {
  const [r, g, b] = parseHex(hex);
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

function buildGround(input: LawnInput, reach: number): THREE.Mesh {
  // Rings closer together near the house, where the eye is; the land may rise and fall further out.
  const height = input.height ?? (() => 0);
  const { lot } = zonesOf(input);
  const rings = 96;
  const segs = 160;
  const pos: number[] = [];
  const uvs: number[] = [];
  const cols: number[] = [];
  const index: number[] = [];
  // Mown inside the fence, meadow outside, blending over a couple of meters either side of it.
  const tint = (x: number, z: number): void => {
    const t = lot ? smoothstep(-1.8, 1.2, fenceDepth(x, z, lot)) : 1;
    for (let k = 0; k < 3; k++) cols.push(MEADOW_TINT[k] + (LAWN_TINT[k] - MEADOW_TINT[k]) * t);
    cols.push(1);
  };
  pos.push(input.x, height(input.x, input.z), input.z);
  uvs.push(input.x / DRIFT_SPAN, input.z / DRIFT_SPAN);
  tint(input.x, input.z);
  for (let r = 1; r <= rings; r++) {
    const rad = reach * Math.pow(r / rings, 2.1);
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const x = input.x + Math.cos(a) * rad;
      const z = input.z + Math.sin(a) * rad;
      pos.push(x, height(x, z), z);
      uvs.push(x / DRIFT_SPAN, z / DRIFT_SPAN);
      tint(x, z);
    }
  }
  const at = (r: number, k: number): number => (r === 0 ? 0 : 1 + (r - 1) * segs + (k % segs));
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < segs; k++) {
      if (r === 0) index.push(0, at(1, k + 1), at(1, k));
      else index.push(at(r, k), at(r, k + 1), at(r + 1, k + 1), at(r, k), at(r + 1, k + 1), at(r + 1, k));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    map: groundTexture(),
    vertexColors: true,
    // Pushed back in depth so the path and floors always draw over it.
    polygonOffset: true,
    polygonOffsetFactor: 4,
    polygonOffsetUnits: 4,
  });
  material.color.copy(linear(input.color)).multiplyScalar(1 / MAP_UNITY);
  material.name = 'lawn';
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = -0.002;
  mesh.receiveShadow = true;
  mesh.name = 'lawn';
  return mesh;
}

/** Where a lattice of tufts covers, and how far apart. */
interface Field {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  spacing: number;
}

function fieldOf(input: LawnInput, zones: Zones): Field & { outer: number; inner: number } {
  const { x: cx, z: cz, radius } = input;
  // Without a lot: blades out to here, shrinking away into the ground past the inner ring.
  const outer = Math.min(radius + 18, Math.max(radius * 2.8, radius + 8));
  const inner = outer * 0.45;
  let x0 = cx - outer;
  let x1 = cx + outer;
  let z0 = cz - outer;
  let z1 = cz + outer;
  let area = Math.PI * outer * outer;
  const { lot } = zones;
  if (lot) {
    x0 = lot.x0 - MEADOW_REACH;
    x1 = lot.x1 + MEADOW_REACH;
    z0 = lot.y0 - MEADOW_REACH;
    z1 = lot.y1 + MEADOW_REACH;
    const lotArea = (lot.x1 - lot.x0) * (lot.y1 - lot.y0);
    // The meadow is sparser than the lawn: count it at the share of tufts it keeps.
    area = lotArea + ((x1 - x0) * (z1 - z0) - lotArea) * 0.6;
  }
  const spacing = Math.max(TUFT_SPACING, Math.sqrt(area / MAX_TUFTS));
  // A lattice fixed to the ground, not to the house: moving a wall never reshuffles the lawn.
  return {
    i0: Math.floor(x0 / spacing),
    i1: Math.ceil(x1 / spacing),
    j0: Math.floor(z0 / spacing),
    j1: Math.ceil(z1 / spacing),
    spacing,
    outer,
    inner,
  };
}

function buildBlades(input: LawnInput, zones: Zones): THREE.InstancedMesh | null {
  const { x: cx, z: cz, margin, gap } = input;
  const field = fieldOf(input, zones);
  const { spacing, outer, inner } = field;
  const { lot, lane } = zones;
  const areas = prepare([...input.keepOut, ...zones.extra], margin);
  const base = linear(input.color);

  const matrices: number[] = [];
  const tints: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3();
  const scale = new THREE.Vector3();

  for (let j = field.j0; j <= field.j1; j++) {
    for (let i = field.i0; i <= field.i1; i++) {
      const px = (i + hash2(i, j, 11)) * spacing;
      const pz = (j + hash2(i, j, 12)) * spacing;
      const r14 = hash2(i, j, 14);
      const [tone, dry] = drift(px, pz);
      let height: number;
      let width = spacing * (0.62 + 0.3 * hash2(i, j, 15));
      let tint = LAWN_TINT;
      let meadow = 0;
      if (lot) {
        const depth = fenceDepth(px, pz, lot);
        if (depth > FENCE_BAND) {
          // Mown: short and close.
          height = 0.075 + 0.055 * r14 + 0.02 * tone;
        } else if (depth > 0) {
          // The strip along the fence the mower misses.
          height = 0.17 + 0.15 * r14 + 0.03 * tone;
          meadow = 0.5;
        } else {
          // Meadow: taller, sparser, thinning out to nothing at the edge of the field.
          const out = -depth;
          const fade = out < MEADOW_REACH - 4 ? 1 : Math.max(0, 1 - (out - (MEADOW_REACH - 4)) / 4);
          if (hash2(i, j, 13) > 0.6 * fade) continue;
          height = (0.2 + 0.2 * r14 + 0.05 * tone) * (0.45 + 0.55 * fade);
          // Narrower too: meadow grass is a stand of stems, not a carpet.
          width *= 0.6;
          meadow = 1;
          if (lane) {
            // Nothing grows in the wheel ruts; the crown between them is cropped short.
            const d = distToSegment(px, pz, lane.a, lane.b);
            const rut = Math.abs(d - 0.72);
            if (rut < 0.3) continue;
            if (rut < 0.55 || d < 0.45) height *= 0.4;
          }
        }
      } else {
        const far = Math.hypot(px - cx, pz - cz);
        if (far > outer) continue;
        // Fewer and shorter toward the rim, so the edge of the blades never shows as a line.
        const fade = far <= inner ? 1 : 1 - (far - inner) / (outer - inner);
        if (fade < 1 && hash2(i, j, 13) > fade * 1.1) continue;
        height = (0.11 + 0.1 * r14 + 0.03 * tone) * (0.35 + 0.65 * fade);
      }
      const clear = clearance(px, pz, areas, margin);
      if (clear <= gap) continue;
      const near = Math.min(1, (clear - gap) / Math.max(0.01, margin - gap));
      height *= 0.45 + 0.55 * near;

      at.set(px, input.height ? input.height(px, pz) : 0, pz);
      q.setFromAxisAngle(up, hash2(i, j, 16) * Math.PI * 2);
      scale.set(width, height, width);
      m.compose(at, q, scale);
      for (let k = 0; k < 16; k++) matrices.push(m.elements[k]);

      if (meadow > 0) {
        // Drier still where the ground is dry: straw among the green.
        const k = meadow * (0.75 + 0.25 * dry);
        tint = [
          LAWN_TINT[0] + (MEADOW_TINT[0] - LAWN_TINT[0]) * k,
          LAWN_TINT[1] + (MEADOW_TINT[1] - LAWN_TINT[1]) * k,
          LAWN_TINT[2] + (MEADOW_TINT[2] - LAWN_TINT[2]) * k * (hash2(i, j, 18) > 0.85 ? 1.6 : 1),
        ];
      }
      const [tr, tg, tb] = driftTint(px, pz);
      const own = 0.9 + 0.2 * hash2(i, j, 17);
      tints.push(base.r * tr * own * tint[0], base.g * tg * own * tint[1], base.b * tb * own * tint[2]);
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
  const span = Math.hypot(field.i1 - field.i0, field.j1 - field.j0) * spacing * 0.5;
  mesh.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(((field.i0 + field.i1) / 2) * spacing, 0, ((field.j0 + field.j1) / 2) * spacing),
    span + 2,
  );
  mesh.name = 'grass';
  return mesh;
}

const FLOWER_COLORS: [string, number][] = [
  ['#f1ede2', 0.42],
  ['#eec64c', 0.3],
  ['#a487c9', 0.17],
  ['#e5a7b6', 0.11],
];

/** Flowers out in the meadow, a few to the square meter, gathered in loose drifts. */
function buildFlowers(input: LawnInput, zones: Zones): THREE.InstancedMesh | null {
  const { lot, lane } = zones;
  if (!lot) return null;
  const spacing = 0.42;
  const areas = prepare([...input.keepOut, ...zones.extra], input.margin);
  const palette = FLOWER_COLORS.map(([hex, share]) => [linear(hex), share] as const);
  const matrices: number[] = [];
  const tints: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3();
  const at = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const i0 = Math.floor((lot.x0 - MEADOW_REACH) / spacing);
  const i1 = Math.ceil((lot.x1 + MEADOW_REACH) / spacing);
  const j0 = Math.floor((lot.y0 - MEADOW_REACH) / spacing);
  const j1 = Math.ceil((lot.y1 + MEADOW_REACH) / spacing);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = (i + hash2(i, j, 31)) * spacing;
      const pz = (j + hash2(i, j, 32)) * spacing;
      const out = -fenceDepth(px, pz, lot);
      if (out < 0.3) continue;
      const fade = out < MEADOW_REACH - 4 ? 1 : Math.max(0, 1 - (out - (MEADOW_REACH - 4)) / 4);
      // Drifts: thick in places, none at all in others.
      const drifts = driftNoise(px / 2.2, pz / 2.2, 1 << 12, 33);
      const chance = (0.08 + Math.max(0, drifts - 0.45) * 1.5) * fade;
      if (hash2(i, j, 34) > chance) continue;
      if (lane) {
        const d = distToSegment(px, pz, lane.a, lane.b);
        if (d < 1.1) continue;
      }
      if (clearance(px, pz, areas, input.margin) < input.margin) continue;
      const size = 0.045 + 0.03 * hash2(i, j, 35);
      const y = (input.height ? input.height(px, pz) : 0) + (0.26 + 0.18 * hash2(i, j, 36)) * (0.5 + 0.5 * fade);
      at.set(px, y, pz);
      q.setFromAxisAngle(up, hash2(i, j, 37) * Math.PI * 2);
      const ta = hash2(i, j, 38) * Math.PI * 2;
      axis.set(Math.cos(ta), 0, Math.sin(ta));
      tilt.setFromAxisAngle(axis, 0.45 * hash2(i, j, 39));
      q.premultiply(tilt);
      scale.set(size, size, size);
      m.compose(at, q, scale);
      for (let k = 0; k < 16; k++) matrices.push(m.elements[k]);
      // One colour per drift, mostly: a patch of buttercups, a patch of clover.
      let pick = (hash2(Math.floor(px / 3), Math.floor(pz / 3), 40) * 0.7 + hash2(i, j, 41) * 0.3) % 1;
      let color = palette[0][0];
      for (const [c, share] of palette) {
        if (pick < share) {
          color = c;
          break;
        }
        pick -= share;
      }
      const own = 0.82 + 0.15 * hash2(i, j, 42);
      tints.push(color.r * own, color.g * own, color.b * own);
    }
  }
  const count = matrices.length / 16;
  if (count === 0) return null;
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, vertexColors: true });
  material.name = 'flowers';
  const mesh = new THREE.InstancedMesh(flowerGeometry(), material, count);
  mesh.instanceMatrix.copyArray(matrices);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(tints), 3);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.y0 + lot.y1) / 2;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 0, cz), Math.hypot(lot.x1 - lot.x0, lot.y1 - lot.y0) / 2 + MEADOW_REACH * 1.5 + 2);
  mesh.name = 'flowers';
  return mesh;
}

/** The lawn's green for a look: one green, nudged toward the look's own ground. */
export function lawnColor(styleGround: string): string {
  return mixHex('#7f9a58', styleGround, 0.2);
}

/** Ground to the horizon, and blades around the house. */
export function buildLawn(input: LawnInput): THREE.Group {
  const group = new THREE.Group();
  group.name = 'garden';
  // Out past where the haze closes in, however far the camera pulls back.
  group.add(buildGround(input, Math.max(input.radius * 34, 420)));
  const zones = zonesOf(input);
  const blades = buildBlades(input, zones);
  if (blades) group.add(blades);
  const flowers = buildFlowers(input, zones);
  if (flowers) group.add(flowers);
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
