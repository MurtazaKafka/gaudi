/**
 * The ground a styled house sits in, laid like a real site: a strip of gravel
 * along the foundation, a stone doorstep, a path of slabs laid by hand with
 * grass in the joints, out through a gate in a low picket fence to a country
 * lane; a weathered post-and-rail fence round the rest of the lot, a hedgerow
 * behind it, and beyond, the land rolling away to wooded hills.
 *
 * Scene dressing only — never in the plan or in exported models. The
 * maquette keeps its plain card base.
 */
import * as THREE from 'three';
import type { Point } from '../types';
import type { Rect } from './footprint';
import { offsetLoop } from './footprint';
import { hash, lightOf, shade } from './pieces';
import type { RGB, V3 } from './pieces';
import { isCampus, STEP_HEIGHT, STEP_HEIGHT_FLUSH } from './site';
import type { SitePlan } from './site';
import { buildSurroundings, Mesher } from './surroundings';

const GRAVEL = 0.42;

// ---------- the land beyond the lot ----------

function smooth(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const h = (i: number, j: number) => hash(i, j, seed);
  const a = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * fx;
  const b = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * fx;
  return a + (b - a) * fy;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/**
 * Ground height at a point, with the site it was made for riding along: the
 * lawn reads the lot, the lane and the walk from it (see garden.ts).
 */
export type Terrain = ((x: number, z: number) => number) & { site?: SitePlan };

/**
 * Level across the lot and a few meters past the fence, then rising into
 * low rolling hills — 6 to 12 m some forty meters out, so the house sits in a
 * shallow valley. A lane along the front keeps its own level way through.
 */
export function terrainFor(lot: Rect, lane: SitePlan['lane'] = null): (x: number, z: number) => number {
  const pad = 5;
  return (x, z) => {
    const dx = Math.max(lot.x0 - pad - x, 0, x - lot.x1 - pad);
    const dz = Math.max(lot.y0 - pad - z, 0, z - lot.y1 - pad);
    const away = Math.hypot(dx, dz);
    if (away <= 0) return 0;
    const broad = valueNoise(x / 70, z / 70, 3);
    const fine = valueNoise(x / 23, z / 23, 4);
    let h = smooth(away / 30) * (1.2 + 10.8 * broad * broad + (fine - 0.5) * 3);
    if (lane) h *= smooth((distToSegment({ x, y: z }, lane.a, lane.b) - lane.width / 2 - 1) / 12);
    return h;
  };
}

// ---------- small shapes ----------

/** A small flat stone: a low four-sided pyramid. */
function pebble(m: Mesher, x: number, z: number, r: number, turn: number, color: RGB, y = 0.004): void {
  const top: V3 = [x, y + r * 0.45, z];
  const pts: V3[] = [0, 1, 2, 3].map((i) => {
    const a = turn + (i * Math.PI) / 2;
    const rr = r * (i % 2 ? 0.75 : 1);
    return [x + Math.cos(a) * rr, y, z + Math.sin(a) * rr];
  });
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const mid: V3 = [(a[0] + b[0]) / 2 - x, 0.6, (a[2] + b[2]) / 2 - z];
    m.poly([a, b, top], shade(color, 0.85 + 0.25 * ((i + 1) % 2)), mid);
  }
}

/**
 * A four-cornered block standing on the ground (y0…y1), its top edges
 * bevelled by `chamfer`: a slab, a step, a cap.
 */
function block(m: Mesher, corners: Point[], y0: number, y1: number, chamfer: number, color: RGB): void {
  const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
  const cz = corners.reduce((s, p) => s + p.y, 0) / corners.length;
  const k = Math.max(0, Math.min(chamfer, (y1 - y0) * 0.6));
  const inset = (p: Point): Point => {
    const d = Math.hypot(p.x - cx, p.y - cz) || 1;
    // Corners pulled in along the diagonal by √2·k: each edge comes in by k.
    return { x: p.x - ((p.x - cx) / d) * k * 1.41, y: p.y - ((p.y - cz) / d) * k * 1.41 };
  };
  const top = corners.map((p): V3 => {
    const q = inset(p);
    return [q.x, y1, q.y];
  });
  const shoulder = corners.map((p): V3 => [p.x, y1 - k, p.y]);
  const foot = corners.map((p): V3 => [p.x, y0, p.y]);
  m.poly(top, color, [0, 1, 0]);
  for (let i = 0; i < corners.length; i++) {
    const j = (i + 1) % corners.length;
    const out: V3 = [(corners[i].x + corners[j].x) / 2 - cx, 0, (corners[i].y + corners[j].y) / 2 - cz];
    m.poly([foot[i], foot[j], shoulder[j], shoulder[i]], shade(color, 0.72), out);
    if (k > 0) m.poly([shoulder[i], shoulder[j], top[j], top[i]], shade(color, 0.9), [out[0], 0.8, out[2]]);
  }
}

