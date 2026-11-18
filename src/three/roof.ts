/**
 * Roof shapes as plain numbers (no three.js): prisms to extrude and triangle
 * soups, in world space — x east, y up, z south (plan y).
 *
 * Every roof is built from the true footprint: the union of the rooms that
 * are under cover (see footprint.ts), never a bounding box. It sits on the
 * walls round it: a building of several levels (levels.ts) has its roof up
 * at the top of them, and rooms of different heights are roofed apart.
 *
 *  flat   one slab per building following the outline, with a thin raised
 *         fascia round every edge (courtyards stay open).
 *  gable  the footprint is covered with wings (maximal rectangles); each
 *         wing has its own ridge along its long side, the same pitch and the
 *         same eave height. A lesser wing that runs into a greater one stops
 *         at its ridge, so the junction reads as valleys.
 *  hip    one hip per maximal rectangle of the eave outline — together they
 *         are exactly the equal-pitch hip roof of the whole outline.
 *
 * Outlines with angled walls get the flat roof, or for gable/hip a hipped
 * skirt rising to a flat deck: nothing is ever roofed that is not a room.
 */
import type { PlanSettings, Point, RoofKind, Wall } from '../types';
import { planLevels } from '../levels';
import {
  gridAngle,
  growRegions,
  maximalRects,
  offsetLoop,
  isSimpleLoop,
  pointInRegion,
  regionGrid,
  roofFootprint,
  rotateRegions,
  safeOffset,
  signedArea,
  unionRegions,
} from './footprint';
import type { CellRect, Grid, Rect, Region } from './footprint';

export type RoofPart = 'roof' | 'gable' | 'soffit';

/** A vertical prism: plan outline (with optional holes) between two heights. */
export interface RoofSlab {
  part: RoofPart;
  poly: Point[];
  holes?: Point[][];
  y0: number;
  y1: number;
}

/** Loose triangles, 9 numbers each, wound to face outward. */
export interface RoofSolid {
  part: RoofPart;
  positions: number[];
  /** Height of the walls this solid stands on (m), where a plan has roofs at several heights; else the model's `eave`. */
  eave?: number;
}

export type V3 = [number, number, number];

export interface RoofRidge {
  a: V3;
  b: V3;
  /** Half the width of the wing under it (m). */
  half: number;
  /** Gable roofs: whether the end at `a` / `b` is a gable (false: it runs into another wing). */
  gableA?: boolean;
  gableB?: boolean;
}

export interface RoofModel {
  kind: RoofKind;
  slabs: RoofSlab[];
  solids: RoofSolid[];
  /** Highest point (m), wall height when there is no roof. */
  top: number;
  /** Height the pitched faces spring from at the wall line (m). */
  eave: number;
  /** Rise per meter of run for pitched roofs; 0 for flat. */
  slope: number;
  ridges: RoofRidge[];
  /** Everything the roof covers, seen in plan (overhang included). */
  outline: Region[];
  /**
   * Where a plan has roofs at several heights: the wall height under each
   * region of `outline`, in the same order. Absent when every roof stands at `eave`.
   */
  outlineEaves?: number[];
}

export interface RoofInput {
  /** Detected rooms. */
  rooms: { key?: string; polygon: Point[] }[];
  /** Only used when no room is closed: the roof then sits on the walls' bounding box. */
  walls: Wall[];
  settings: Pick<PlanSettings, 'wallHeight' | 'wallThickness'>;
  /** Keys of rooms open to the sky (see `openAirRooms`). */
  open?: ReadonlySet<string> | null;
}

export const ROOF_OVERHANG = 0.3;
const SLAB = 0.16;
const FASCIA_WIDTH = 0.05;
const FASCIA_DROP = 0.03;
const FASCIA_RISE = 0.04;
const PITCHED_SLAB = 0.14;
const EAVE_BAND = 0.1;
const DEG = Math.PI / 180;
const GABLE_PITCH = 32 * DEG;
const HIP_PITCH = 27 * DEG;
const MIN_PITCH = 12 * DEG;

/** The pitch, eased off on wide houses so the tallest ridge stays in proportion to the walls. */
export function roofSlope(pitch: number, widestHalf: number, wallHeight: number): number {
  const maxRise = Math.min(3.4, Math.max(1.6, wallHeight));
  const eased = widestHalf > 1e-6 ? maxRise / widestHalf : Infinity;
  return Math.max(Math.tan(MIN_PITCH), Math.min(Math.tan(pitch), eased));
}

