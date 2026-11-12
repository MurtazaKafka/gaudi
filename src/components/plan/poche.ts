/**
 * Walls as poché for the canvas: the true-thickness wall body (from the tested
 * tiler in export/walls.ts) reshaped into what the drawing needs — fill loops,
 * each wall's own pieces for hover and selection, the footprint the house
 * casts its shadow from, and the front door. Pure: no store, no DOM.
 */
import { buildWallBody, loopArea, type WallBody, type WallGap } from '../../export/walls';
import { pointInPolygon } from '../../geometry';
import { roomKindFromName } from '../../roomTypes';
import type { Opening, Point, Wall } from '../../types';

export interface Poche {
  body: WallBody;
  /** Outlines of the wall body, flat [x0, y0, x1, y1, …]; fill with the non-zero rule. */
  loops: number[][];
  /** Each wall's own pieces of the body (flat outlines), mitred into its joints. */
  tilesOf: Map<string, number[][]>;
}

const flat = (pts: Point[]): number[] => {
  const out: number[] = [];
  for (const p of pts) out.push(p.x, p.y);
  return out;
};

export function buildPoche(walls: Wall[], openings: Opening[], thickness: number): Poche {
  const body = buildWallBody(walls, openings, thickness);
  const tilesOf = new Map<string, number[][]>();
  for (const t of body.tiles) {
    if (t.poly.length < 3) continue;
    const list = tilesOf.get(t.wallId);
    if (list) list.push(flat(t.poly));
    else tilesOf.set(t.wallId, [flat(t.poly)]);
  }
  return { body, loops: body.loops.map(flat), tilesOf };
}

// One entry per walls array: a drag replaces the array, a mouse move does not.
const pocheCache = new WeakMap<Wall[], { openings: Opening[]; thickness: number; poche: Poche }>();

/** `buildPoche`, remembered for the last (walls, openings, thickness) it was asked for. */
export function pocheFor(walls: Wall[], openings: Opening[], thickness: number): Poche {
  const hit = pocheCache.get(walls);
  if (hit && hit.openings === openings && hit.thickness === thickness) return hit.poche;
  const poche = buildPoche(walls, openings, thickness);
  pocheCache.set(walls, { openings, thickness, poche });
  return poche;
}

/** The loop turned so its signed area is positive (so several can be unioned with the non-zero rule). */
function positive(loop: Point[]): Point[] {
  return loopArea(loop) < 0 ? loop.slice().reverse() : loop;
}

/**
 * Everything the building covers, as flat outlines that union under the
 * non-zero rule: the outside of the wall body (doors and windows closed) plus
 * every room. An unclosed outline is just its walls.
 */
export function footprintLoops(walls: Wall[], thickness: number, rooms: Point[][]): number[][] {
  const solid = buildWallBody(walls, [], thickness);
  const out: number[][] = [];
  if (solid.loops.length > 0) {
    if (solid.clean) {
      // Outer boundaries wind one way, the holes (room interiors) the other;
      // the largest loop is always an outer boundary.
      let big = solid.loops[0];
      for (const l of solid.loops) if (Math.abs(loopArea(l)) > Math.abs(loopArea(big))) big = l;
      const sign = Math.sign(loopArea(big)) || 1;
      for (const l of solid.loops) if (Math.sign(loopArea(l)) === sign) out.push(flat(positive(l)));
    } else {
      for (const l of solid.loops) out.push(flat(positive(l)));
    }
  }
  for (const r of rooms) if (r.length >= 3) out.push(flat(positive(r)));
  return out;
}

const footprintCache = new WeakMap<Wall[], { thickness: number; rooms: Point[][]; loops: number[][] }>();

export function footprintFor(walls: Wall[], thickness: number, rooms: Point[][]): number[][] {
  const hit = footprintCache.get(walls);
  if (hit && hit.thickness === thickness && hit.rooms === rooms) return hit.loops;
  const loops = footprintLoops(walls, thickness, rooms);
  footprintCache.set(walls, { thickness, rooms, loops });
  return loops;
}

// ---------- the front door ----------

export interface EntranceRoom {
  polygon: Point[];
  name?: string | null;
}

export interface Entrance {
  openingId: string;
  /** Tip of the marker: just outside the door, clear of its swing. */
  at: Point;
  /** Unit vector pointing into the house. */
  inward: Point;
}

/** Length of the entrance marker (m): sized with the drawing, but never too small to see nor too big to be quiet. */
export const entranceMarkerSize = (scale: number): number => Math.min(13 / scale, Math.max(7 / scale, 0.2));

const ENTRANCE_WORDS =/\b(entrance|entry|front|main)\b/i;
/** How far outside the wall face (or the swung leaf) the marker's tip sits, m. */
const ENTRANCE_CLEAR = 0.2;

/**
 * The door a visitor would use: an outside door (a room on one side only).
 * When there are several, one labelled as the entrance wins, then one opening
 * into a hall, then into a living space, then the first drawn.
 */
export function findEntrance(gaps: WallGap[], rooms: EntranceRoom[], thickness: number): Entrance | null {
  const half = Math.max(0, thickness) / 2;
  let best: { score: number; entrance: Entrance } | null = null;
  for (const g of gaps) {
    if (g.type !== 'door') continue;
    const probe = (sign: number): Point => ({
      x: g.center.x + g.normal.x * sign * (half + 0.15),
      y: g.center.y + g.normal.y * sign * (half + 0.15),
    });
    const plus = rooms.find((r) => pointInPolygon(probe(1), r.polygon));
    const minus = rooms.find((r) => pointInPolygon(probe(-1), r.polygon));
    if (!!plus === !!minus) continue; // an inside door, or a door in a wall that encloses nothing
    const inside = plus ?? minus;
    const out = plus ? -1 : 1; // which way along `normal` is outside
    const kind = roomKindFromName(inside?.name);
    const score =
      (g.label && ENTRANCE_WORDS.test(g.label) ? 8 : 0) +
      (kind === 'circulation' ? 4 : kind === 'living' ? 2 : kind === 'kitchen' || kind === 'dining' ? 1 : 0);
    if (best && best.score >= score) continue;
    // The leaf swings to the −normal side (as drawn); stay clear of it when that is outside.
    const reach = half + (out === -1 ? g.width : 0) + ENTRANCE_CLEAR;
    best = {
      score,
      entrance: {
        openingId: g.id,
        at: { x: g.center.x + g.normal.x * out * reach, y: g.center.y + g.normal.y * out * reach },
        inward: { x: -g.normal.x * out, y: -g.normal.y * out },
      },
    };
  }
  return best ? best.entrance : null;
}
