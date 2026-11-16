/**
 * The country round the lot, so the house sits somewhere instead of on a
 * green plate in a fog: a broken hedgerow along the side and back fences,
 * a few clumps of trees out in the fields, and far off a ring of low hills
 * topped with tree-lines that fade into the haze.
 *
 * Built like the planting (plants.ts): foliage is a dark core with small
 * leaves over it, each lit as part of one soft ball. Everything near is one
 * merged mesh; the hills are a second one whose haze is capped by height, so
 * the crests still show through a fog that has swallowed the ground below
 * them. Scene dressing only — never in the plan or in exported models.
 */
import * as THREE from 'three';
import type { Point } from '../types';
import { hash } from './pieces';
import type { RGB, V3 } from './pieces';
import type { SitePlan } from './site';

// ---------- triangles with their own normals and colours ----------

const unit3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
};
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface Corner {
  p: V3;
  n: V3;
  c: RGB;
  h?: number;
}

/** Loose triangles with a normal and an RGBA colour per corner (and, optionally, a haze cap). */
export class Mesher {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly haze: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  vertex(p: V3, n: V3, c: RGB, haze = 1): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2], 1);
    this.haze.push(haze);
  }

  /** A flat triangle, a colour per corner, wound to face along `toward`. */
  tri(a: V3, b: V3, c: V3, ca: RGB, cb: RGB, cc: RGB, toward: V3, haze: [number, number, number] = [1, 1, 1]): void {
    const raw = cross3(sub3(b, a), sub3(c, a));
    if (dot3(raw, raw) < 1e-18) return;
    const flip = dot3(raw, toward) < 0;
    const n = unit3(flip ? [-raw[0], -raw[1], -raw[2]] : raw);
    this.vertex(a, n, ca, haze[0]);
    if (flip) {
      this.vertex(c, n, cc, haze[2]);
      this.vertex(b, n, cb, haze[1]);
    } else {
      this.vertex(b, n, cb, haze[1]);
      this.vertex(c, n, cc, haze[2]);
    }
  }

  /** A smooth-lit triangle (a normal per corner), wound to face along `toward`. */
  smooth(v: [Corner, Corner, Corner], toward: V3): void {
    const raw = cross3(sub3(v[1].p, v[0].p), sub3(v[2].p, v[0].p));
    if (dot3(raw, raw) < 1e-18) return;
    const order = dot3(raw, toward) < 0 ? [v[0], v[2], v[1]] : v;
    for (const k of order) this.vertex(k.p, k.n, k.c, k.h ?? 1);
  }

  /** A flat convex polygon in one colour, wound to face along `toward`. */
  poly(pts: V3[], color: RGB, toward: V3): void {
    if (pts.length < 3) return;
    // Newell's normal: steady even when the first corners are nearly in line.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    if (nx * nx + ny * ny + nz * nz < 1e-16) return;
    const flip = nx * toward[0] + ny * toward[1] + nz * toward[2] < 0;
    const n = unit3(flip ? [-nx, -ny, -nz] : [nx, ny, nz]);
    for (let i = 1; i < pts.length - 1; i++) {
      this.vertex(pts[0], n, color);
      this.vertex(flip ? pts[i + 1] : pts[i], n, color);
      this.vertex(flip ? pts[i] : pts[i + 1], n, color);
    }
  }

  geometry(withHaze = false): THREE.BufferGeometry | null {
    if (this.empty || !this.pos.every((v) => Number.isFinite(v))) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    // Four components: the path tracer merges colours as RGBA and mangles three-component ones.
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    if (withHaze) geo.setAttribute('haze', new THREE.Float32BufferAttribute(this.haze, 1));
    return geo;
  }
}

// ---------- foliage ----------

const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const scale3 = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

const PALETTE = {
  hedge: ['#4b6a35', '#56763a', '#445f36', '#5f7c3e', '#506d33'],
  tree: ['#56743a', '#647f40', '#4b6837', '#6f8644', '#7d8c46'],
  conifer: ['#4a6840', '#425f3d', '#53703f'],
  trunk: '#5f4a39',
};

