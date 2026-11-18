/**
 * A roof laid tile by tile. Given the roof model's sloped faces, this lays
 * courses of shingles or slates, runs of barrel tiles, or standing-seam metal
 * panels over each one, caps the ridges and hips, and hangs gutters and
 * downpipes along the eaves.
 *
 * Courses are measured from the eave height and columns from world position,
 * so they line up around every hip — and where two of the model's
 * overlapping faces share a plane, their tiles land in exactly the same
 * place and read as one roof.
 */
import type * as THREE from 'three';
import type { Point } from '../types';
import { pointInRegion, pointInRegions } from './footprint';
import { add, clipToBox, convexHull, cross, dot, hash, lightOf, polygonArea, shade, Soup, sub, unit } from './pieces';
import type { P2, RGB, V3 } from './pieces';
import type { RoofModel } from './roof';
import { ROOF_OVERHANG } from './roof';

export type Roofing = 'seam' | 'shingle' | 'slate' | 'barrel';

export interface Face {
  pts: V3[];
  n: V3;
  /** Which of the model's solids it belongs to (slopes only). */
  solid?: number;
}

const same = (a: V3, b: V3): boolean => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-5;

/** The model stores loose triangles; put each flat face back together (a fan of them). */
export function facesOf(positions: number[]): Face[] {
  const faces: Face[] = [];
  let cur: Face | null = null;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const tri: V3[] = [
      [positions[i], positions[i + 1], positions[i + 2]],
      [positions[i + 3], positions[i + 4], positions[i + 5]],
      [positions[i + 6], positions[i + 7], positions[i + 8]],
    ];
    const n = unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    const face = cur;
    const shared = face ? tri.filter((p) => face.pts.some((q) => same(p, q))).length : 0;
    if (face && shared >= 2 && dot(n, face.n) > 0.9999) {
      for (const p of tri) if (!face.pts.some((q) => same(p, q))) face.pts.push(p);
    } else {
      cur = { pts: tri, n };
      faces.push(cur);
    }
  }
  return faces;
}

/** Faces that shed water: sloped, and looking up. */
function slopes(model: RoofModel): Face[] {
  const out: Face[] = [];
  model.solids.forEach((solid, i) => {
    if (solid.part !== 'roof') return;
    for (const f of facesOf(solid.positions)) if (f.n[1] > 0.3 && f.n[1] < 0.995) out.push({ ...f, solid: i });
  });
  return out;
}

/**
 * Where wings of a roof cross, each one's slopes run on under the other's.
 * For a face, a test of whether a point of it lies under a slope of another
 * solid — tiles there are buried and must not be laid, or they poke through
 * as a band across the junction.
 */
function burialTest(face: Face, faces: Face[]): ((p: V3) => boolean) | null {
  const box = (f: Face) => {
    const xs = f.pts.map((p) => p[0]);
    const zs = f.pts.map((p) => p[2]);
    return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  };
  const [ax0, ax1, az0, az1] = box(face);
  const over = faces
    .filter((o) => o !== face && o.solid !== face.solid)
    .filter((o) => {
      const [bx0, bx1, bz0, bz1] = box(o);
      return bx0 < ax1 && bx1 > ax0 && bz0 < az1 && bz1 > az0;
    })
    .map((o) => ({ n: o.n, d: dot(o.n, o.pts[0]), hull: convexHull(o.pts.map((p): P2 => [p[0], p[2]])) }));
  if (over.length === 0) return null;
  return (p) =>
    over.some(({ n, d, hull }) => {
      // Inside the other slope's plan, and under its surface there.
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        if ((b[0] - a[0]) * (p[2] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < -1e-9) return false;
      }
      return (d - n[0] * p[0] - n[2] * p[2]) / n[1] > p[1] + 0.005;
    });
}

const planeId = (n: V3, p: V3): number =>
  Math.floor(hash(Math.round(n[0] * 200), Math.round(n[2] * 200), Math.round(dot(n, p) * 50)) * 1e6);

/** A face's own flat coordinates: `u` across the slope (world-anchored), `v` up it from the eave height. */
function frame(face: Face, eave: number) {
  const n = face.n;
  const t = unit(cross([0, 1, 0], n));
  const b = cross(n, t); // up the slope; its rise per meter is b[1]
  const p0 = face.pts[0];
  const u0 = dot(p0, t);
  const v0 = (p0[1] - eave) / b[1];
  const origin = add(add(p0, t, -u0), b, -v0);
  return {
    n,
    t,
    b,
    at: (u: number, v: number, h: number): V3 => add(add(add(origin, t, u), b, v), n, h),
    hull: convexHull(face.pts.map((p): P2 => [dot(p, t), (p[1] - eave) / b[1]])),
  };
}

