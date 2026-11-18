/**
 * Drafting math for the plan editor: angle lock, typed lengths, moving walls
 * and openings, where dimension labels sit. Pure — no store, no DOM — so it
 * can be tested on its own.
 */
import type { Opening, Point, Units, Wall } from '../../types';
import type { EndpointRef } from '../../store';
import {
  dist,
  distToSegment,
  EPS,
  pointInPolygon,
  ptEq,
  snapPoint,
  type SnapResult,
} from '../../geometry';

/** Shift locks a segment to multiples of this. */
export const ANGLE_STEP = Math.PI / 12;
/** Margin kept between openings and wall ends / each other (mirrors store.ts). */
export const OPENING_GAP = 0.05;
/** Shortest wall a typed length may produce. */
export const MIN_WALL = 0.05;

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const safeGrid = (g: number): number => (Number.isFinite(g) && g > 0 ? g : 0.5);

/** cos/sin of a snapped angle, with the float fuzz around 0 and ±1 removed. */
function tidy(v: number): number {
  if (Math.abs(v) < 1e-12) return 0;
  if (Math.abs(v - 1) < 1e-12) return 1;
  if (Math.abs(v + 1) < 1e-12) return -1;
  return v;
}

/** Direction from `anchor` toward `raw` snapped to `step`, and the length projected onto it. */
export function constrainToAngle(
  anchor: Point,
  raw: Point,
  step = ANGLE_STEP,
): { dir: Point; length: number } {
  const dx = raw.x - anchor.x;
  const dy = raw.y - anchor.y;
  if (Math.hypot(dx, dy) < EPS) return { dir: { x: 1, y: 0 }, length: 0 };
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  const dir = { x: tidy(Math.cos(ang)), y: tidy(Math.sin(ang)) };
  return { dir, length: Math.max(0, dx * dir.x + dy * dir.y) };
}

export interface DraftSnapOptions {
  walls: Wall[];
  grid: number;
  /** endpoint snap radius, m */ radius: number;
  /** Start of the segment being drawn, if any. */
  anchor?: Point | null;
  /** Lock the segment from `anchor` to 15° steps (Shift). */
  constrain?: boolean;
}

/**
 * Where a click would land while drawing or measuring. Unconstrained: endpoints
 * win, then the grid. Constrained: the direction locks to 15° steps and the
 * length to whole grid steps — unless an existing corner sits on that line near
 * the cursor, in which case it wins so rooms still close exactly.
 */