/** The 80 corners-in-threes of a once-split icosahedron on the unit sphere, wound outward. */
let icoCache: V3[] | null = null;
function icoTris(): V3[] {
  if (icoCache) return icoCache;
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position');
  const out: V3[] = [];
  for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
  g.dispose();
  icoCache = out;
  return out;
}

interface Lobe {
  c: V3;
  r: number;
  ry: number;
}

/** Lit as part of a soft ball: out from the middle, leaning up toward the sky. */
const ballNormal = (u: V3): V3 => unit3([u[0], u[1] * 0.8 + 0.35, u[2]]);

/** The dark inside of a clump: a lumpy ball, so gaps between leaves show shade, not sky. */
function core(m: Mesher, k: Lobe, seed: number, green: RGB, baseY: number, topY: number): void {
  const tris = icoTris();
  for (let t = 0; t < tris.length; t += 3) {
    const corner = (u: V3): [V3, V3, RGB] => {
      // The same corner of the sphere is pushed the same way in every triangle it belongs to.
      const key = Math.round(u[0] * 50) * 10007 + Math.round(u[1] * 50) * 101 + Math.round(u[2] * 50);
      const bump = 0.86 + 0.2 * hash(key, seed, 7);
      const p: V3 = [k.c[0] + u[0] * k.r * bump, k.c[1] + u[1] * k.ry * bump, k.c[2] + u[2] * k.r * bump];
      const h = Math.max(0, Math.min(1, (p[1] - baseY) / Math.max(0.01, topY - baseY)));
      return [p, ballNormal(u), scale3(green, 0.3 + 0.3 * h)];
    };
    for (const u of [tris[t], tris[t + 1], tris[t + 2]]) {
      const [p, n, c] = corner(u);
      m.vertex(p, n, c);
    }
  }
}

/** Leaves over a set of lobes; `seed` makes the same plant every time. */
function leaves(m: Mesher, lobes: Lobe[], count: number, size: number, seed: number, palette: string[], baseY: number, topY: number): void {
  const greens = palette.map(lin);
  for (let i = 0; i < count; i++) {
    const k = lobes[Math.floor(hash(seed, i, 1) * lobes.length) % lobes.length];
    // A point near the lobe's skin, more of them on top where the light is.
    const u = Math.min(1, hash(seed, i, 2) * 2.2 - 1);
    const a = hash(seed, i, 3) * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const out: V3 = [s * Math.cos(a), u, s * Math.sin(a)];
    const depth = 0.82 + 0.3 * Math.sqrt(hash(seed, i, 4));
    const p: V3 = [k.c[0] + out[0] * k.r * depth, k.c[1] + out[1] * k.ry * depth, k.c[2] + out[2] * k.r * depth];
    const n = ballNormal(out);
    const h = Math.max(0, Math.min(1, (p[1] - baseY) / Math.max(0.01, topY - baseY)));
    const light = (0.55 + 0.55 * h) * (0.4 + 0.7 * Math.pow(Math.max(0, (depth - 0.82) / 0.3), 1.5));
    const c = scale3(greens[Math.floor(hash(seed, i, 9) * greens.length) % greens.length], light);
    card(m, p, n, size * (0.75 + 0.5 * hash(seed, i, 8)), [hash(seed, i, 5) - 0.5, hash(seed, i, 6) - 0.5, hash(seed, i, 7) - 0.5], c);
  }
}

/** One leaf at `p`, lying across its normal `n`, turned toward `spin`: an almond, pointed at both ends. */
function card(m: Mesher, p: V3, n: V3, sz: number, spin: V3, c: RGB): void {
  const r1 = unit3(cross3(n, spin));
  const r2 = unit3(cross3(n, r1));
  const at = (along: number, across: number): V3 => [
    p[0] + r1[0] * sz * along + r2[0] * sz * across,
    p[1] + r1[1] * sz * along + r2[1] * sz * across,
    p[2] + r1[2] * sz * along + r2[2] * sz * across,
  ];
  const q = [at(-0.55, 0), at(-0.15, 0.3), at(0.25, 0.26), at(0.55, 0), at(0.25, -0.26), at(-0.15, -0.3)];
  // Both windings, each lit the same way: seen from either side a leaf belongs to the same soft ball.
  for (let f = 1; f < 5; f++) {
    for (const v of [q[0], q[f], q[f + 1], q[0], q[f + 1], q[f]]) m.vertex(v, n, c);
  }
}