// ---------- triangles ----------

/** A flat convex face as a fan, wound so its normal points along (nx, ny, nz). */
function face(out: number[], pts: V3[], nx: number, ny: number, nz: number): void {
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[0];
    let b = pts[i];
    let c = pts[i + 1];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-14) continue;
    if (cx * nx + cy * ny + cz * nz < 0) [b, c] = [c, b];
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
}

// ---------- flat ----------

/** A raised band round the outside of each slab edge: reads as a fascia from below, a parapet from above. */
function fasciaBand(regions: Region[], y0: number, y1: number): number[] {
  const out: number[] = [];
  for (const region of regions) {
    const loops: { loop: Point[]; hole: boolean }[] = [
      { loop: region.outer, hole: false },
      ...region.holes.map((loop) => ({ loop, hole: true })),
    ];
    for (const { loop, hole } of loops) {
      // Away from the slab: outward for the outline, into the opening for a hole.
      const rim = offsetLoop(loop, hole ? -FASCIA_WIDTH : FASCIA_WIDTH);
      if (rim.length !== loop.length || !rim.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
      if (hole && Math.sign(signedArea(rim)) !== Math.sign(signedArea(loop))) continue;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const ra = rim[i];
        const rb = rim[(i + 1) % loop.length];
        const nx = (ra.x + rb.x - a.x - b.x) / 2;
        const nz = (ra.y + rb.y - a.y - b.y) / 2;
        face(out, [[a.x, y1, a.y], [b.x, y1, b.y], [rb.x, y1, rb.y], [ra.x, y1, ra.y]], 0, 1, 0);
        face(out, [[a.x, y0, a.y], [b.x, y0, b.y], [rb.x, y0, rb.y], [ra.x, y0, ra.y]], 0, -1, 0);
        face(out, [[ra.x, y0, ra.y], [rb.x, y0, rb.y], [rb.x, y1, rb.y], [ra.x, y1, ra.y]], nx, 0, nz);
        face(out, [[a.x, y0, a.y], [b.x, y0, b.y], [b.x, y1, b.y], [a.x, y1, a.y]], -nx, 0, -nz);
      }
    }
  }
  return out;
}

interface Built {
  slabs: RoofSlab[];
  solids: RoofSolid[];
  top: number;
  slope: number;
  ridges: RoofRidge[];
  outline: Region[];
}

function flatRoof(deck: Region[], outline: Region[], H: number): Built {
  const slabs: RoofSlab[] = deck.map((r) => ({ part: 'roof', poly: r.outer, holes: r.holes, y0: H, y1: H + SLAB }));
  const band = fasciaBand(deck, H - FASCIA_DROP, H + SLAB + FASCIA_RISE);
  return {
    slabs,
    solids: band.length > 0 ? [{ part: 'soffit', positions: band }] : [],
    top: H + SLAB + FASCIA_RISE,
    slope: 0,
    ridges: [],
    outline,
  };
}

// ---------- gable ----------

/** One gabled wing in its own frame: u along the ridge, v across it. */
export interface Wing {
  alongX: boolean;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** The end is a gable (wall + overhang); false when it dies into a greater wing. */
  openLo: boolean;
  openHi: boolean;
}