interface Cell {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** Height above the roof plane at a point of the cell. */
  lift: (u: number, v: number) => number;
  color: RGB;
  /** Which of the cell's own edges get a face down to the roof: the lower one, the sides. */
  front?: boolean;
  sides?: boolean;
}

type Frame = ReturnType<typeof frame> & { buried?: ((p: V3) => boolean) | null };

function lay(soup: Soup, f: Frame, cell: Cell): void {
  const q = clipToBox(f.hull, cell.u0, cell.u1, cell.v0, cell.v1);
  if (q.length < 3 || polygonArea(q) < 2e-4) return;
  // Wholly under another wing's slope: nothing of it would show but its top, poking through.
  const buried = f.buried;
  if (buried && q.every(([u, v]) => buried(f.at(u, v, 0)))) return;
  const top = q.map(([u, v]) => f.at(u, v, cell.lift(u, v)));
  soup.poly(top, cell.color, f.n);
  if (!cell.front && !cell.sides) return;
  const eps = 1e-6;
  for (let i = 0; i < q.length; i++) {
    const j = (i + 1) % q.length;
    const a = q[i];
    const b = q[j];
    const upper = Math.abs(a[1] - cell.v1) < eps && Math.abs(b[1] - cell.v1) < eps;
    if (upper) continue; // tucked under the course above
    const lower = Math.abs(a[1] - cell.v0) < eps && Math.abs(b[1] - cell.v0) < eps;
    if (lower ? !cell.front : !cell.sides) continue;
    const du = b[0] - a[0];
    const dv = b[1] - a[1];
    // The butt end of a course is in its own shade: that line is what reads as tiling from far off.
    soup.poly(
      [top[i], top[j], f.at(b[0], b[1], 0), f.at(a[0], a[1], 0)],
      shade(cell.color, lower ? 0.66 : 0.78),
      add([f.t[0] * dv, f.t[1] * dv, f.t[2] * dv], f.b, -du),
    );
  }
}

const tone = (pid: number, row: number, col: number, spread: number): number =>
  1 + (hash(pid + row * 7919, col, 3) - 0.5) * 2 * spread;

function layFace(soup: Soup, face: Face, eave: number, roofing: Roofing, base: RGB, faces: Face[] = []): void {
  const f: Frame = { ...frame(face, eave), buried: burialTest(face, faces) };
  if (f.hull.length < 3) return;
  const pid = planeId(face.n, face.pts[0]);
  const us = f.hull.map((p) => p[0]);
  const vs = f.hull.map((p) => p[1]);
  const [uMin, uMax, vMin, vMax] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];

  if (roofing === 'seam') {
    // Long metal trays between raised seams.
    const w = 0.44;
    for (let c = Math.floor(uMin / w); c * w < uMax; c++) {
      lay(soup, f, { u0: c * w + 0.014, u1: (c + 1) * w - 0.014, v0: vMin, v1: vMax, lift: () => 0.012, color: shade(base, tone(pid, 0, c, 0.035)) });
      lay(soup, f, { u0: c * w - 0.014, u1: c * w + 0.014, v0: vMin, v1: vMax, lift: () => 0.05, color: shade(base, 1.08), sides: true, front: true });
    }
    return;
  }

  if (roofing === 'barrel') {
    // Half-round clay tiles in runs up the slope; each tile's lower end rides over the one below.
    const w = 0.26;
    const len = 0.4;
    const cuts = [0, 0.2, 0.5, 0.8, 1];
    const arc = [0.012, 0.062, 0.088, 0.062, 0.012];
    for (let c = Math.floor(uMin / w); c * w < uMax; c++) {
      for (let r = Math.floor(vMin / len); r * len < vMax; r++) {
        const v0 = r * len;
        const k = tone(pid, r, c, 0.13) * (hash(pid + r, c, 9) < 0.07 ? 0.82 : 1);
        for (let s = 0; s < 4; s++) {
          const ua = (c + cuts[s]) * w;
          const ub = (c + cuts[s + 1]) * w;
          const ha = arc[s];
          const hb = arc[s + 1];
          lay(soup, f, {
            u0: ua,
            u1: ub,
            v0,
            v1: v0 + len,
            lift: (u, v) => (ha + ((hb - ha) * (u - ua)) / (ub - ua)) * (0.82 + 0.3 * (1 - (v - v0) / len)),
            // The channel between two runs sits in shade.
            color: shade(base, k * (s === 0 || s === 3 ? 0.78 : 1.04)),
            front: true,
          });
        }
      }
    }
    return;
  }

  // Shingles and slates: flat courses, each tile a thin wedge, joints staggered row to row.
  const slate = roofing === 'slate';
  const w = slate ? 0.3 : 0.28;
  const exposure = slate ? 0.24 : 0.2;
  const thick = slate ? 0.024 : 0.034;
  const gap = slate ? 0.005 : 0.007;
  for (let r = Math.floor(vMin / exposure); r * exposure < vMax; r++) {
    const v0 = r * exposure;
    const off = (r & 1 ? w / 2 : 0) + (hash(pid, r, 5) - 0.5) * 0.04;
    for (let c = Math.floor((uMin - off) / w); c * w + off < uMax; c++) {
      const dark = hash(pid + r * 31, c, 7) < 0.08 ? 0.84 : 1;
      lay(soup, f, {
        u0: c * w + off + gap / 2,
        u1: (c + 1) * w + off - gap / 2,
        v0,
        v1: v0 + exposure,
        lift: (_u, v) => 0.008 + thick * (1 - (v - v0) / exposure),
        color: shade(base, tone(pid, r, c, slate ? 0.08 : 0.11) * dark),
        front: true,
        sides: true,
      });
    }
  }
}