/** An upright tapered prism, open at both ends (a trunk). */
function trunk(m: Mesher, x: number, z: number, y0: number, y1: number, r0: number, r1: number, lean: [number, number], color: RGB): void {
  const sides = 6;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const at = (a: number, r: number, y: number, t: number): V3 => [x + Math.cos(a) * r + lean[0] * t, y, z + Math.sin(a) * r + lean[1] * t];
    const am = (a0 + a1) / 2;
    const out: V3 = [Math.cos(am), 0, Math.sin(am)];
    const c = scale3(color, 0.8 + 0.25 * Math.max(0, Math.cos(am - 0.8)));
    m.poly([at(a0, r0, y0, 0), at(a1, r0, y0, 0), at(a1, r1, y1, 1), at(a0, r1, y1, 1)], c, out);
  }
}

/** A rounded tree for the middle distance: fewer, larger leaves than a garden tree. */
function broadleaf(m: Mesher, x: number, y: number, z: number, seed: number, height: number): void {
  const lean: [number, number] = [(hash(seed, 0, 12) - 0.5) * 0.8, (hash(seed, 0, 13) - 0.5) * 0.8];
  const bole = height * (0.38 + 0.1 * hash(seed, 0, 14));
  trunk(m, x, z, y - 0.3, y + bole + height * 0.15, 0.06 * height, 0.035 * height, lean, lin(PALETTE.trunk));
  const R = height * (0.3 + 0.07 * hash(seed, 0, 15));
  const top: V3 = [x + lean[0], y + bole, z + lean[1]];
  const lobes: Lobe[] = [{ c: [top[0], top[1] + R * 0.95, top[2]], r: R, ry: R * 0.88 }];
  const n = 3 + Math.floor(hash(seed, 0, 16) * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + hash(seed, i, 17) * 1.2;
    const d = R * (0.5 + 0.25 * hash(seed, i, 18));
    lobes.push({
      c: [top[0] + Math.cos(a) * d, top[1] + R * (0.55 + 0.75 * hash(seed, i, 19)), top[2] + Math.sin(a) * d],
      r: R * (0.55 + 0.15 * hash(seed, i, 20)),
      ry: R * 0.5,
    });
  }
  const greens = PALETTE.tree.map(lin);
  const green = greens[Math.floor(hash(seed, 0, 21) * greens.length) % greens.length];
  const baseY = top[1];
  const topY = top[1] + R * 2;
  for (const [i, k] of lobes.entries()) core(m, k, seed * 31 + i, green, baseY, topY);
  // One leaf colour per tree, with a neighbour or two for variety: each tree reads as its own.
  const own = [PALETTE.tree[Math.floor(hash(seed, 0, 21) * PALETTE.tree.length) % PALETTE.tree.length], PALETTE.tree[Math.floor(hash(seed, 0, 22) * PALETTE.tree.length) % PALETTE.tree.length]];
  leaves(m, lobes, Math.round(70 + 40 * hash(seed, 0, 23)), Math.max(0.35, R * 0.16), seed, own, baseY, topY);
}

