/**
 * Storeys, for the outside of a building. A wall may say how many levels it
 * rises (`Wall.levels`, a whole number 1–12; absent means 1): it stands that
 * many times the plan's wall height. Nothing else is stored. How high each
 * room's roof is, and which walls have to be carried up to close a taller
 * roof, are worked out here from the walls alone.
 *
 * Inside, a building stays one level: floors, ceilings, lamps, room details
 * and the walker all keep to `settings.wallHeight`. The levels above are the
 * building's shell, seen from outside.
 *
 * Pure: no three.js, no store.
 */
import { pointInPolygon } from './geometry';
import type { Point, Wall } from './types';

/** The most levels a wall can have. */
export const MAX_LEVELS = 12;

/** A stored levels value as the builders read it: a whole number from 1 to 12; anything else is 1. */
export function levelsOf(wall: Pick<Wall, 'levels'> | null | undefined): number {
  const v = wall?.levels;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(MAX_LEVELS, v) : 1;
}

/**
 * A levels value from outside (a file, a shared link) as it should be stored:
 * whole numbers above 1 are kept (capped at 12); 1 is the default and so left
 * out, and anything that is not a whole number of at least 1 is dropped.
 */
export function cleanLevels(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return undefined;
  return v > 1 ? Math.min(MAX_LEVELS, v) : undefined;
}

// ---------- finding things by position ----------

const CELL = 4;
const cellOf = (v: number): number => Math.floor(v / CELL);
const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;
/** A room or wall spanning more cells than this is checked everywhere rather than filed cell by cell. */
const MAX_CELLS = 4096;

interface Grid {
  cells: Map<string, number[]>;
  /** Too big to file: checked for every point. */
  always: number[];
}

function fileBoxes(boxes: (readonly [number, number, number, number] | null)[]): Grid {
  const cells = new Map<string, number[]>();
  const always: number[] = [];
  boxes.forEach((b, i) => {
    if (!b) return;
    const [x0, y0, x1, y1] = b;
    const c0 = cellOf(x0);
    const c1 = cellOf(x1);
    const r0 = cellOf(y0);
    const r1 = cellOf(y1);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS) {
      always.push(i);
      return;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = cellKey(c, r);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  });
  return { cells, always };
}

function near(grid: Grid, p: Point): number[] {
  const here = grid.cells.get(cellKey(cellOf(p.x), cellOf(p.y))) ?? [];
  return grid.always.length > 0 ? [...here, ...grid.always] : here;
}

function boxOf(pts: Point[], pad: number): readonly [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return x0 <= x1 ? [x0 - pad, y0 - pad, x1 + pad, y1 + pad] : null;
}

/**
 * Which room a point is in: the index of the first of `rooms` that holds it,
 * or −1. The same answer as testing every room in turn (a polygon never holds
 * a point outside its own bounding box), only without testing every room.
 */
export function roomLocator(rooms: readonly { polygon: Point[] }[]): (p: Point) => number {
  if (rooms.length === 0) return () => -1;
  const grid = fileBoxes(rooms.map((r) => (r.polygon.length >= 3 ? boxOf(r.polygon, 1e-6) : null)));
  return (p) => {
    let best = -1;
    for (const i of near(grid, p)) {
      // The first in the given order wins, as a plain search would have it.
      if ((best < 0 || i < best) && pointInPolygon(p, rooms[i].polygon)) best = i;
    }
    return best;
  };
}

// ---------- levels of rooms and walls ----------

export interface PlanLevels {
  /** Some wall rises above one level. When false, every wall and room is one level. */
  any: boolean;
  /**
   * How many levels a wall stands: its own, or more where it closes the side
   * of a taller roof (see `planLevels`).
   */
  wall: (w: Wall) => number;
  /** The levels of each room, in the order they were given. */
  rooms: number[];
  /** The tallest wall, in levels. */
  max: number;
}

const ONE: PlanLevels = { any: false, wall: () => 1, rooms: [], max: 1 };

const usable = (w: Wall): boolean =>
  !!w && !!w.a && !!w.b && Number.isFinite(w.a.x + w.a.y + w.b.x + w.b.y) && Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) >= 0.01;