/** A few blades of grass, standing where a mower never reaches. */
function tuft(m: Mesher, x: number, y: number, z: number, h: number, seed: number, green: RGB): void {
  for (let b = 0; b < 3; b++) {
    const a = hash(seed, b, 1) * Math.PI * 2;
    const lean = 0.3 + 0.3 * hash(seed, b, 2);
    const w = 0.012;
    const across: [number, number] = [-Math.sin(a) * w, Math.cos(a) * w];
    const tip: V3 = [x + Math.cos(a) * h * lean, y + h * (0.8 + 0.3 * hash(seed, b, 3)), z + Math.sin(a) * h * lean];
    const c = shade(green, 0.8 + 0.35 * hash(seed, b, 4));
    const pts: V3[] = [[x - across[0], y, z - across[1]], [x + across[0], y, z + across[1]], tip];
    // Both faces, each lit from above, like the lawn's own blades.
    for (const flip of [false, true]) {
      const [p, q, r] = flip ? [pts[1], pts[0], pts[2]] : pts;
      for (const v of [p, q, r]) m.vertex(v, [0, 1, 0], v === r ? c : shade(c, 0.7));
    }
  }
}

function inside(p: Point, poly: Point[]): boolean {
  let inPoly = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inPoly = !inPoly;
  }
  return inPoly;
}

// ---------- gravel ----------

function layGravel(m: Mesher, site: SitePlan, base: RGB): Point[][] {
  const bands: Point[][] = [];
  const clear = [site.path, site.step].filter((q): q is Point[] => !!q);
  for (const s of site.skirts) {
    const inner = s.inner;
    const outer = offsetLoop(inner, GRAVEL);
    if (outer.length !== inner.length || !outer.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    bands.push(outer);
    // The bed under the stones.
    for (let i = 0; i < inner.length; i++) {
      const j = (i + 1) % inner.length;
      m.poly(
        [
          [inner[i].x, 0.003, inner[i].y],
          [inner[j].x, 0.003, inner[j].y],
          [outer[j].x, 0.003, outer[j].y],
          [outer[i].x, 0.003, outer[i].y],
        ],
        shade(base, 0.62),
        [0, 1, 0],
      );
    }
    // Stones along each side.
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i];
      const b = inner[(i + 1) % inner.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.05) continue;
      const tx = (b.x - a.x) / len;
      const ty = (b.y - a.y) / len;
      const oa = outer[i];
      // Outward, from the band's own geometry.
      const nx = oa.x - a.x - tx * ((oa.x - a.x) * tx + (oa.y - a.y) * ty);
      const ny = oa.y - a.y - ty * ((oa.x - a.x) * tx + (oa.y - a.y) * ty);
      const nl = Math.hypot(nx, ny) || 1;
      // Loose stones on the bed: a few hundred per house, a few hundred thousand per campus — which goes without.
      const count = isCampus(site) ? 0 : Math.floor(len * GRAVEL * 260);
      for (let k = 0; k < count; k++) {
        const u = hash(i, k, 61) * len;
        const v = (0.03 + hash(i, k, 62) * 0.94) * GRAVEL;
        const p = { x: a.x + tx * u + (nx / nl) * v, y: a.y + ty * u + (ny / nl) * v };
        if (clear.some((q) => inside(p, q))) continue;
        const tone = 0.8 + 0.4 * hash(i, k, 63);
        const warm = (hash(i, k, 64) - 0.5) * 0.12;
        pebble(m, p.x, p.y, 0.012 + 0.016 * hash(i, k, 65), hash(i, k, 66) * 6.3, [
          base[0] * tone * (1 + warm),
          base[1] * tone,
          base[2] * tone * (1 - warm),
        ]);
      }
    }
  }
  return bands;
}