/** Caps along every ridge and hip: where two slopes meet and both fall away. */
function layCaps(soup: Soup, faces: Face[], roofing: Roofing, base: RGB): void {
  const key = (p: V3): string => `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)},${Math.round(p[2] * 500)}`;
  const edges = new Map<string, { a: V3; b: V3; faces: Face[] }>();
  for (const face of faces) {
    // The face's outline, in order.
    const f = frame(face, 0);
    const ring = f.hull.map(([u, v]) => f.at(u, v, 0));
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const [ka, kb] = [key(a), key(b)];
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const hit = edges.get(k);
      if (hit) hit.faces.push(face);
      else edges.set(k, { a, b, faces: [face] });
    }
  }
  const spec =
    roofing === 'seam'
      ? { piece: 1.3, w: 0.13, sit: 0.05, peak: 0.03, spread: 0.02 }
      : roofing === 'barrel'
        ? { piece: 0.4, w: 0.13, sit: 0.07, peak: 0.1, spread: 0.12 }
        : { piece: 0.36, w: 0.12, sit: 0.035, peak: 0.05, spread: 0.08 };
  let id = 0;
  for (const { a, b, faces: pair } of edges.values()) {
    id++;
    if (pair.length < 2) continue;
    const [f1, f2] = pair;
    if (dot(f1.n, f2.n) > 0.999) continue;
    const dir = unit(sub(b, a));
    const length = Math.hypot(...sub(b, a));
    if (length < 0.2) continue;
    const up = unit(add(f1.n, f2.n));
    // Down each slope, square to the edge.
    let d1 = unit(cross(f1.n, dir));
    if (dot(d1, f2.n) > 0) d1 = [-d1[0], -d1[1], -d1[2]];
    let d2 = unit(cross(f2.n, dir));
    if (dot(d2, f1.n) > 0) d2 = [-d2[0], -d2[1], -d2[2]];
    // Only where both slopes fall away from the edge (a ridge or hip, not a valley or an eave).
    if (d1[1] > -0.05 || d2[1] > -0.05) continue;
    const section = (s: number): [V3, V3, V3] => {
      const e = add(a, dir, s);
      return [
        add(add(e, d1, spec.w), f1.n, spec.sit),
        add(e, up, spec.sit + spec.peak),
        add(add(e, d2, spec.w), f2.n, spec.sit),
      ];
    };
    const count = Math.max(1, Math.round(length / spec.piece));
    const step = length / count;
    for (let i = 0; i < count; i++) {
      const [l0, c0, r0] = section(i * step + 0.004);
      const [l1, c1, r1] = section((i + 1) * step - 0.004);
      const color = shade(base, 0.94 + (hash(id, i, 11) - 0.5) * 2 * spec.spread);
      soup.poly([l0, l1, c1, c0], color, f1.n);
      soup.poly([c0, c1, r1, r0], color, f2.n);
      soup.poly([l0, c0, r0], shade(color, 0.6), [-dir[0], -dir[1], -dir[2]]);
      soup.poly([l1, c1, r1], shade(color, 0.6), dir);
      soup.poly([l0, l1, add(l1, f1.n, -spec.sit), add(l0, f1.n, -spec.sit)], shade(color, 0.6), d1);
      soup.poly([r0, r1, add(r1, f2.n, -spec.sit), add(r0, f2.n, -spec.sit)], shade(color, 0.6), d2);
    }
  }
}