/** A dark pointed fir: stacked tiers, each a shallow cone. */
function conifer(m: Mesher, x: number, y: number, z: number, seed: number, height: number): void {
  trunk(m, x, z, y - 0.3, y + height * 0.3, 0.045 * height, 0.03 * height, [0, 0], lin(PALETTE.trunk));
  const greens = PALETTE.conifer.map(lin);
  const green = greens[Math.floor(hash(seed, 0, 31) * greens.length) % greens.length];
  const tiers = 4;
  const sides = 8;
  const turn = hash(seed, 0, 32) * Math.PI;
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers;
    const y0 = y + height * (0.16 + 0.2 * f);
    const y1 = y0 + height * (0.42 - 0.06 * t);
    const r = height * (0.24 - 0.045 * t);
    const tip: V3 = [x, Math.min(y1, y + height), z];
    for (let i = 0; i < sides; i++) {
      const a0 = turn + (i / sides) * Math.PI * 2;
      const a1 = turn + ((i + 1) / sides) * Math.PI * 2;
      const k0 = r * (0.85 + 0.3 * hash(seed, t * 16 + i, 33));
      const k1 = r * (0.85 + 0.3 * hash(seed, t * 16 + ((i + 1) % sides), 33));
      const p0: V3 = [x + Math.cos(a0) * k0, y0, z + Math.sin(a0) * k0];
      const p1: V3 = [x + Math.cos(a1) * k1, y0, z + Math.sin(a1) * k1];
      const n0 = unit3([Math.cos(a0), 0.7, Math.sin(a0)]);
      const n1 = unit3([Math.cos(a1), 0.7, Math.sin(a1)]);
      const light = 0.62 + 0.4 * f;
      const out: V3 = [Math.cos((a0 + a1) / 2), 0.4, Math.sin((a0 + a1) / 2)];
      m.smooth([
        { p: p0, n: n0, c: scale3(green, light * 0.75) },
        { p: tip, n: [0, 1, 0], c: scale3(green, light * 1.15) },
        { p: p1, n: n1, c: scale3(green, light * 0.75) },
      ], out);
      // And the underside, in shade.
      const under: V3 = [x, y0 + (tip[1] - y0) * 0.25, z];
      m.smooth([
        { p: p0, n: [0, -1, 0], c: scale3(green, 0.25) },
        { p: p1, n: [0, -1, 0], c: scale3(green, 0.25) },
        { p: under, n: [0, -1, 0], c: scale3(green, 0.2) },
      ], [0, -1, 0]);
    }
    // Sprays of needles over the tier, so its edge is ragged, not a clean cone.
    const sprays = 26 - t * 4;
    for (let k = 0; k < sprays; k++) {
      const a = turn + hash(seed, t * 64 + k, 34) * Math.PI * 2;
      const up = Math.pow(hash(seed, t * 64 + k, 35), 1.4) * 0.8;
      const rr = r * (1 - up) * (0.95 + 0.2 * hash(seed, t * 64 + k, 36));
      const p: V3 = [x + Math.cos(a) * rr, y0 + (tip[1] - y0) * up - 0.05 * r, z + Math.sin(a) * rr];
      const n = unit3([Math.cos(a), 0.7, Math.sin(a)]);
      const light = (0.62 + 0.4 * f) * (0.85 + 0.35 * up);
      const c = scale3(greens[Math.floor(hash(seed, t * 64 + k, 37) * greens.length) % greens.length], light);
      card(m, p, n, r * (0.45 + 0.25 * hash(seed, t * 64 + k, 38)), [Math.cos(a + 1.3), 0.2, Math.sin(a + 1.3)], c);
    }
  }
}