export function resolveDraftPoint(raw: Point, o: DraftSnapOptions): SnapResult {
  const grid = safeGrid(o.grid);
  if (!o.anchor || !o.constrain) return snapPoint(raw, o.walls, grid, o.radius);
  const a = o.anchor;
  const { dir, length } = constrainToAngle(a, raw);

  let best: Point | null = null;
  let bestD = o.radius;
  for (const w of o.walls) {
    for (const e of [w.a, w.b]) {
      const t = (e.x - a.x) * dir.x + (e.y - a.y) * dir.y;
      if (t <= EPS) continue;
      const off = Math.abs((e.x - a.x) * dir.y - (e.y - a.y) * dir.x);
      if (off > 1e-3) continue;
      const d = Math.abs(t - length);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  if (best) return { p: { ...best }, kind: 'endpoint' };

  const len = Math.round(length / grid) * grid;
  return { p: { x: r6(a.x + dir.x * len), y: r6(a.y + dir.y * len) }, kind: 'grid' };
}

/** The point `length` from `anchor` toward `toward` (or along `fallback` when there is no direction yet). */
export function pointAlong(
  anchor: Point,
  toward: Point | null,
  length: number,
  fallback: Point | null = null,
): Point {
  let dx = 1;
  let dy = 0;
  if (toward && dist(anchor, toward) > EPS) {
    dx = toward.x - anchor.x;
    dy = toward.y - anchor.y;
  } else if (fallback && Math.hypot(fallback.x, fallback.y) > EPS) {
    dx = fallback.x;
    dy = fallback.y;
  }
  const n = Math.hypot(dx, dy);
  return { x: r6(anchor.x + (dx / n) * length), y: r6(anchor.y + (dy / n) * length) };
}

/**
 * Feed one key into the typed-length buffer. Returns the new buffer, or null
 * when the key isn't part of a length (so it keeps its normal meaning).
 * A length starts with a digit or a point; once started, the unit letters
 * (m, cm, ft, in) and foot/inch marks are accepted too ("3.5m", "350cm", "12'6").
 */
export function typedLengthKey(buffer: string, key: string): string | null {
  if (key === 'Backspace') return buffer ? buffer.slice(0, -1) : null;
  if (key.length !== 1) return null;
  const ok = buffer ? /^[0-9.'"′″cmftin]$/i.test(key) : /^[0-9.]$/.test(key);
  if (!ok) return null;
  return buffer.length >= 12 ? buffer : buffer + key;
}

/** Every wall end that sits on `p` — the junction that moves together. */
export function junctionRefs(walls: Wall[], p: Point): EndpointRef[] {
  const refs: EndpointRef[] = [];
  for (const w of walls) {
    if (ptEq(w.a, p)) refs.push({ wallId: w.id, end: 'a' });
    if (ptEq(w.b, p)) refs.push({ wallId: w.id, end: 'b' });
  }
  return refs;
}

/** New position of a wall's B end when the wall is set to `length`, A staying put. */
export function resizedEnd(wall: Wall, length: number): Point | null {
  const len = dist(wall.a, wall.b);
  if (len < EPS || !(length > 0)) return null;
  const k = length / len;
  return { x: r6(wall.a.x + (wall.b.x - wall.a.x) * k), y: r6(wall.a.y + (wall.b.y - wall.a.y) * k) };
}

/**
 * How far a wall moves when its body is dragged by `drag`: only across itself,
 * snapped so axis-aligned walls land on grid lines and angled ones move in
 * whole grid steps.
 */
export function perpendicularDelta(wall: Wall, drag: Point, grid: number): Point {
  const g = safeGrid(grid);
  const len = dist(wall.a, wall.b);
  if (len < EPS) return { x: 0, y: 0 };
  const ux = (wall.b.x - wall.a.x) / len;
  const uy = (wall.b.y - wall.a.y) / len;
  if (Math.abs(ux) < 1e-9) {
    return { x: r6(Math.round((wall.a.x + drag.x) / g) * g - wall.a.x), y: 0 };
  }
  if (Math.abs(uy) < 1e-9) {
    return { x: 0, y: r6(Math.round((wall.a.y + drag.y) / g) * g - wall.a.y) };
  }
  const nx = -uy;
  const ny = ux;
  const s = Math.round((drag.x * nx + drag.y * ny) / g) * g;
  return { x: r6(nx * s), y: r6(ny * s) };
}

/** The intervals an opening of `width` may have its center in, given the wall and its other openings. */
export function openingSlots(
  openings: Opening[],
  wall: Wall,
  width: number,
  ignoreId?: string,
): [number, number][] {
  const len = dist(wall.a, wall.b);
  const half = width / 2 + OPENING_GAP;
  if (len - half < half) return [];
  let slots: [number, number][] = [[half, len - half]];
  for (const o of openings) {
    if (o.wallId !== wall.id || o.id === ignoreId) continue;
    const reach = (o.width + width) / 2 + OPENING_GAP + 1e-9;
    const lo = o.offset - reach;
    const hi = o.offset + reach;
    slots = slots.flatMap(([a, b]) => {
      const out: [number, number][] = [];
      if (lo >= a) out.push([a, Math.min(b, lo)]);
      if (hi <= b) out.push([Math.max(a, hi), b]);
      return out;
    });
  }
  return slots;
}

/**
 * Where an opening ends up when dragged toward `desired` (m from wall end A):
 * snapped to `step`, kept on the wall, stopped by its neighbours (it hops over
 * one once the pointer is clearly past). Null when it fits nowhere.
 */
export function slideOpening(
  openings: Opening[],
  wall: Wall,
  id: string | undefined,
  width: number,
  desired: number,
  step = 0,
): number | null {
  const slots = openingSlots(openings, wall, width, id);
  const want = step > 0 ? Math.round(desired / step) * step : desired;
  let best: number | null = null;
  let bestD = Infinity;
  for (const [a, b] of slots) {
    const c = Math.min(b, Math.max(a, want));
    const d = Math.abs(c - desired);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Unit normal of a wall, chosen to point up the screen (left for vertical walls). */
export function wallNormal(wall: Wall): Point {
  const len = dist(wall.a, wall.b);
  if (len < EPS) return { x: 0, y: -1 };
  let nx = (wall.b.y - wall.a.y) / len;
  let ny = -(wall.b.x - wall.a.x) / len;
  if (ny > 1e-9 || (Math.abs(ny) <= 1e-9 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  return { x: tidy(nx), y: tidy(ny) };
}

/**
 * Which side of a wall its length label goes on, as a multiplier for
 * `wallNormal`: outside the building when the wall has a room on exactly one
 * side, otherwise the up/left side.
 */
export function dimensionSide(wall: Wall, rooms: Point[][]): 1 | -1 {
  const n = wallNormal(wall);
  const mx = (wall.a.x + wall.b.x) / 2;
  const my = (wall.a.y + wall.b.y) / 2;
  const probe = 0.12;
  const plus = { x: mx + n.x * probe, y: my + n.y * probe };
  const minus = { x: mx - n.x * probe, y: my - n.y * probe };
  const inPlus = rooms.some((r) => pointInPolygon(plus, r));
  const inMinus = rooms.some((r) => pointInPolygon(minus, r));
  return inPlus && !inMinus ? -1 : 1;
}

/** Center and reading angle (degrees, never upside-down) for a label `offset` meters off a wall's centerline. */
export function labelPose(
  wall: Wall,
  side: 1 | -1,
  offset: number,
): { x: number; y: number; rotation: number } {
  const n = wallNormal(wall);
  let deg = (Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x) * 180) / Math.PI;
  if (deg >= 90 - 1e-6) deg -= 180;
  else if (deg < -90 - 1e-6) deg += 180;
  return {
    x: (wall.a.x + wall.b.x) / 2 + n.x * side * offset,
    y: (wall.a.y + wall.b.y) / 2 + n.y * side * offset,
    rotation: deg,
  };
}

/** Rotation folded into [0, 2π) with quarter turns made exact, so repeated R never drifts. */
export function normAngle(r: number): number {
  const full = Math.PI * 2;
  let a = r % full;
  if (a < 0) a += full;
  const q = Math.round(a / (Math.PI / 2));
  if (Math.abs(a - (q * Math.PI) / 2) < 1e-6) a = ((q % 4) * Math.PI) / 2;
  return a;
}

/** The fine step furniture and openings snap to: 5 cm, or 2 in when working in feet. */
export function fineStep(units: Units): number {
  return units === 'ft' ? 0.0508 : 0.05;
}

export function snapTo(v: number, step: number): number {
  return step > 0 ? r6(Math.round(v / step) * step) : v;
}

export function snapPointTo(p: Point, step: number): Point {
  return { x: snapTo(p.x, step), y: snapTo(p.y, step) };
}

/**
 * How far a drag has moved things: the pointer's travel `raw` (plan meters)
 * snapped to `step`; with `lock`, kept to the axis it mostly runs along.
 */
export function dragDelta(raw: Point, step: number, lock: boolean): Point {
  const d = lock ? (Math.abs(raw.x) >= Math.abs(raw.y) ? { x: raw.x, y: 0 } : { x: 0, y: raw.y }) : raw;
  return snapPointTo(d, step);
}

/** Arrow key → a move of `step` in plan space (y grows down the screen). */
export function arrowDelta(key: string, step: number): Point | null {
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    default:
      return null;
  }
}

export interface JunctionGroup {
  /** Every wall end sitting on `from` when the move began. */
  refs: EndpointRef[];
  from: Point;
}

/**
 * The junctions that travel with `wallIds` when they are moved: their own
 * ends, plus the ends of other walls resting on their bodies (T-junctions).
 * Frozen once at the start of a move so a junction shared by two moved walls
 * moves once and walls merely passed over are never picked up.
 */
export function wallMoveGroups(walls: Wall[], wallIds: string[]): JunctionGroup[] {
  const moved = walls.filter((w) => wallIds.includes(w.id));
  const points: Point[] = [];
  const add = (p: Point) => {
    if (!points.some((q) => ptEq(p, q))) points.push({ ...p });
  };
  for (const w of moved) {
    add(w.a);
    add(w.b);
  }
  for (const w of walls) {
    if (wallIds.includes(w.id)) continue;
    for (const p of [w.a, w.b]) {
      if (moved.some((m) => dist(m.a, m.b) > EPS && distToSegment(p, m.a, m.b) < 1e-6)) add(p);
    }
  }
  return points.map((from) => ({ refs: junctionRefs(walls, from), from }));
}

/** Where a junction group lands after moving by `delta`. */
export function movedPoint(from: Point, delta: Point): Point {
  return { x: r6(from.x + delta.x), y: r6(from.y + delta.y) };
}

export interface OpeningSpot {
  offset: number;
  valid: boolean;
}

/**
 * Where a new opening of `width` would land for a pointer `desired` meters
 * along the wall: the nearest free spot when one is within reach, otherwise
 * the pointer position marked invalid (drawn as a red ghost).
 */
export function placeOpening(
  openings: Opening[],
  wall: Wall,
  width: number,
  desired: number,
  reach = Math.max(0.3, width / 2),
): OpeningSpot {
  const len = dist(wall.a, wall.b);
  const spot = slideOpening(openings, wall, undefined, width, desired);
  if (spot !== null && Math.abs(spot - desired) <= reach + 1e-9) return { offset: spot, valid: true };
  const half = width / 2;
  const offset = len < width ? len / 2 : Math.min(Math.max(desired, half), len - half);
  return { offset, valid: false };
}

/** Radius (m) of the circle around a w×d footprint — how far an item reaches at any rotation. */
export function footprintRadius(w: number, d: number): number {
  return Math.hypot(w, d) / 2;
}