// ---------- doorstep, path and lane ----------

/** The doorstep in the path's own stone, a shade darker, its edges eased. Sits over site.ts's plain one. */
function layStep(m: Mesher, site: SitePlan, stone: RGB): void {
  const { step, entrance } = site;
  if (!step || !entrance) return;
  const h = entrance.opensOut ? STEP_HEIGHT_FLUSH : STEP_HEIGHT;
  const cx = step.reduce((s, p) => s + p.x, 0) / 4;
  const cy = step.reduce((s, p) => s + p.y, 0) / 4;
  // A few millimetres all round the plain step, so it never shows through.
  const grown = step.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / d) * 0.007, y: p.y + ((p.y - cy) / d) * 0.007 };
  });
  block(m, grown, -0.01, h + 0.004, 0.014, shade(stone, 0.9));
}

function layPath(m: Mesher, site: SitePlan, stone: RGB, green: RGB): void {
  const path = site.path;
  if (!path) return;
  const [a, b, , d0] = path; // a→b across the path, a→d along it
  // On through the gate to the lane, when there is one.
  const d = site.walk ? site.walk[3] : d0;
  const across = { x: b.x - a.x, y: b.y - a.y };
  const along = { x: d.x - a.x, y: d.y - a.y };
  const width = Math.hypot(across.x, across.y);
  const length = Math.hypot(along.x, along.y);
  if (width < 0.2 || length < 0.2) return;
  const ux = { x: across.x / width, y: across.y / width };
  const vx = { x: along.x / length, y: along.y / length };
  const at = (u: number, v: number): Point => ({ x: a.x + ux.x * u + vx.x * v, y: a.y + ux.y * u + vx.y * v });

  // Rows of irregular length, rescaled to fill the path exactly.
  const raw: number[] = [];
  for (let total = 0, r = 0; total < length && r < 400; r++) {
    const l = 0.45 + 0.35 * hash(r, 0, 70);
    raw.push(l);
    total += l;
  }
  const sum = raw.reduce((s, l) => s + l, 0);
  const rows = raw.map((l) => (l * length) / sum);
  const cols = width > 1.1 ? 2 : 1;
  let v = 0;
  for (const [r, rowLen] of rows.entries()) {
    const split = cols === 2 ? width * (0.36 + 0.28 * hash(r, 1, 72)) : width;
    const cuts = cols === 2 ? [0.02, split, width - 0.02] : [0.02, width - 0.02];
    for (let c = 0; c + 1 < cuts.length; c++) {
      const gap = 0.05 + 0.025 * hash(r, c, 73);
      const u0 = cuts[c] + gap / 2;
      const u1 = cuts[c + 1] - gap / 2;
      const v0 = v + gap / 2;
      const v1 = v + rowLen - gap / 2;
      if (u1 - u0 < 0.12 || v1 - v0 < 0.12) continue;
      // Each slab a little off true: turned, shifted, a few millimetres proud or sunk.
      const turn = (hash(r, c, 74) - 0.5) * 0.07;
      const du = (hash(r, c, 75) - 0.5) * 0.06;
      const dv = (hash(r, c, 76) - 0.5) * 0.04;
      const mu = (u0 + u1) / 2 + du;
      const mv = (v0 + v1) / 2 + dv;
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const corner = (cu: number, cv: number): Point => {
        const ru = (cu - (u0 + u1) / 2) * cos - (cv - (v0 + v1) / 2) * sin;
        const rv = (cu - (u0 + u1) / 2) * sin + (cv - (v0 + v1) / 2) * cos;
        return at(mu + ru, mv + rv);
      };
      const tone = 0.86 + 0.22 * hash(r, c, 77);
      const warm = (hash(r, c, 78) - 0.5) * 0.08;
      const color: RGB = [stone[0] * tone * (1 + warm), stone[1] * tone, stone[2] * tone * (1 - warm)];
      const top = 0.026 + (hash(r, c, 79) - 0.5) * 0.008;
      block(m, [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)], -0.02, top, 0.008, color);
    }
    // Grass coming up in the joint ahead of this row, and in the split.
    const joints = 1 + Math.floor(hash(r, 2, 80) * 3);
    for (let k = 0; k < joints; k++) {
      const p = at(0.05 + hash(r, k, 81) * (width - 0.1), v + rowLen);
      tuft(m, p.x, 0, p.y, 0.035 + 0.04 * hash(r, k, 82), r * 31 + k, green);
    }
    if (cols === 2 && hash(r, 3, 83) > 0.4) {
      const p = at(split, v + rowLen * hash(r, 4, 84));
      tuft(m, p.x, 0, p.y, 0.03 + 0.03 * hash(r, 5, 85), r * 37 + 9, green);
    }
    v += rowLen;
  }
}