/** A cover of the footprint by few, large rectangles: greedy by new ground gained, then anything redundant dropped. */
export function chooseWings(grid: Grid, rects: CellRect[]): CellRect[] {
  const { xs, ys } = grid;
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  const cellArea = (r: number, c: number): number => (xs[c + 1] - xs[c]) * (ys[r + 1] - ys[r]);
  const cover: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const gain = (rect: CellRect): number => {
    let g = 0;
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) if (cover[r][c] === 0) g += cellArea(r, c);
    return g;
  };
  const short = (r: CellRect): number => Math.min(r.x1 - r.x0, r.y1 - r.y0);
  const long = (r: CellRect): number => Math.max(r.x1 - r.x0, r.y1 - r.y0);
  const better = (a: CellRect, ga: number, b: CellRect, gb: number): boolean => {
    if (Math.abs(ga - gb) > 1e-6) return ga > gb;
    if (Math.abs(short(a) - short(b)) > 1e-6) return short(a) > short(b);
    if (Math.abs(long(a) - long(b)) > 1e-6) return long(a) > long(b);
    const ah = a.x1 - a.x0 >= a.y1 - a.y0;
    const bh = b.x1 - b.x0 >= b.y1 - b.y0;
    if (ah !== bh) return ah;
    if (Math.abs(a.y0 - b.y0) > 1e-6) return a.y0 < b.y0;
    return a.x0 < b.x0;
  };

  const chosen: CellRect[] = [];
  const pool = rects.slice();
  while (pool.length > 0) {
    let best = -1;
    let bestGain = 0;
    pool.forEach((rect, i) => {
      const g = gain(rect);
      if (g <= 1e-6) return;
      if (best < 0 || better(rect, g, pool[best], bestGain)) {
        best = i;
        bestGain = g;
      }
    });
    if (best < 0) break;
    const [rect] = pool.splice(best, 1);
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) cover[r][c]++;
    chosen.push(rect);
  }

  // A wing the others already cover between them adds nothing but clutter.
  const bySize = chosen.slice().sort((a, b) => short(a) * long(a) - short(b) * long(b));
  for (const rect of bySize) {
    let redundant = true;
    for (let r = rect.r0; r <= rect.r1 && redundant; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        if (cover[r][c] < 2) {
          redundant = false;
          break;
        }
      }
    }
    if (!redundant) continue;
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) cover[r][c]--;
    chosen.splice(chosen.indexOf(rect), 1);
  }
  return chosen;
}

/**
 * Rectangles → wings, greatest (widest, then longest) first, with their ends
 * settled:
 *
 *  - a wing that ends inside a wing running across it stops at that wing's
 *    ridge and loses its gable there — unless it is the wider of the two, or
 *    the two meet corner to corner and it is the greater;
 *  - a wing lying inside a wider wing that runs the same way only starts
 *    where the wider one ends.
 *
 * Either way the cut end is buried under the other wing's roof.
 */
export function planWings(rects: Rect[]): Wing[] {
  const E = 0.01;
  const half = (w: Wing): number => (w.v1 - w.v0) / 2;
  const raw: Wing[] = rects.map((r) => {
    const alongX = r.x1 - r.x0 >= r.y1 - r.y0;
    return alongX
      ? { alongX, u0: r.x0, u1: r.x1, v0: r.y0, v1: r.y1, openLo: true, openHi: true }
      : { alongX, u0: r.y0, u1: r.y1, v0: r.x0, v1: r.x1, openLo: true, openHi: true };
  });
  const differ = (a: number, b: number): number => (Math.abs(a - b) > 1e-6 ? a - b : 0);
  raw.sort(
    (a, b) =>
      differ(half(b), half(a)) || differ(b.u1 - b.u0, a.u1 - a.u0) || Number(b.alongX) - Number(a.alongX) ||
      differ(a.v0, b.v0) || differ(a.u0, b.u0),
  );

  /** Does this end of `s` stop inside `d` (which runs across it), beyond d's ridge? */
  const endsIn = (s: Wing, hi: boolean, d: Wing): boolean => {
    if (d.alongX === s.alongX) return false;
    if (s.v0 < d.u0 - E || s.v1 > d.u1 + E) return false;
    const ridge = (d.v0 + d.v1) / 2;
    return hi
      ? s.u1 >= ridge && s.u1 <= d.v1 + E && s.u0 < ridge - E
      : s.u0 <= ridge && s.u0 >= d.v0 - E && s.u1 > ridge + E;
  };
  const yields = (si: number, hi: boolean, di: number): boolean => {
    const s = raw[si];
    const d = raw[di];
    if (!endsIn(s, hi, d) || half(s) > half(d) + E) return false;
    // Corner to corner, either could give way: the lesser one does.
    const mutual = half(d) <= half(s) + E && (endsIn(d, true, s) || endsIn(d, false, s));
    return !mutual || si > di;
  };

  const out: (Wing & { dead?: boolean; loInto?: number; hiInto?: number })[] = raw.map((w) => ({ ...w }));
  for (let si = 0; si < raw.length; si++) {
    for (let di = 0; di < raw.length; di++) {
      if (si === di) continue;
      const ridge = (raw[di].v0 + raw[di].v1) / 2;
      const s = out[si];
      if (yields(si, true, di) && (s.openHi || ridge < s.u1)) {
        s.u1 = ridge;
        s.openHi = false;
        s.hiInto = di;
      }
      if (yields(si, false, di) && (s.openLo || ridge > s.u0)) {
        s.u0 = ridge;
        s.openLo = false;
        s.loInto = di;
      }
    }
  }

  // Same direction, inside a wider wing: only the part beyond it is needed.
  for (let si = 0; si < out.length; si++) {
    const s = out[si];
    for (let di = 0; di < si; di++) {
      const d = out[di];
      if (d.dead || d.alongX !== s.alongX || s.v0 < d.v0 - E || s.v1 > d.v1 + E) continue;
      const lo = s.u0 >= d.u0 - E && s.u0 < d.u1 - E;
      const hi = s.u1 <= d.u1 + E && s.u1 > d.u0 + E;
      if (lo && hi) s.dead = true;
      else if (lo) {
        s.u0 = d.u1;
        s.openLo = false;
        delete s.loInto;
      } else if (hi) {
        s.u1 = d.u0;
        s.openHi = false;
        delete s.hiInto;
      }
    }
  }

  // A cut end must still be under the wing it was cut into; otherwise it keeps its gable.
  out.forEach((s, si) => {
    const covered = (di: number | undefined): boolean =>
      di === undefined || (!out[di].dead && s.v0 >= out[di].u0 - E && s.v1 <= out[di].u1 + E);
    if (!covered(s.hiInto)) {
      s.u1 = raw[si].u1;
      s.openHi = true;
    }
    if (!covered(s.loInto)) {
      s.u0 = raw[si].u0;
      s.openLo = true;
    }
  });

  return out
    .filter((w) => !w.dead && w.u1 - w.u0 > 0.05)
    .map(({ alongX, u0, u1, v0, v1, openLo, openHi }) => ({ alongX, u0, u1, v0, v1, openLo, openHi }));
}