/** A run of hedge between two points on the ground, its outward side toward (nx, ny). */
function hedge(m: Mesher, a: Point, b: Point, seed: number, height: (x: number, z: number) => number): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 0.8) return;
  const tx = (b.x - a.x) / len;
  const ty = (b.y - a.y) / len;
  const step = 0.6;
  const count = Math.max(1, Math.round(len / step));
  const lobes: Lobe[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  // The hedge's top rises and dips slowly along its length, never in step with the lobes.
  const crown = (s: number): number => {
    const u = s / 2.6 + seed * 0.37;
    const i = Math.floor(u);
    const f = u - i;
    const k = f * f * (3 - 2 * f);
    return hash(i, seed, 46) + (hash(i + 1, seed, 46) - hash(i, seed, 46)) * k;
  };
  for (let i = 0; i <= count; i++) {
    const s = (i / count) * len + (hash(seed, i, 40) - 0.5) * step * 0.6;
    // Ragged at the ends, as a hedge that was planted and then left to itself.
    const end = Math.min(s, len - s);
    const taper = Math.max(0.45, Math.min(1, 0.5 + end / 2));
    const jx = (hash(seed, i, 41) - 0.5) * 0.45;
    const x = a.x + tx * s + -ty * jx;
    const z = a.y + ty * s + tx * jx;
    const y = height(x, z);
    const r = (0.55 + 0.2 * hash(seed, i, 42)) * taper;
    lobes.push({ c: [x, y + r * (0.6 + 0.25 * hash(seed, i, 47)), z], r, ry: r * 0.8 });
    // Above the base, where it has grown up taller: an uneven second storey.
    const grow = crown(s) * taper;
    if (grow > 0.28 && hash(seed, i, 48) > 0.25) {
      const r2 = r * (0.65 + 0.3 * hash(seed, i, 44));
      const side = (hash(seed, i, 49) - 0.5) * 0.4;
      lobes.push({ c: [x - ty * side, y + r * 0.7 + r2 * (0.5 + 1.3 * grow), z + tx * side], r: r2, ry: r2 * 0.85 });
    }
  }
  for (const k of lobes) {
    lo = Math.min(lo, k.c[1] - k.ry);
    hi = Math.max(hi, k.c[1] + k.ry);
  }
  const greens = PALETTE.hedge.map(lin);
  const green = greens[Math.floor(hash(seed, 0, 45) * greens.length) % greens.length];
  for (const [i, k] of lobes.entries()) core(m, k, seed * 17 + i, green, lo, hi);
  leaves(m, lobes, Math.round(lobes.length * 24), 0.21, seed, PALETTE.hedge, lo, hi);
}

/** A loose low shrub on its own. */
function shrub(m: Mesher, x: number, z: number, seed: number, r: number, height: (x: number, z: number) => number): void {
  const y = height(x, z);
  const lobes: Lobe[] = [{ c: [x, y + r * 0.6, z], r, ry: r * 0.75 }];
  for (let i = 0; i < 2; i++) {
    const a = hash(seed, i, 51) * Math.PI * 2;
    lobes.push({ c: [x + Math.cos(a) * r * 0.5, y + r * 0.45, z + Math.sin(a) * r * 0.5], r: r * 0.7, ry: r * 0.55 });
  }
  const greens = PALETTE.hedge.map(lin);
  const green = greens[Math.floor(hash(seed, 0, 52) * greens.length) % greens.length];
  for (const [i, k] of lobes.entries()) core(m, k, seed * 13 + i, green, y, y + r * 1.4);
  leaves(m, lobes, Math.round(60 * r * r * 4), 0.17, seed, PALETTE.hedge, y, y + r * 1.4);
}

// ---------- where it goes ----------

interface Side {
  a: Point;
  b: Point;
  /** Outward unit normal. */
  nx: number;
  ny: number;
}

