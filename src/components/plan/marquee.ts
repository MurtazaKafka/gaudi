/**
 * Selecting several things at once: any mix of walls, doors and windows, and
 * furniture, and what a dragged rectangle touches. Pure — no store, no DOM —
 * so the rules can be tested on plain data; `actions.ts` and the canvas do
 * the wiring.
 */
import type { FurnitureKind } from '../../catalog';
import { dist, quadsOverlap, rectCorners } from '../../geometry';
import type { Opening, PlanData, Point, Wall } from '../../types';

/** What is selected on the plan: any mix of walls, doors/windows and furniture. */
export interface PlanSelection {
  walls: string[];
  openings: string[];
  furniture: string[];
}

export const NO_SELECTION: PlanSelection = { walls: [], openings: [], furniture: [] };

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export const sameSelection = (a: PlanSelection, b: PlanSelection): boolean =>
  sameIds(a.walls, b.walls) && sameIds(a.openings, b.openings) && sameIds(a.furniture, b.furniture);

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/** Everything in either selection, each id once. */
export function mergeSelection(a: PlanSelection, b: PlanSelection): PlanSelection {
  return {
    walls: union(a.walls, b.walls),
    openings: union(a.openings, b.openings),
    furniture: union(a.furniture, b.furniture),
  };
}

/** `sel` with `id` added to (or, if it is there, taken out of) one kind. */
export function toggleInSelection(sel: PlanSelection, kind: keyof PlanSelection, id: string): PlanSelection {
  const ids = sel[kind];
  return { ...sel, [kind]: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] };
}

// ---------- the rectangle ----------

/** An axis-aligned rectangle in plan meters, corners in order. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The rectangle between two opposite corners, whichever way it was dragged. */
export function boxOf(a: Point, b: Point): Box {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

const finite = (...v: number[]): boolean => v.every(Number.isFinite);

/** Does the segment a→b lie in, cross or touch the box? (Liang–Barsky clipping.) */
export function segmentTouchesBox(a: Point, b: Point, box: Box): boolean {
  if (!finite(a.x, a.y, b.x, b.y, box.x0, box.y0, box.x1, box.y1)) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  // Each side of the box: p·t <= q keeps the part of the segment on its inner side.
  const sides: [number, number][] = [
    [-dx, a.x - box.x0],
    [dx, box.x1 - a.x],
    [-dy, a.y - box.y0],
    [dy, box.y1 - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false; // parallel to this side and outside it
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}

/** The two ends of an opening on its wall, or null when the wall has no length. */
function openingSpan(o: Opening, wall: Wall): [Point, Point] | null {
  const len = dist(wall.a, wall.b);
  if (!(len > 1e-6) || !finite(o.offset, o.width)) return null;
  const ux = (wall.b.x - wall.a.x) / len;
  const uy = (wall.b.y - wall.a.y) / len;
  const from = Math.max(0, Math.min(len, o.offset - o.width / 2));
  const to = Math.max(0, Math.min(len, o.offset + o.width / 2));
  return [
    { x: wall.a.x + ux * from, y: wall.a.y + uy * from },
    { x: wall.a.x + ux * to, y: wall.a.y + uy * to },
  ];
}

/**
 * Everything the rectangle touches, as on a desktop: a wall or an opening it
 * crosses or holds, furniture whose footprint it overlaps. Ids come out in
 * plan order, so the same rectangle always gives the same selection.
 */
export function marqueeHits(
  plan: Pick<PlanData, 'walls' | 'openings' | 'furniture'>,
  box: Box,
  sizeOf: (kind: FurnitureKind) => { w: number; d: number },
): PlanSelection {
  const corners: Point[] = [
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x1, y: box.y1 },
    { x: box.x0, y: box.y1 },
  ];
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  return {
    walls: plan.walls.filter((w) => segmentTouchesBox(w.a, w.b, box)).map((w) => w.id),
    openings: plan.openings
      .filter((o) => {
        const wall = wallById.get(o.wallId);
        const span = wall ? openingSpan(o, wall) : null;
        return !!span && segmentTouchesBox(span[0], span[1], box);
      })
      .map((o) => o.id),
    furniture: plan.furniture
      .filter((f) => {
        const { w, d } = sizeOf(f.kind);
        if (!finite(f.x, f.y, f.rotation, w, d)) return false;
        return quadsOverlap(rectCorners(f.x, f.y, w, d, f.rotation), corners);
      })
      .map((f) => f.id),
  };
}

/** The selection with ids that are no longer in the plan left out. */
export function liveSelection(
  plan: Pick<PlanData, 'walls' | 'openings' | 'furniture'>,
  sel: PlanSelection,
): PlanSelection {
  const has = (list: { id: string }[]) => {
    const ids = new Set(list.map((x) => x.id));
    return (id: string) => ids.has(id);
  };
  return {
    walls: sel.walls.filter(has(plan.walls)),
    openings: sel.openings.filter(has(plan.openings)),
    furniture: sel.furniture.filter(has(plan.furniture)),
  };
}

// ---------- the click that ends a drag ----------

let swallowing = false;

/**
 * To the canvas library, the release that ends a drag the canvas handles
 * itself (a selection rectangle, the whole selection moving) is also a click
 * on whatever is under the pointer. Call this as the drag ends and that one
 * click is ignored (see `clickSwallowed`).
 */
export function swallowNextClick(): void {
  swallowing = true;
  window.setTimeout(() => {
    swallowing = false;
  }, 0);
}

export const clickSwallowed = (): boolean => swallowing;