/** Two wheel ruts of packed earth along the front, grass between: a lane running off into the haze. */
function layLane(m: Mesher, site: SitePlan, earth: RGB, green: RGB, height: (x: number, z: number) => number): void {
  const lane = site.lane;
  if (!lane) return;
  const len = Math.hypot(lane.b.x - lane.a.x, lane.b.y - lane.a.y);
  if (len < 1) return;
  const tx = (lane.b.x - lane.a.x) / len;
  const ty = (lane.b.y - lane.a.y) / len;
  const nx = -ty;
  const ny = tx;
  const gate = site.gate;
  const at = (s: number, o: number): V3 => {
    const x = lane.a.x + tx * s + nx * o;
    const z = lane.a.y + ty * s + ny * o;
    return [x, height(x, z) + 0.012, z];
  };
  const steps = Math.ceil(len / 1.4);
  for (const side of [-1, 1]) {
    const mid = side * 0.72;
    const edge = (i: number, e: number): number => mid + e * (0.3 + (hash(i, side + 5, 91 + e) - 0.5) * 0.2);
    // A gentle wander, the same for both ruts.
    const wander = (i: number) => (valueNoise((i * 1.4) / 18, 0.5, 92) - 0.5) * 0.5;
    // Worn earth, greening at the edges where the grass creeps back in.
    const tone = (i: number, e: number): RGB => shade(mixRGB(earth, green, 0.12 + 0.25 * hash(i, side * 3 + e, 94)), 0.85 + 0.25 * hash(i, side * 3 + e, 93));
    for (let i = 0; i < steps; i++) {
      const s0 = (i / steps) * len;
      const s1 = ((i + 1) / steps) * len;
      const p00 = at(s0, edge(i, -1) + wander(i));
      const p01 = at(s0, edge(i, 1) + wander(i));
      const p10 = at(s1, edge(i + 1, -1) + wander(i + 1));
      const p11 = at(s1, edge(i + 1, 1) + wander(i + 1));
      m.tri(p00, p01, p11, tone(i, -1), tone(i, 1), tone(i + 1, 1), [0, 1, 0]);
      m.tri(p00, p11, p10, tone(i, -1), tone(i + 1, 1), tone(i + 1, -1), [0, 1, 0]);
    }
  }
  // Loose stones and tufts near where the path comes out; past that, the haze does the work.
  const s0 = gate ? (gate.x - lane.a.x) * tx + (gate.y - lane.a.y) * ty : len / 2;
  for (let k = 0; k < 220; k++) {
    const s = s0 + (hash(k, 0, 94) - 0.5) * 50;
    if (s < 0 || s > len) continue;
    const o = (hash(k, 1, 95) - 0.5) * 2.4;
    const p = at(s, o);
    const onRut = Math.abs(Math.abs(o) - 0.72) < 0.3;
    if (onRut) pebble(m, p[0], p[2], 0.015 + 0.02 * hash(k, 2, 96), hash(k, 3, 97) * 6.3, shade(earth, 0.95 + 0.3 * hash(k, 4, 98)), p[1] - 0.008);
    else if (hash(k, 5, 99) > 0.5) tuft(m, p[0], p[1] - 0.012, p[2], 0.06 + 0.06 * hash(k, 6, 100), 5000 + k, green);
  }
}

// ---------- the fence ----------

interface Post {
  s: number;
  h: number;
  /** Horizontal drift per meter of height: posts settle, none of them quite plumb. */
  lean: [number, number];
}

