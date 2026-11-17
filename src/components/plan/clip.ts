/**
 * Copying part of a plan and pasting it back: what a selection is as a copy,
 * and what a paste adds. Pure — no store, no DOM — so the rules can be tested
 * on plain data; `actions.ts` does the wiring.
 */
import { isCustomKind, customId, type FurnitureKind } from '../../catalog';
import { ptEq } from '../../geometry';
import type { CustomItem, Furniture, Opening, PlanData, Point, Wall } from '../../types';
import type { PlanSelection } from './marquee';

const finite = (...v: number[]): boolean => v.every(Number.isFinite);

/** A copied piece of a plan. Self-contained: it can be pasted into another plan. */
export interface Clip {
  walls: Wall[];
  /** Every door and window on the copied walls: a wall is copied with its openings. */
  openings: Opening[];
  furniture: Furniture[];
  /** Names of the rooms whose walls were all copied, by room key. */
  roomNames: Record<string, string>;
  /** Definitions of the custom furniture in it. */
  customItems: Record<string, CustomItem>;
  /** The middle of everything copied. */
  center: Point;
}

/**
 * The selection as a copy, or null when there is nothing in it that can stand
 * on its own (a door or window alone cannot: it needs its wall).
 */
export function clipOf(plan: PlanData, sel: PlanSelection): Clip | null {
  const wallIds = new Set(sel.walls);
  const itemIds = new Set(sel.furniture);
  const walls = plan.walls.filter((w) => wallIds.has(w.id)).map((w) => ({ id: w.id, a: { ...w.a }, b: { ...w.b } }));
  const furniture = plan.furniture.filter((f) => itemIds.has(f.id)).map((f) => ({ ...f }));
  if (!walls.length && !furniture.length) return null;

  const copied = new Set(walls.map((w) => w.id));
  const openings = plan.openings.filter((o) => copied.has(o.wallId)).map((o) => ({ ...o }));

  const roomNames: Record<string, string> = {};
  for (const [key, name] of Object.entries(plan.roomNames)) {
    // A key is the room's wall ids; one with a '#' tells apart two rooms on the same walls and cannot be carried.
    if (key.includes('#')) continue;
    if (key.split('|').every((id) => copied.has(id))) roomNames[key] = name;
  }

  const customItems: Record<string, CustomItem> = {};
  for (const f of furniture) {
    if (!isCustomKind(f.kind)) continue;
    const id = customId(f.kind);
    if (Object.hasOwn(plan.customItems, id)) customItems[id] = plan.customItems[id];
  }

  const xs = [...walls.flatMap((w) => [w.a.x, w.b.x]), ...furniture.map((f) => f.x)];
  const ys = [...walls.flatMap((w) => [w.a.y, w.b.y]), ...furniture.map((f) => f.y)];
  const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  return { walls, openings, furniture, roomNames, customItems, center };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

const sameWall = (w: Wall, a: Point, b: Point): boolean =>
  (ptEq(w.a, a) && ptEq(w.b, b)) || (ptEq(w.a, b) && ptEq(w.b, a));

/** What a paste adds to a plan, and what to select afterwards. */
export interface Pasted {
  walls: Wall[];
  openings: Opening[];
  furniture: Furniture[];
  /** Room names for the pasted rooms, by their new keys. */
  roomNames: Record<string, string>;
  /** Custom furniture definitions the plan did not have yet. */
  customItems: Record<string, CustomItem>;
  selection: PlanSelection;
}

/**
 * `clip` moved by `delta`, ready to add to `plan`: everything gets a new id,
 * a wall that would lie exactly on one already there is left out (with its
 * openings), and furniture whose definition neither side has is left out.
 * The plan is not touched.
 */
export function pasteClip(
  plan: Pick<PlanData, 'walls' | 'customItems'>,
  clip: Clip,
  delta: Point,
  newId: () => string,
  isKnownKind: (kind: FurnitureKind) => boolean,
): Pasted {
  const move = (p: Point): Point => ({ x: r3(p.x + delta.x), y: r3(p.y + delta.y) });

  const walls: Wall[] = [];
  const wallIds = new Map<string, string>();
  for (const w of clip.walls) {
    const a = move(w.a);
    const b = move(w.b);
    if (!finite(a.x, a.y, b.x, b.y) || ptEq(a, b)) continue;
    if (plan.walls.some((x) => sameWall(x, a, b)) || walls.some((x) => sameWall(x, a, b))) continue;
    const id = newId();
    wallIds.set(w.id, id);
    walls.push({ id, a, b });
  }

  const openings: Opening[] = [];
  for (const o of clip.openings) {
    const wallId = wallIds.get(o.wallId);
    if (wallId) openings.push({ ...o, id: newId(), wallId });
  }

  const furniture: Furniture[] = [];
  const customItems: Record<string, CustomItem> = {};
  for (const f of clip.furniture) {
    if (isCustomKind(f.kind)) {
      const id = customId(f.kind);
      if (!Object.hasOwn(plan.customItems, id)) {
        if (!Object.hasOwn(clip.customItems, id)) continue;
        customItems[id] = clip.customItems[id];
      }
    } else if (!isKnownKind(f.kind)) continue;
    const at = move(f);
    if (!finite(at.x, at.y)) continue;
    furniture.push({ ...f, id: newId(), x: at.x, y: at.y });
  }

  const roomNames: Record<string, string> = {};
  for (const [key, name] of Object.entries(clip.roomNames)) {
    const ids = key.split('|').map((id) => wallIds.get(id));
    if (ids.every((id): id is string => id !== undefined)) roomNames[[...ids].sort().join('|')] = name;
  }

  return {
    walls,
    openings,
    furniture,
    roomNames,
    customItems,
    selection: {
      walls: walls.map((w) => w.id),
      openings: [],
      furniture: furniture.map((f) => f.id),
    },
  };
}