function sidesOf(lot: SitePlan['lot']): Side[] {
  const c = [
    { x: lot.x0, y: lot.y0 },
    { x: lot.x1, y: lot.y0 },
    { x: lot.x1, y: lot.y1 },
    { x: lot.x0, y: lot.y1 },
  ];
  return [
    { a: c[0], b: c[1], nx: 0, ny: -1 },
    { a: c[1], b: c[2], nx: 1, ny: 0 },
    { a: c[2], b: c[3], nx: 0, ny: 1 },
    { a: c[3], b: c[0], nx: -1, ny: 0 },
  ];
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Hedgerow along parts of the side and back fences, and the odd shrub where there is none. */
function layHedgerow(m: Mesher, site: SitePlan, height: (x: number, z: number) => number): void {
  const out = 0.95;
  for (const [si, side] of sidesOf(site.lot).entries()) {
    if (side.nx === site.front.nx && side.ny === site.front.ny) continue; // the street side stays open
    const len = Math.hypot(side.b.x - side.a.x, side.b.y - side.a.y);
    const tx = (side.b.x - side.a.x) / len;
    const ty = (side.b.y - side.a.y) / len;
    const at = (s: number, off: number): Point => ({ x: side.a.x + tx * s + side.nx * off, y: side.a.y + ty * s + side.ny * off });
    const back = side.nx === -site.front.nx && side.ny === -site.front.ny;
    // Broken runs: longer and closer together along the back.
    let s = -1.5 + hash(si, 0, 61) * 3;
    let k = 0;
    while (s < len + 1.5 && k < 40) {
      const run = (back ? 4.5 : 3) + hash(si, k, 62) * (back ? 7 : 5);
      const gap = (back ? 1.5 : 2.5) + hash(si, k, 63) * (back ? 3 : 5);
      const s1 = Math.min(len + 1.5, s + run);
      if (s1 - s > 1.2) hedge(m, at(s, out), at(s1, out + (hash(si, k, 64) - 0.5) * 0.4), 701 + si * 53 + k, height);
      // In the gap, now and then, a shrub on its own.
      const mid = s1 + gap / 2;
      if (gap > 2.4 && mid < len && hash(si, k, 65) > 0.45) {
        const p = at(mid, out + 0.2);
        shrub(m, p.x, p.y, 901 + si * 37 + k, 0.45 + 0.25 * hash(si, k, 66), height);
      }
      s = s1 + gap;
      k++;
    }
  }
}

/** A few clumps of trees out in the fields, gathered rather than gridded, clear of the lane and the front view. */
function layCopses(m: Mesher, site: SitePlan, height: (x: number, z: number) => number): void {
  const { lot, front, lane } = site;
  const cx = (lot.x0 + lot.x1) / 2;
  const cy = (lot.y0 + lot.y1) / 2;
  const halfDiag = Math.hypot(lot.x1 - lot.x0, lot.y1 - lot.y0) / 2;
  const near = Math.max(15, halfDiag + 6);
  const clumps = 5;
  // The way the camera first looks from: front-right, a little to the side.
  const views = [Math.atan2(front.ny, front.nx), Math.atan2(1.8, 1.4)];
  const trees: { x: number; y: number }[] = [];
  for (let k = 0; k < clumps; k++) {
    let angle = (k / clumps) * Math.PI * 2 + hash(k, 1, 71) * 0.9;
    const dist = near + hash(k, 2, 72) * Math.max(10, 60 - near) * (k % 2 ? 1 : 0.6);
    // Out of the way of the main views when close in: swing it round to the side.
    for (const v of views) {
      let d = Math.atan2(Math.sin(angle - v), Math.cos(angle - v));
      if (Math.abs(d) < 0.5 && dist < 45) {
        d = d >= 0 ? 0.5 : -0.5;
        angle = v + d;
      }
    }
    const ox = cx + Math.cos(angle) * dist;
    const oy = cy + Math.sin(angle) * dist;
    const count = 3 + Math.floor(hash(k, 3, 73) * 5);
    const spread = 3.5 + 4 * hash(k, 4, 74);
    const firs = hash(k, 5, 75) < 0.35;
    for (let i = 0, tries = 0; i < count && tries < count * 6; tries++) {
      const a = hash(k, tries, 76) * Math.PI * 2;
      const r = spread * Math.sqrt(hash(k, tries, 77));
      const p = { x: ox + Math.cos(a) * r, y: oy + Math.sin(a) * r };
      if (trees.some((t) => Math.hypot(t.x - p.x, t.y - p.y) < 3.2)) continue;
      if (p.x > lot.x0 - 4 && p.x < lot.x1 + 4 && p.y > lot.y0 - 4 && p.y < lot.y1 + 4) continue;
      if (lane && distToSegment(p, lane.a, lane.b) < lane.width / 2 + 2.5) continue;
      trees.push(p);
      i++;
      // The middle of a clump stands tallest.
      const tall = 1 - (r / spread) * 0.35;
      const seed = 1301 + k * 101 + i * 7;
      const y = height(p.x, p.y);
      if (firs && hash(seed, 0, 78) < 0.7) conifer(m, p.x, y, p.y, seed, (8 + 5 * hash(seed, 0, 79)) * tall);
      else broadleaf(m, p.x, y, p.y, seed, (6.5 + 5 * hash(seed, 0, 79)) * tall);
    }
  }
}

// ---------- the far hills ----------

/** Smooth noise round a circle: `t` 0…1 is once round, `cells` bumps on the way. */
function ringNoise(t: number, cells: number, seed: number): number {
  const u = t * cells;
  const i = Math.floor(u);
  const f = u - i;
  const s = f * f * (3 - 2 * f);
  const at = (j: number) => hash(((j % cells) + cells) % cells, cells, seed);
  return at(i) + (at(i + 1) - at(i)) * s;
}

interface Ring {
  radius: number;
  front: number;
  back: number;
  low: number;
  high: number;
  /** Most fog the crest takes (the foot takes it all). */
  crestHaze: number;
  foot: string;
  crest: string;
  trees: string;
  /** Share of the crest with a tree-line on it. */
  wood: number;
  seed: number;
}

function hillRing(m: Mesher, cx: number, cz: number, ring: Ring, height: (x: number, z: number) => number): void {
  const steps = 160;
  const foot = lin(ring.foot);
  const crest = lin(ring.crest);
  const trees = lin(ring.trees);
  type Row = { p: V3; c: RGB; h: number }[];
  const rows: Row[] = [[], [], [], []];
  const crestLine: { p: V3; out: [number, number] }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const r = ring.radius * (1 + 0.18 * (ringNoise(t, 9, ring.seed) - 0.5) * 2);
    const H = ring.low + (ring.high - ring.low) * Math.pow(0.6 * ringNoise(t, 7, ring.seed + 1) + 0.4 * ringNoise(t, 23, ring.seed + 2), 1.3);
    const ground = (d: number): V3 => {
      const x = cx + ca * d;
      const z = cz + sa * d;
      return [x, height(x, z), z];
    };
    const f = ground(r - ring.front);
    const mid = ground(r - ring.front * 0.45);
    const top = ground(r);
    const b = ground(r + ring.back);
    rows[0].push({ p: [f[0], f[1] - 1, f[2]], c: foot, h: 1 });
    rows[1].push({ p: [mid[0], mid[1] + H * 0.5, mid[2]], c: foot.map((v, k) => v * 0.5 + crest[k] * 0.5) as RGB, h: 0.5 + ring.crestHaze * 0.5 });
    rows[2].push({ p: [top[0], top[1] + H, top[2]], c: crest, h: ring.crestHaze });
    rows[3].push({ p: [b[0], b[1] + H * 0.35, b[2]], c: crest, h: ring.crestHaze });
    crestLine.push({ p: [top[0], top[1] + H, top[2]], out: [ca, sa] });
  }
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < steps; i++) {
      const p00 = rows[k][i];
      const p01 = rows[k][i + 1];
      const p10 = rows[k + 1][i];
      const p11 = rows[k + 1][i + 1];
      const a = ((i + 0.5) / steps) * Math.PI * 2;
      // The first two bands look in toward the house, the last away from it; all of them up.
      const toward: V3 = k < 2 ? [-Math.cos(a), 1.2, -Math.sin(a)] : [Math.cos(a), 1.2, Math.sin(a)];
      m.tri(p00.p, p01.p, p11.p, p00.c, p01.c, p11.c, toward, [p00.h, p01.h, p11.h]);
      m.tri(p00.p, p11.p, p10.p, p00.c, p11.c, p10.c, toward, [p00.h, p11.h, p10.h]);
    }
  }
  // Tree-lines along the crest: rounded crowns shoulder to shoulder, in stretches.
  const total = crestLine.length - 1;
  for (let i = 0; i < total * 3; i++) {
    const t = i / (total * 3);
    if (ringNoise(t, 13, ring.seed + 5) > ring.wood) continue;
    const j = Math.floor(t * total);
    const f = t * total - j;
    const A = crestLine[j];
    const B = crestLine[j + 1];
    const out = A.out;
    const back = (hash(i, ring.seed, 81) - 0.3) * ring.front * 0.12;
    const base: V3 = [A.p[0] + (B.p[0] - A.p[0]) * f + out[0] * back, A.p[1] + (B.p[1] - A.p[1]) * f - 1.5, A.p[2] + (B.p[2] - A.p[2]) * f + out[1] * back];
    const w = ring.radius * (0.022 + 0.018 * hash(i, ring.seed, 82));
    const tall = w * (1.3 + 0.9 * hash(i, ring.seed, 83));
    dome(m, base, w, tall, scale3(trees, 0.85 + 0.3 * hash(i, ring.seed, 84)), ring.crestHaze - 0.04, i + ring.seed * 1000);
  }
}