function gableWing(w: Wing, H: number, slope: number, roof: number[], walls: number[]): RoofRidge {
  const o = ROOF_OVERHANG;
  const t = PITCHED_SLAB;
  const at = (u: number, y: number, v: number): V3 => (w.alongX ? [u, y, v] : [v, y, u]);
  const dir = (du: number, dy: number, dv: number): V3 => (w.alongX ? [du, dy, dv] : [dv, dy, du]);
  const half = (w.v1 - w.v0) / 2;
  const vc = (w.v0 + w.v1) / 2;
  const rise = half * slope;
  const eaveY = H - o * slope;
  const ridgeY = H + rise;

  // The triangular wall under each open end, flush with the wall below.
  for (const [open, u, sign] of [[w.openLo, w.u0, -1], [w.openHi, w.u1, 1]] as const) {
    if (!open) continue;
    const n = dir(sign, 0, 0);
    face(walls, [at(u, H, w.v0), at(u, H, w.v1), at(u, ridgeY, vc)], n[0], n[1], n[2]);
  }

  // Two pitched slabs, running past the walls at the eaves and at open ends.
  const uA = w.openLo ? w.u0 - o : w.u0;
  const uB = w.openHi ? w.u1 + o : w.u1;
  for (const side of [-1, 1]) {
    const ve = side < 0 ? w.v0 - o : w.v1 + o;
    const up = dir(0, 1, 0);
    const down = dir(0, -1, 0);
    const outward = dir(0, 0, side);
    face(roof, [at(uA, eaveY + t, ve), at(uB, eaveY + t, ve), at(uB, ridgeY + t, vc), at(uA, ridgeY + t, vc)], up[0], up[1], up[2]);
    face(roof, [at(uA, eaveY, ve), at(uB, eaveY, ve), at(uB, ridgeY, vc), at(uA, ridgeY, vc)], down[0], down[1], down[2]);
    face(roof, [at(uA, eaveY, ve), at(uB, eaveY, ve), at(uB, eaveY + t, ve), at(uA, eaveY + t, ve)], outward[0], outward[1], outward[2]);
    for (const [u, sign] of [[uA, -1], [uB, 1]] as const) {
      const n = dir(sign, 0, 0);
      face(roof, [at(u, eaveY, ve), at(u, ridgeY, vc), at(u, ridgeY + t, vc), at(u, eaveY + t, ve)], n[0], n[1], n[2]);
    }
  }
  return { a: at(w.u0, ridgeY + t, vc), b: at(w.u1, ridgeY + t, vc), half, gableA: w.openLo, gableB: w.openHi };
}