/** A square post, leaning a touch, with a bevelled cap. */
function post(m: Mesher, x: number, z: number, p: Post, half: number, color: RGB): void {
  const { h, lean } = p;
  const ring = (y: number, r: number, shift: number): V3[] => [
    [x - r + lean[0] * shift, y, z - r + lean[1] * shift],
    [x + r + lean[0] * shift, y, z - r + lean[1] * shift],
    [x + r + lean[0] * shift, y, z + r + lean[1] * shift],
    [x - r + lean[0] * shift, y, z + r + lean[1] * shift],
  ];
  const foot = ring(-0.05, half, 0);
  const top = ring(h, half, h);
  const cap = ring(h + half * 0.55, half * 0.45, h);
  const toward: V3[] = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const k = 0.88 + 0.16 * ((i + 1) % 2);
    m.poly([foot[i], foot[j], top[j], top[i]], shade(color, k), toward[i]);
    m.poly([top[i], top[j], cap[j], cap[i]], shade(color, 1.02 * k), [toward[i][0], 1, toward[i][2]]);
  }
  m.poly(cap, shade(color, 1.1), [0, 1, 0]);
}

/** A rail between two points, sagging a little in the middle. */
function rail(m: Mesher, p: V3, q: V3, sag: number, tall: number, thick: number, color: RGB): void {
  const len = Math.hypot(q[0] - p[0], q[2] - p[2]);
  if (len < 0.05) return;
  const nx = (-(q[2] - p[2]) / len) * thick;
  const nz = ((q[0] - p[0]) / len) * thick;
  const pieces = 4;
  const point = (t: number): V3 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t - sag * 4 * t * (1 - t), p[2] + (q[2] - p[2]) * t];
  for (let i = 0; i < pieces; i++) {
    const a = point(i / pieces);
    const b = point((i + 1) / pieces);
    const lo: V3[] = [
      [a[0] + nx, a[1], a[2] + nz],
      [b[0] + nx, b[1], b[2] + nz],
      [b[0] - nx, b[1], b[2] - nz],
      [a[0] - nx, a[1], a[2] - nz],
    ];
    const hi = lo.map((v): V3 => [v[0], v[1] + tall, v[2]]);
    m.poly(hi, shade(color, 1.06), [0, 1, 0]);
    m.poly(lo, shade(color, 0.6), [0, -1, 0]);
    m.poly([lo[0], lo[1], hi[1], hi[0]], color, [nx, 0, nz]);
    m.poly([lo[3], lo[2], hi[2], hi[3]], shade(color, 0.92), [-nx, 0, -nz]);
  }
}

/** One picket: a board with a pointed top, standing at `base`, its face toward `out`. */
function picket(m: Mesher, base: V3, along: [number, number], out: [number, number], h: number, lean: [number, number], color: RGB): void {
  const w = 0.037;
  const t = 0.011;
  const point = 0.045;
  const at = (u: number, y: number, o: number): V3 => [
    base[0] + along[0] * u + out[0] * o + lean[0] * y,
    base[1] + y,
    base[2] + along[1] * u + out[1] * o + lean[1] * y,
  ];
  const outline: [number, number][] = [[-w, -0.04], [w, -0.04], [w, h - point], [0, h], [-w, h - point]];
  const front = outline.map(([u, y]) => at(u, y, t));
  const back = outline.map(([u, y]) => at(u, y, -t));
  m.poly(front, color, [out[0], 0, out[1]]);
  m.poly(back, shade(color, 0.8), [-out[0], 0, -out[1]]);
  for (let i = 0; i < 5; i++) {
    const j = (i + 1) % 5;
    if (i === 0) continue; // the buried foot
    const mu = (outline[i][0] + outline[j][0]) / 2;
    const my = (outline[i][1] + outline[j][1]) / 2;
    const toward: V3 = [along[0] * mu, my > h - point ? 1 : 0, along[1] * mu];
    m.poly([front[i], front[j], back[j], back[i]], shade(color, my > h - point ? 1.05 : 0.85), toward);
  }
}