/**
 * The levels of every roofed room and every wall.
 *
 *  - A room is as tall as the tallest of its walls that face outdoors: the
 *    outside walls say how high a building is. A room with no outside wall
 *    (a hall in the middle) takes the tallest room beside it.
 *  - A wall that stands between a taller room and something lower (outdoors,
 *    or a lower wing) is carried up to the taller room's roof, so a roof
 *    never sits over an open gap. Walls between rooms of the same height keep
 *    their own levels: a partition stays a partition.
 *
 * `rooms` are the rooms under a roof (open-air ones left out: they count as
 * outdoors). `locate` may be passed in when the caller already has one.
 */
export function planLevels(
  walls: readonly Wall[],
  rooms: readonly { polygon: Point[] }[],
  thickness: number,
  locate: (p: Point) => number = roomLocator(rooms),
): PlanLevels {
  const good = walls.filter(usable);
  const own = good.map((w) => levelsOf(w));
  if (!own.some((n) => n > 1)) return { ...ONE, rooms: rooms.map(() => 1) };

  const byId = new Map<string, number>();
  good.forEach((w, i) => byId.set(w.id, Math.max(byId.get(w.id) ?? 1, own[i])));
  const max = Math.max(...own);
  if (rooms.length === 0) return { any: true, wall: (w) => byId.get(w.id) ?? levelsOf(w), rooms: [], max };

  // Walls filed by where they run, to find the ones along a room's edge.
  const grid = fileBoxes(good.map((w) => boxOf([w.a, w.b], 0.05)));
  /** The walls lying along the stretch through `m` that runs in direction (ux, uy). */
  const wallsAlong = (m: Point, ux: number, uy: number): number[] => {
    const out: number[] = [];
    for (const i of near(grid, m)) {
      const w = good[i];
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const wx = (w.b.x - w.a.x) / len;
      const wy = (w.b.y - w.a.y) / len;
      if (Math.abs(ux * wy - uy * wx) > 0.02) continue;
      const t = (m.x - w.a.x) * wx + (m.y - w.a.y) * wy;
      if (t < -0.015 || t > len + 0.015) continue;
      if (Math.abs((m.x - w.a.x) * wy - (m.y - w.a.y) * wx) > 0.015) continue;
      out.push(i);
    }
    return out;
  };

  /** Every side of every room: the walls it lies on, and the room across it (−1 outdoors). */
  interface Side {
    walls: number[];
    across: number;
  }
  const probe = thickness / 2 + 0.06;
  const sides: Side[][] = rooms.map((room) => {
    const poly = room.polygon;
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      area += p.x * q.y - q.x * p.y;
    }
    const sign = area >= 0 ? 1 : -1;
    const out: Side[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > 0.02)) continue;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Outward for a positively wound loop in y-down plan space.
      // (A stub of wall poking into a room has the room on both sides: that side is not outdoors.)
      const q = { x: m.x + sign * uy * probe, y: m.y - sign * ux * probe };
      out.push({ walls: wallsAlong(m, ux, uy), across: locate(q) });
    }
    return out;
  });
  const tallest = (list: number[]): number => list.reduce((n, i) => Math.max(n, own[i]), 1);

  // Rooms: from their outside walls first, then inward from their neighbours.
  const level: (number | null)[] = sides.map((list) => {
    const outer = list.filter((s) => s.across < 0);
    return outer.length > 0 ? Math.max(...outer.map((s) => tallest(s.walls))) : null;
  });
  for (let changed = true; changed; ) {
    changed = false;
    level.forEach((l, ri) => {
      if (l !== null) return;
      const known = sides[ri].map((s) => (s.across >= 0 ? level[s.across] : null)).filter((n): n is number => n !== null);
      if (known.length === 0) return;
      level[ri] = Math.max(...known);
      changed = true;
    });
  }
  const roomLevels = level.map((l, ri) => l ?? Math.max(1, ...sides[ri].map((s) => tallest(s.walls))));

  // Walls: carried up wherever a taller room meets something lower across them.
  const raised = own.slice();
  sides.forEach((list, ri) => {
    const mine = roomLevels[ri];
    for (const s of list) {
      const other = s.across >= 0 ? roomLevels[s.across] : 0;
      if (mine <= other) continue;
      for (const i of s.walls) raised[i] = Math.max(raised[i], mine);
    }
  });
  good.forEach((w, i) => byId.set(w.id, Math.max(byId.get(w.id) ?? 1, raised[i])));
  return { any: true, wall: (w) => byId.get(w.id) ?? levelsOf(w), rooms: roomLevels, max: Math.max(max, ...raised) };
}