function gableRoof(base: Region[], H: number, thickness: number): Built | null {
  const wallFace = growRegions(base, thickness / 2);
  const grid = regionGrid(wallFace);
  const wings = planWings(chooseWings(grid, maximalRects(grid)));
  if (wings.length === 0) return null;
  const widest = Math.max(...wings.map((w) => (w.v1 - w.v0) / 2));
  const slope = roofSlope(GABLE_PITCH, widest, H);
  const roof: number[] = [];
  const walls: number[] = [];
  const ridges = wings.map((w) => gableWing(w, H, slope, roof, walls));
  return {
    slabs: [],
    solids: [
      { part: 'gable', positions: walls },
      { part: 'roof', positions: roof },
    ],
    top: H + widest * slope + PITCHED_SLAB,
    slope,
    ridges,
    outline: growRegions(base, thickness / 2 + ROOF_OVERHANG),
  };
}

// ---------- hip ----------

function hipRoof(base: Region[], H: number, thickness: number): Built | null {
  const eaves = growRegions(base, thickness / 2 + ROOF_OVERHANG);
  const rects = maximalRects(regionGrid(eaves));
  if (rects.length === 0) return null;
  const halfOf = (r: CellRect): number => Math.min(r.x1 - r.x0, r.y1 - r.y0) / 2;
  const widest = Math.max(...rects.map(halfOf));
  const slope = roofSlope(HIP_PITCH, widest, H);
  const yb = H + EAVE_BAND;
  const faces: number[] = [];
  const ridges: RoofRidge[] = [];
  for (const r of rects) {
    const alongX = r.x1 - r.x0 >= r.y1 - r.y0;
    const at = (u: number, y: number, v: number): V3 => (alongX ? [u, y, v] : [v, y, u]);
    const [u0, u1, v0, v1] = alongX ? [r.x0, r.x1, r.y0, r.y1] : [r.y0, r.y1, r.x0, r.x1];
    const half = (v1 - v0) / 2;
    const vc = (v0 + v1) / 2;
    const yt = yb + half * slope;
    const a = at(u0, yb, v0);
    const b = at(u1, yb, v0);
    const c = at(u1, yb, v1);
    const d = at(u0, yb, v1);
    const e = at(u0 + half, yt, vc);
    const f = at(u1 - half, yt, vc);
    face(faces, [a, b, f, e], 0, 1, 0);
    face(faces, [c, d, e, f], 0, 1, 0);
    face(faces, [d, a, e], 0, 1, 0);
    face(faces, [b, c, f], 0, 1, 0);
    ridges.push({ a: e, b: f, half });
  }
  return {
    slabs: eaves.map((r) => ({ part: 'roof', poly: r.outer, holes: r.holes, y0: H, y1: yb })),
    solids: [{ part: 'roof', positions: faces }],
    top: yb + widest * slope,
    slope,
    ridges,
    outline: eaves,
  };
}

// ---------- outlines with angled walls ----------

/** Grow each building's outline (and shrink its courtyards) by `d`, backing off wherever that would tangle. */
function growFree(base: Region[], d: number): Region[] {
  return base.map((r) => ({
    outer: safeOffset(r.outer, d),
    holes: r.holes
      .map((h) => safeOffset(h, -d))
      .filter((h) => h.length >= 3 && Math.abs(signedArea(h)) > 0.05),
  }));
}