function layFence(m: Mesher, site: SitePlan, wood: RGB, paint: RGB): void {
  const { lot, gate, front } = site;
  const corners: Point[] = [
    { x: lot.x0, y: lot.y0 },
    { x: lot.x1, y: lot.y0 },
    { x: lot.x1, y: lot.y1 },
    { x: lot.x0, y: lot.y1 },
  ];
  const normals: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const GATE_POST = 0.065;
  /** Every post's settle comes from where it stands: a corner post is the same post seen from either side. */
  const settle = (p: Point, h: number, k: number): Post => {
    const ix = Math.round(p.x * 100);
    const iy = Math.round(p.y * 100);
    const a = hash(ix, iy, 84) * Math.PI * 2;
    const tilt = Math.tan(((1 + hash(ix, iy, 85)) * Math.PI) / 180) * k;
    return { s: 0, h: h + (hash(ix, iy, 86) - 0.5) * 0.1 * k, lean: [Math.cos(a) * tilt, Math.sin(a) * tilt] };
  };
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.1) continue;
    const tx = (b.x - a.x) / len;
    const ty = (b.y - a.y) / len;
    const [nx, ny] = normals[i];
    const pickets = nx === front.nx && ny === front.ny;
    const point = (s: number): Point => ({ x: a.x + tx * s, y: a.y + ty * s });

    // The gate on this side, as a stretch between the centres of its two posts.
    let g0 = Infinity;
    let g1 = -Infinity;
    if (gate && gate.nx === nx && gate.ny === ny) {
      const s = (gate.x - a.x) * tx + (gate.y - a.y) * ty;
      g0 = s - gate.half - GATE_POST;
      g1 = s + gate.half + GATE_POST;
    }
    const bay = pickets ? 2.1 : 2.4;
    const bays = Math.max(1, Math.round(len / bay));
    const stops: number[] = [];
    for (let k = 0; k <= bays; k++) {
      const s = (k * len) / bays;
      if (s > g0 - 0.6 && s < g1 + 0.6) continue;
      stops.push(s);
    }
    const posts: Post[] = stops.map((s) => {
      const corner = s < 1e-6 || s > len - 1e-6;
      const p = settle(point(s), corner || !pickets ? 1.05 : 0.95, 1);
      return { ...p, s };
    });
    if (g1 > g0) {
      posts.push({ ...settle(point(g0), 1.22, 0.35), s: g0 }, { ...settle(point(g1), 1.22, 0.35), s: g1 });
      posts.sort((p, q) => p.s - q.s);
    }
    for (const p of posts) {
      // Each corner post is drawn once, by the side that starts there.
      if (p.s > len - 1e-6) continue;
      const q = point(p.s);
      const gatePost = p.s === g0 || p.s === g1;
      post(m, q.x, q.y, p, gatePost ? GATE_POST : 0.05, shade(gatePost && pickets ? paint : wood, 0.92 + 0.16 * hash(i, Math.round(p.s * 10), 82)));
    }
    const railYs = pickets ? [0.24, 0.66] : [0.42, 0.86];
    const railAt = (p: Post, y: number): V3 => {
      const q = point(p.s);
      return [q.x + p.lean[0] * y, y, q.y + p.lean[1] * y];
    };
    for (let k = 0; k + 1 < posts.length; k++) {
      const p0 = posts[k];
      const p1 = posts[k + 1];
      if (p0.s >= g0 - 1e-6 && p1.s <= g1 + 1e-6) continue; // the gate
      const span = p1.s - p0.s;
      const color = pickets ? shade(paint, 0.9) : shade(wood, 0.95 + 0.1 * hash(i, k, 83));
      for (const y of railYs) {
        const sag = (0.008 + 0.014 * hash(i, k * 3 + Math.round(y * 10), 87)) * (span / 2.4);
        rail(m, railAt(p0, y), railAt(p1, y), sag, pickets ? 0.06 : 0.075, pickets ? 0.016 : 0.02, color);
      }
      if (!pickets) continue;
      // Pickets along the bay, clear of the posts, on the street face of the rails.
      const count = Math.floor((span - 0.12) / 0.125);
      const pitch = (span - 0.12) / Math.max(1, count);
      for (let j = 0; j < count; j++) {
        const s = p0.s + 0.06 + pitch * (j + 0.5);
        const q = point(s);
        const ph = 0.84 + (hash(i, Math.round(s * 100), 88) - 0.5) * 0.03;
        const tilt = (hash(i, Math.round(s * 100), 89) - 0.5) * 0.02;
        picket(m, [q.x + nx * 0.03, 0, q.y + ny * 0.03], [tx, ty], [nx, ny], ph, [tx * tilt, ty * tilt], shade(paint, 0.94 + 0.12 * hash(i, Math.round(s * 100), 90)));
      }
    }
    if (g1 > g0) layGate(m, point(g1), { x: -tx, y: -ty }, { x: nx, y: ny }, g1 - g0 - 2 * GATE_POST - 0.03, paint, wood);
  }
}