/** A low-poly rounded crown, smooth-lit, for trees too far off to have leaves. */
function dome(m: Mesher, base: V3, w: number, tall: number, color: RGB, haze: number, seed: number): void {
  const sides = 7;
  const turn = hash(seed, 0, 91) * Math.PI;
  const ring = (k: number, y: number, r: number): { p: V3; n: V3 }[] =>
    Array.from({ length: sides }, (_, i) => {
      const a = turn + (i / sides) * Math.PI * 2;
      return { p: [base[0] + Math.cos(a) * r, base[1] + y, base[2] + Math.sin(a) * r] as V3, n: unit3([Math.cos(a), k, Math.sin(a)]) };
    });
  const r0 = ring(0.1, 0, w);
  const r1 = ring(0.9, tall * 0.62, w * 0.82);
  const apex: V3 = [base[0], base[1] + tall, base[2]];
  const lo = scale3(color, 0.62);
  const hi = scale3(color, 1.08);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const a = turn + ((i + 0.5) / sides) * Math.PI * 2;
    const out: V3 = [Math.cos(a), 0.3, Math.sin(a)];
    const at = (v: { p: V3; n: V3 }, c: RGB): Corner => ({ p: v.p, n: v.n, c, h: haze });
    m.smooth([at(r0[i], lo), at(r0[j], lo), at(r1[j], color)], out);
    m.smooth([at(r0[i], lo), at(r1[j], color), at(r1[i], color)], out);
    m.smooth([at(r1[i], color), at(r1[j], color), { p: apex, n: [0, 1, 0], c: hi, h: haze }], [out[0], 1, out[2]]);
  }
}

