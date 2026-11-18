/**
 * Selecting several things at once: any mix of walls, doors and windows, and
 * furniture, and what a dragged rectangle holds. Pure — no store, no DOM —
 * so the rules can be tested on plain data; `actions.ts` and the canvas do
 * the wiring.
 */
import type { FurnitureKind } from '../../catalog';
import { dist, rectCorners } from '../../geometry';
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

/** Is `p` in the box (its edge counts)? */
export function inBox(p: Point, box: Box): boolean {
  const e = 1e-6;
  return (
    finite(p.x, p.y, box.x0, box.y0, box.x1, box.y1) &&
    p.x >= box.x0 - e &&
    p.x <= box.x1 + e &&
    p.y >= box.y0 - e &&
    p.y <= box.y1 + e
  );
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
 * Everything wholly inside the rectangle: a wall or an opening with both ends
 * in it, furniture with its whole footprint in it. Only whole things, because
 * walls are split where they meet: a box round one room would otherwise also
 * take the pieces of its neighbours' walls that meet its corners. Ids come out
 * in plan order, so the same rectangle always gives the same selection.
 */
export function marqueeHits(
  plan: Pick<PlanData, 'walls' | 'openings' | 'furniture'>,
  box: Box,
  sizeOf: (kind: FurnitureKind) => { w: number; d: number },
): PlanSelection {
  const inside = (p: Point) => inBox(p, box);
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  return {
    walls: plan.walls.filter((w) => inside(w.a) && inside(w.b)).map((w) => w.id),
    openings: plan.openings
      .filter((o) => {
        const wall = wallById.get(o.wallId);
        const span = wall ? openingSpan(o, wall) : null;
        return !!span && span.every(inside);
      })
      .map((o) => o.id),
    furniture: plan.furniture
      .filter((f) => {
        const { w, d } = sizeOf(f.kind);
        if (!finite(f.x, f.y, f.rotation, w, d)) return false;
        return rectCorners(f.x, f.y, w, d, f.rotation).every(inside);
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