/** A hipped skirt rising from the eaves to a flat deck, for one building without courtyards. */
function skirtRoof(eave: Point[], H: number, pitch: number): Built | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of eave) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const reach = Math.min(x1 - x0, y1 - y0) / 2;
  if (!(reach > 0.4)) return null;
  const slope = roofSlope(pitch, reach, H);
  const area = Math.abs(signedArea(eave));
  const sign = Math.sign(signedArea(eave));
  const region: Region = { outer: eave, holes: [] };
  for (const k of [0.7, 0.5, 0.35, 0.22, 0.12]) {
    const run = reach * k;
    const deck = offsetLoop(eave, -run);
    if (deck.length !== eave.length || !isSimpleLoop(deck)) continue;
    const deckArea = signedArea(deck);
    if (Math.sign(deckArea) !== sign || Math.abs(deckArea) < area * 0.04) continue;
    if (!deck.every((p) => pointInRegion(p, region))) continue;
    // The skirt must not fold over itself between eave and deck.
    let clean = true;
    for (let i = 0; i < eave.length && clean; i++) {
      const j = (i + 1) % eave.length;
      const ex = eave[j].x - eave[i].x;
      const ey = eave[j].y - eave[i].y;
      if (ex * (deck[j].x - deck[i].x) + ey * (deck[j].y - deck[i].y) < 0) clean = false;
    }
    if (!clean) continue;
    const yb = H + EAVE_BAND;
    const yt = yb + run * slope;
    const faces: number[] = [];
    for (let i = 0; i < eave.length; i++) {
      const j = (i + 1) % eave.length;
      face(faces, [[eave[i].x, yb, eave[i].y], [eave[j].x, yb, eave[j].y], [deck[j].x, yt, deck[j].y], [deck[i].x, yt, deck[i].y]], 0, 1, 0);
    }
    return {
      slabs: [
        { part: 'roof', poly: eave, y0: H, y1: yb },
        { part: 'roof', poly: deck, y0: yt - 0.04, y1: yt },
      ],
      solids: [{ part: 'roof', positions: faces }],
      top: yt,
      slope,
      ridges: [],
      outline: [region],
    };
  }
  return null;
}

function freeRoof(kind: Exclude<RoofKind, 'none'>, base: Region[], H: number, thickness: number): Built {
  const grow = thickness / 2 + ROOF_OVERHANG;
  const built: Built[] = [];
  for (const region of base) {
    if (kind !== 'flat' && region.holes.length === 0) {
      const skirt = skirtRoof(safeOffset(region.outer, grow), H, kind === 'gable' ? GABLE_PITCH : HIP_PITCH);
      if (skirt) {
        built.push(skirt);
        continue;
      }
    }
    const deck = growFree([region], grow - FASCIA_WIDTH);
    built.push(flatRoof(deck, growFree([region], grow), H));
  }
  return mergeBuilt(built, H);
}

function mergeBuilt(parts: Built[], H: number): Built {
  const byPart = new Map<RoofPart, number[]>();
  for (const b of parts) {
    for (const s of b.solids) {
      const list = byPart.get(s.part);
      if (list) for (const v of s.positions) list.push(v);
      else byPart.set(s.part, s.positions.slice());
    }
  }
  return {
    slabs: parts.flatMap((b) => b.slabs),
    solids: [...byPart].map(([part, positions]) => ({ part, positions })),
    top: Math.max(H, ...parts.map((b) => b.top)),
    slope: Math.max(0, ...parts.map((b) => b.slope)),
    ridges: parts.flatMap((b) => b.ridges),
    outline: parts.flatMap((b) => b.outline),
  };
}

// ---------- entry ----------

function turn(built: Built, angle: number): Built {
  if (angle === 0) return built;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const point = (p: Point): Point => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
  const v3 = (v: V3): V3 => [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c];
  return {
    ...built,
    slabs: built.slabs.map((slab) => ({
      ...slab,
      poly: slab.poly.map(point),
      ...(slab.holes ? { holes: slab.holes.map((h) => h.map(point)) } : {}),
    })),
    solids: built.solids.map((solid) => {
      const positions = solid.positions.slice();
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const z = positions[i + 2];
        positions[i] = x * c - z * s;
        positions[i + 2] = x * s + z * c;
      }
      return { ...solid, positions };
    }),
    ridges: built.ridges.map((r) => ({ ...r, a: v3(r.a), b: v3(r.b) })),
    outline: rotateRegions(built.outline, angle),
  };
}

/** With no closed room there is no footprint: fall back to the box the walls span. */
function wallsBox(walls: Wall[]): Region[] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const w of walls) {
    for (const p of [w.a, w.b]) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  }
  if (!(x1 - x0 > 0.2) || !(y1 - y0 > 0.2)) return [];
  return [{ outer: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], holes: [] }];
}

/**
 * The roof for a plan. Returns an empty model for 'none', or when there is
 * nothing to put a roof on.
 *
 * Every roofed room is covered at the height of its own walls (levels.ts):
 * the rooms of each height are roofed together, each height on its own, so
 * separate buildings of 1, 2 and 4 levels each get their roof on top, and a
 * low wing joined to a tall one has its own roof running in under the tall
 * one's walls (which levels.ts carries up to close it in).
 */