/** A picket gate, hung on the post at `hinge`, closing toward `toward`, swung in off the street to stand ajar. */
function layGate(m: Mesher, hinge: Point, toward: Point, out: Point, width: number, paint: RGB, wood: RGB): void {
  if (width < 0.3) return;
  const swing = (42 * Math.PI) / 180;
  // Swinging inward: away from the street side.
  const dir: [number, number] = [toward.x * Math.cos(swing) - out.x * Math.sin(swing), toward.y * Math.cos(swing) - out.y * Math.sin(swing)];
  const face: [number, number] = [-dir[1], dir[0]];
  // Its face toward the street as it was when shut.
  if (face[0] * out.x + face[1] * out.y < 0) {
    face[0] = -face[0];
    face[1] = -face[1];
  }
  const o: V3 = [hinge.x + dir[0] * 0.075, 0.06, hinge.y + dir[1] * 0.075];
  const at = (u: number, y: number, f: number): V3 => [o[0] + dir[0] * u + face[0] * f, o[1] + y, o[2] + dir[1] * u + face[1] * f];
  const frame = shade(wood, 0.95);
  rail(m, at(0, 0.18, -0.02), at(width, 0.18, -0.02), 0, 0.07, 0.016, frame);
  rail(m, at(0, 0.6, -0.02), at(width, 0.6, -0.02), 0, 0.07, 0.016, frame);
  // The brace, rising from the hinge side's foot.
  const b0 = at(0.05, 0.22, -0.02);
  const b1 = at(width - 0.05, 0.58, -0.02);
  rail(m, b0, b1, 0, 0.06, 0.014, shade(frame, 0.95));
  const count = Math.max(2, Math.round(width / 0.125));
  for (let j = 0; j < count; j++) {
    const u = ((j + 0.5) / count) * width;
    const base = at(u, -0.04, 0.01);
    picket(m, base, dir, face, 0.86, [0, 0], shade(paint, 0.96 + 0.08 * hash(j, 3, 91)));
  }
}

// ---------- all of it ----------

export interface Grounds {
  /** Paving, fence and lane in one mesh, and the hedgerow, copses and far hills round it. */
  mesh: THREE.Object3D | null;
  /** The gravel's outer edge, per building: grass keeps out of it. */
  gravel: Point[][];
  /** Ground height; carries the site along (see `Terrain`). */
  height: Terrain;
}

const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function buildGrounds(site: SitePlan, tone: { gravel: string; stone: string; fence: string; grass?: string }): Grounds {
  const height = terrainFor(site.lot, site.lane) as Terrain;
  height.site = site;
  const m = new Mesher();
  const gravel = layGravel(m, site, lightOf(tone.gravel));
  // Stone a little warmer and darker than the look's own, so the path is not the brightest thing in view.
  const s = lightOf(tone.stone);
  const stone: RGB = [s[0] * 0.87, s[1] * 0.83, s[2] * 0.74];
  const green = lightOf(tone.grass ?? '#748d4c');
  const wood = lightOf(tone.fence);
  // The front pickets painted a soft, weathered white.
  const paint = mixRGB(wood, lightOf('#e6dcc8'), 0.78);
  const earth = mixRGB(lightOf(tone.gravel), lightOf('#8a7152'), 0.6);
  layStep(m, site, stone);
  layPath(m, site, stone, green);
  layLane(m, site, earth, green, height);
  if (!isCampus(site)) layFence(m, site, wood, paint);

  const group = new THREE.Group();
  group.name = 'grounds';
  const geo = m.geometry();
  if (geo) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    material.name = 'grounds';
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'grounds';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const around = buildSurroundings(site, height);
  if (around) group.add(around);
  return { mesh: group.children.length ? group : null, gravel, height };
}