/** Lit like the land, but the haze over each corner is capped by its `haze` attribute. */
function hillsMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.name = 'hills';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float haze;\nvarying float vHaze;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvHaze = haze;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHaze;')
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, min( fogFactor, vHaze ) );
#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'gaudi-hills';
  return mat;
}

// ---------- all of it ----------

/**
 * Hedgerow, copses and far hills round a lot. Returns the near things as one
 * mesh (shadow-casting, its material named like the planting so the path
 * tracer treats the leaves alike) and the hills as another.
 */
export function buildSurroundings(site: SitePlan, height: (x: number, z: number) => number): THREE.Group | null {
  const group = new THREE.Group();
  group.name = 'surroundings';

  const near = new Mesher();
  layHedgerow(near, site, height);
  layCopses(near, site, height);
  const nearGeo = near.geometry();
  if (nearGeo) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    material.name = 'planting';
    const mesh = new THREE.Mesh(nearGeo, material);
    mesh.name = 'hedgerow';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const { lot } = site;
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.y0 + lot.y1) / 2;
  const span = Math.max(lot.x1 - lot.x0, lot.y1 - lot.y0);
  const S = Math.max(1, Math.min(3, span / 30));
  const far = new Mesher();
  hillRing(far, cx, cz, { radius: 140 * S, front: 45 * S, back: 40 * S, low: 4 * S, high: 15 * S, crestHaze: 0.62, foot: '#6d8150', crest: '#5d7445', trees: '#3f5637', wood: 0.5, seed: 11 }, height);
  hillRing(far, cx, cz, { radius: 240 * S, front: 60 * S, back: 50 * S, low: 14 * S, high: 40 * S, crestHaze: 0.8, foot: '#7a8b68', crest: '#68795f', trees: '#52654c', wood: 0.38, seed: 23 }, height);
  const farGeo = far.geometry(true);
  if (farGeo) {
    const mesh = new THREE.Mesh(farGeo, hillsMaterial());
    mesh.name = 'hills';
    mesh.raycast = () => {};
    group.add(mesh);
  }
  return group.children.length ? group : null;
}