export function buildRoof(kind: RoofKind, input: RoofInput): RoofModel {
  const H = input.settings.wallHeight;
  const thickness = input.settings.wallThickness;
  const empty: RoofModel = { kind: 'none', slabs: [], solids: [], top: H, eave: H, slope: 0, ridges: [], outline: [] };
  if (kind === 'none' || !Number.isFinite(H) || !Number.isFinite(thickness)) return empty;

  const indoor = input.rooms.filter((r) => !(r.key !== undefined && input.open?.has(r.key)));
  const levels = planLevels(input.walls, indoor, thickness);
  if (!levels.any) {
    const base = input.rooms.length > 0 ? roofFootprint(input.rooms, input.open) : wallsBox(input.walls);
    if (base.length === 0) return empty;
    return finish(kind, roofParts(kind, base, H, thickness), H) ?? empty;
  }

  // One roof per height, lowest first.
  const byHeight = new Map<number, Point[][]>();
  indoor.forEach((r, i) => {
    const level = levels.rooms[i] ?? 1;
    byHeight.set(level, [...(byHeight.get(level) ?? []), r.polygon]);
  });
  const groups: { eave: number; base: Region[] }[] = [];
  if (input.rooms.length === 0) groups.push({ eave: levels.max * H, base: wallsBox(input.walls) });
  for (const level of [...byHeight.keys()].sort((a, b) => a - b)) {
    groups.push({ eave: level * H, base: unionRegions(byHeight.get(level) ?? []) });
  }
  const parts: Built[] = [];
  const outlineEaves: number[] = [];
  for (const g of groups) {
    if (g.base.length === 0) continue;
    const part = roofParts(kind, g.base, g.eave, thickness);
    // Tiles are coursed from their own eave, and gutters look for open air beside roofs at their own height.
    parts.push({ ...part, solids: part.solids.map((s) => ({ ...s, eave: g.eave })) });
    for (let i = 0; i < part.outline.length; i++) outlineEaves.push(g.eave);
  }
  if (parts.length === 0) return empty;
  const lowest = groups.find((g) => g.base.length > 0)?.eave ?? H;
  const all: Built = {
    slabs: parts.flatMap((b) => b.slabs),
    solids: parts.flatMap((b) => b.solids),
    top: Math.max(...parts.map((b) => b.top)),
    slope: Math.max(0, ...parts.map((b) => b.slope)),
    ridges: parts.flatMap((b) => b.ridges),
    outline: parts.flatMap((b) => b.outline),
  };
  const model = finish(kind, all, lowest);
  return model ? { ...model, outlineEaves } : empty;
}

/** Drop anything degenerate; null when nothing is left to build. */
function finish(kind: RoofKind, built: Built, eave: number): RoofModel | null {
  const solids = built.solids.filter((s) => s.positions.length >= 9 && s.positions.every((v) => Number.isFinite(v)));
  const slabs = built.slabs.filter((s) => s.poly.length >= 3 && s.y1 > s.y0);
  if (solids.length === 0 && slabs.length === 0) return null;
  return { kind, slabs, solids, top: built.top, eave, slope: built.slope, ridges: built.ridges, outline: built.outline };
}

/** The roofs over buildings that all stand `H` high, merged into one. */
function roofParts(kind: Exclude<RoofKind, 'none'>, base: Region[], H: number, thickness: number): Built {
  // Buildings standing square to the same axes are roofed together; one with angled walls on its own.
  const square = new Map<number, Region[]>();
  const angled: Region[] = [];
  for (const region of base) {
    const angle = gridAngle([region]);
    if (angle === null) angled.push(region);
    else {
      const key = [...square.keys()].find((k) => Math.abs(k - angle) < 2e-3) ?? angle;
      square.set(key, [...(square.get(key) ?? []), region]);
    }
  }
  const parts: Built[] = [];
  const grow = thickness / 2 + ROOF_OVERHANG;
  for (const [angle, regions] of square) {
    const local = rotateRegions(regions, -angle);
    let part: Built | null = null;
    if (kind === 'gable') part = gableRoof(local, H, thickness);
    else if (kind === 'hip') part = hipRoof(local, H, thickness);
    part ??= flatRoof(growRegions(local, grow - FASCIA_WIDTH), growRegions(local, grow), H);
    parts.push(turn(part, angle));
  }
  if (angled.length > 0) parts.push(freeRoof(kind, angled, H, thickness));
  return mergeBuilt(parts, H);
}