/** Tiles (or metal trays) over every slope, with ridge and hip caps. Null for a roof with no slopes. */
export function buildRoofPieces(model: RoofModel, roofing: Roofing, color: string): THREE.BufferGeometry | null {
  const faces = slopes(model);
  if (faces.length === 0) return null;
  const soup = new Soup();
  const base = lightOf(color);
  // Each roof is coursed from the walls it stands on: a taller building's from higher up.
  for (const face of faces) layFace(soup, face, model.solids[face.solid ?? -1]?.eave ?? model.eave, roofing, base, faces);
  layCaps(soup, faces, roofing, base);
  return soup.geometry();
}

// ---------- gutters and downpipes ----------

interface Run {
  /** Outward from the roof, in plan. */
  nx: number;
  nz: number;
  /** Along the eave, in plan. */
  tx: number;
  tz: number;
  /** A point of the eave line, and the run's extent along it. */
  x: number;
  z: number;
  s0: number;
  s1: number;
  y: number;
}

/**
 * Whether a point of the plan is under a roof standing at about height `y`
 * or higher. Below a tall roof's eave a lower wing's roof is still open air
 * for the gutter; the other way round it is not.
 */
function coveredAt(model: RoofModel, p: Point, y: number): boolean {
  const eaves = model.outlineEaves;
  if (!eaves) return pointInRegions(p, model.outline);
  return model.outline.some((region, i) => (eaves[i] ?? Infinity) > y - 1 && pointInRegion(p, region));
}

/** Under a roof lower than height `y`: a pipe from up there would run down through it. */
function overLowerRoof(model: RoofModel, p: Point, y: number): boolean {
  const eaves = model.outlineEaves;
  return !!eaves && model.outline.some((region, i) => (eaves[i] ?? Infinity) <= y - 1 && pointInRegion(p, region));
}

/** The stretches of eave that are really the edge of the roof (the model's faces overlap; many of their lower edges are buried). */
function eaveRuns(model: RoofModel, faces: Face[]): Run[] {
  const runs = new Map<string, Run[]>();
  for (const face of faces) {
    const low = Math.min(...face.pts.map((p) => p[1]));
    const pts = face.pts.filter((p) => p[1] - low < 1e-4);
    if (pts.length < 2) continue;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const nl = Math.hypot(face.n[0], face.n[2]);
    if (len < 0.3 || nl < 1e-6) continue;
    const nx = face.n[0] / nl;
    const nz = face.n[2] / nl;
    // One direction per line, whichever way the face listed its corners.
    let tx = -nz;
    let tz = nx;
    if (tx < -1e-9 || (Math.abs(tx) < 1e-9 && tz < 0)) [tx, tz] = [-tx, -tz];
    const sa = a[0] * tx + a[2] * tz;
    const sb = b[0] * tx + b[2] * tz;
    const [lo, hi] = sa < sb ? [sa, sb] : [sb, sa];
    const base = { x: a[0] - tx * sa, z: a[2] - tz * sa };
    // Walk the edge; keep the parts with open air just outside them.
    const step = 0.2;
    let start: number | null = null;
    const list: Run[] = [];
    for (let s = lo; s <= hi + 1e-9; s += step) {
      const mid = Math.min(hi, s + step / 2);
      const p: Point = { x: base.x + tx * mid + nx * 0.06, y: base.z + tz * mid + nz * 0.06 };
      const open = s < hi && !coveredAt(model, p, low);
      if (open && start === null) start = s;
      if (!open && start !== null) {
        list.push({ nx, nz, tx, tz, x: base.x, z: base.z, s0: start, s1: Math.min(hi, s), y: low });
        start = null;
      }
    }
    if (start !== null) list.push({ nx, nz, tx, tz, x: base.x, z: base.z, s0: start, s1: hi, y: low });
    const k = `${Math.round(nx * 100)},${Math.round(nz * 100)},${Math.round((base.x * nx + base.z * nz) * 50)},${Math.round(low * 50)}`;
    runs.set(k, [...(runs.get(k) ?? []), ...list]);
  }
  // Faces that share an eave line list the same stretch twice: merge them.
  const merged: Run[] = [];
  for (const list of runs.values()) {
    list.sort((p, q) => p.s0 - q.s0);
    let cur: Run | null = null;
    for (const r of list) {
      if (cur && r.s0 <= cur.s1 + 0.05) cur.s1 = Math.max(cur.s1, r.s1);
      else {
        cur = { ...r };
        merged.push(cur);
      }
    }
  }
  return merged.filter((r) => r.s1 - r.s0 > 0.4);
}

const scale = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];

/** A straight tube from `a` to `b`, `sides`-sided, of radius `r`, open at both ends (joints overlap the next piece). */
function tube(soup: Soup, a: V3, b: V3, r: number, color: RGB, sides = 8): void {
  const axis = unit(sub(b, a));
  if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) return;
  const helper: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const p = unit(cross(axis, helper));
  const q = cross(axis, p);
  const ring = (c: V3, i: number): V3 => {
    const t = (i / sides) * Math.PI * 2;
    return add(add(c, p, Math.cos(t) * r), q, Math.sin(t) * r);
  };
  for (let i = 0; i < sides; i++) {
    const t = ((i + 0.5) / sides) * Math.PI * 2;
    const out = add(scale(p, Math.cos(t)), q, Math.sin(t));
    soup.poly([ring(a, i), ring(a, i + 1), ring(b, i + 1), ring(b, i)], color, out);
  }
}

/** Where a run's end meets another run: the other run's outward normal, for the mitre. */
interface RunEnd {
  s: number;
  /** Outward normal (plan) of the run met at this end, or null for a free end (a gable, a stop). */
  meets: [number, number] | null;
}

/**
 * Snap the runs' ends to the corners where two eaves meet, so gutters can be
 * mitred there; a free end stays where the eave stops.
 */
function runEnds(runs: Run[]): [RunEnd, RunEnd][] {
  const ends: [RunEnd, RunEnd][] = runs.map((r) => [
    { s: r.s0, meets: null },
    { s: r.s1, meets: null },
  ]);
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i];
      const b = runs[j];
      if (Math.abs(a.y - b.y) > 0.02) continue;
      const den = a.tx * b.tz - a.tz * b.tx;
      if (Math.abs(den) < 0.2) continue; // (near) parallel
      // Where the two eave lines cross, in each run's own along-coordinate.
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const ta = (dx * b.tz - dz * b.tx) / den;
      const tb = (dx * a.tz - dz * a.tx) / den;
      const ka = ends[i].findIndex((e) => Math.abs(e.s - ta) < 0.3);
      const kb = ends[j].findIndex((e) => Math.abs(e.s - tb) < 0.3);
      if (ka < 0 || kb < 0) continue;
      ends[i][ka] = { s: ta, meets: [b.nx, b.nz] };
      ends[j][kb] = { s: tb, meets: [a.nx, a.nz] };
    }
  }
  return ends;
}

/**
 * A half-round gutter's section, (out from the eave line, up from the eave
 * height): the outside of the trough, its front bead, and how deep it sits.
 */
const GUTTER_R = 0.055;
const GUTTER_TOP = 0.05;
const GUTTER_SECTION: [number, number][] = Array.from({ length: 7 }, (_, i) => {
  const t = Math.PI + (i / 6) * Math.PI; // back lip round the bottom to the front lip
  return [GUTTER_R + 0.004 + Math.cos(t) * GUTTER_R, GUTTER_TOP + Math.sin(t) * GUTTER_R];
});

/** One gutter run: an open trough, darker inside, mitred where it meets another, capped where it stops. */
function layGutter(soup: Soup, r: Run, [e0, e1]: [RunEnd, RunEnd], base: RGB): void {
  if (e1.s - e0.s < 0.1) return;
  // How far past (or short of) its end a point `d` out from the eave runs, to land on the mitre.
  const mitre = (e: RunEnd, dir: number): number => {
    if (!e.meets) return 0;
    const [mx, mz] = e.meets;
    const along = dir * (r.tx * mx + r.tz * mz);
    if (Math.abs(along) < 0.05) return 0;
    return (1 - (r.nx * mx + r.nz * mz)) / along;
  };
  const k0 = mitre(e0, -1);
  const k1 = mitre(e1, 1);
  const at = (s: number, d: number, y: number): V3 => [r.x + r.tx * s + r.nx * d, r.y + y, r.z + r.tz * s + r.nz * d];
  const start = (d: number, y: number): V3 => at(e0.s - k0 * d, d, y);
  const end = (d: number, y: number): V3 => at(e1.s + k1 * d, d, y);
  const cx = GUTTER_R + 0.004;
  const inner = (p: [number, number]): [number, number] => {
    // 4 mm in toward the trough's centre: the inside face.
    const dx = cx - p[0];
    const dy = GUTTER_TOP - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / l) * 0.004, p[1] + (dy / l) * 0.004];
  };
  const sec = GUTTER_SECTION;
  for (let i = 0; i + 1 < sec.length; i++) {
    const [a, b] = [sec[i], sec[i + 1]];
    const mid: [number, number] = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - GUTTER_TOP];
    const outN: V3 = [r.nx * mid[0], mid[1], r.nz * mid[0]];
    soup.poly([start(a[0], a[1]), start(b[0], b[1]), end(b[0], b[1]), end(a[0], a[1])], shade(base, 1), outN);
    const [ia, ib] = [inner(a), inner(b)];
    soup.poly([start(ia[0], ia[1]), start(ib[0], ib[1]), end(ib[0], ib[1]), end(ia[0], ia[1])], shade(base, 0.5), scale(outN, -1));
  }
  // The rolled bead along the front lip.
  const lip = sec[sec.length - 1];
  tube(soup, start(lip[0] + 0.006, lip[1]), end(lip[0] + 0.006, lip[1]), 0.009, shade(base, 1.06), 6);
  // A flat cap closing each free end.
  for (const [e, dir] of [[e0, -1], [e1, 1]] as const) {
    if (e.meets) continue;
    const ring = sec.map(([d, y]) => at(e.s, d, y));
    soup.poly(ring, shade(base, 0.9), [r.tx * dir, 0, r.tz * dir]);
  }
}

/** A gutter along every real eave, and a downpipe at the end of the longest ones. */
export function buildGutters(model: RoofModel, color: string): THREE.BufferGeometry | null {
  const faces = slopes(model);
  if (faces.length === 0) return null;
  const runs = eaveRuns(model, faces);
  if (runs.length === 0) return null;
  const soup = new Soup();
  const base = lightOf(color);
  const ends = runEnds(runs);
  runs.forEach((r, i) => layGutter(soup, r, ends[i], base));
  // Downpipes: round, down the wall near one end of the four longest eaves, kicked out at the foot.
  const pipes = runs
    .map((r, i) => ({ r, e: ends[i] }))
    .sort((p, q) => q.e[1].s - q.e[0].s - (p.e[1].s - p.e[0].s))
    .slice(0, 4);
  const back = ROOF_OVERHANG - 0.07;
  const out = GUTTER_R + 0.004;
  const pr = 0.034;
  for (const { r, e } of pipes) {
    if (e[1].s - e[0].s < 3) continue;
    const s = e[0].s + ROOF_OVERHANG + 0.35;
    // The outlet under the trough, and the pipe standing just off the wall.
    const outlet: V3 = [r.x + r.tx * s + r.nx * out, r.y + GUTTER_TOP - GUTTER_R - 0.01, r.z + r.tz * s + r.nz * out];
    const wx = r.x + r.tx * s - r.nx * back;
    const wz = r.z + r.tz * s - r.nz * back;
    if (overLowerRoof(model, { x: wx, y: wz }, r.y)) continue;
    const top = r.y - 0.3;
    tube(soup, outlet, [outlet[0], outlet[1] - 0.06, outlet[2]], pr * 0.8, base);
    tube(soup, [outlet[0], outlet[1] - 0.05, outlet[2]], [wx, top + 0.02, wz], pr, base);
    const foot = 0.2;
    tube(soup, [wx, top + 0.03, wz], [wx, foot, wz], pr, base);
    // The shoe: a short kick out from the wall, so water is thrown clear of the footing.
    tube(soup, [wx, foot + 0.02, wz], [wx + r.nx * 0.14, 0.06, wz + r.nz * 0.14], pr, base);
    // Brackets holding it to the wall.
    for (const y of [foot + 0.4, (foot + top) / 2 + 0.2, top - 0.15]) {
      if (y > top - 0.05 || y < foot + 0.1) continue;
      tube(soup, [wx, y - 0.015, wz], [wx, y + 0.015, wz], pr + 0.008, shade(base, 0.85));
    }
  }
  return soup.geometry();
}
