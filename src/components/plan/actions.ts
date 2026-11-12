/**
 * Plan edits made from the canvas and keyboard. Each is one undo step, and
 * none does anything while the plan is read-only.
 */
import { usePlanStore } from '../../store';
import { useUiStore } from '../../uiStore';
import { transact } from '../../history';
import { dist, ptEq } from '../../geometry';
import { detectRooms, type DetectedRoom } from '../../rooms';
import type { Furniture, Point, Wall } from '../../types';
import {
  junctionRefs,
  MIN_WALL,
  movedPoint,
  normAngle,
  OPENING_GAP,
  resizedEnd,
  slideOpening,
  wallMoveGroups,
  type JunctionGroup,
} from './drafting';

const MIN_OPENING = 0.4;
const MAX_WALL = 500;

export const canEdit = (): boolean => !useUiStore.getState().readOnly;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

// Rooms are derived from walls alone; the canvas and the status bar share one result.
const roomCache = new WeakMap<Wall[], DetectedRoom[]>();
export function roomsFor(walls: Wall[]): DetectedRoom[] {
  let rooms = roomCache.get(walls);
  if (!rooms) {
    rooms = detectRooms(walls);
    roomCache.set(walls, rooms);
  }
  return rooms;
}

/** Move frozen junction groups to `from + delta` in one store write. */
export function moveJunctions(groups: JunctionGroup[], delta: Point): void {
  if (!canEdit()) return;
  usePlanStore.setState((s) => ({
    walls: s.walls.map((w) => {
      let a = w.a;
      let b = w.b;
      for (const g of groups) {
        for (const r of g.refs) {
          if (r.wallId !== w.id) continue;
          if (r.end === 'a') a = movedPoint(g.from, delta);
          else b = movedPoint(g.from, delta);
        }
      }
      return a === w.a && b === w.b ? w : { ...w, a, b };
    }),
  }));
}

/**
 * After walls moved: drop collapsed and duplicate walls, re-fit openings, and
 * forget selected walls that no longer exist. Call inside a gesture/transact.
 */
export function finishWallEdit(): void {
  if (!canEdit()) return;
  const removed = usePlanStore.getState().cleanupWalls();
  if (!removed.length) return;
  const ui = useUiStore.getState();
  if (ui.selectedWallIds.some((id) => removed.includes(id))) {
    useUiStore.setState({ selectedWallIds: ui.selectedWallIds.filter((id) => !removed.includes(id)) });
  }
}

/** Set a wall's length, keeping its A end; whatever meets its B end follows. */
export function resizeWall(wallId: string, length: number): boolean {
  if (!canEdit() || !Number.isFinite(length)) return false;
  const plan = usePlanStore.getState();
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return false;
  const to = resizedEnd(wall, Math.min(MAX_WALL, Math.max(MIN_WALL, length)));
  if (!to) return false;
  if (ptEq(to, wall.b)) return true;
  const refs = junctionRefs(plan.walls, wall.b);
  transact(() => {
    usePlanStore.getState().moveEndpoints(refs, to);
    finishWallEdit();
  });
  return true;
}

/** Slide an opening toward `desired` meters from its wall's A end. Returns where it ended up. */
export function moveOpening(id: string, desired: number, step = 0): number | null {
  const { walls, openings } = usePlanStore.getState();
  const opening = openings.find((o) => o.id === id);
  const wall = opening && walls.find((w) => w.id === opening.wallId);
  if (!opening || !wall) return null;
  if (!canEdit()) return opening.offset;
  const offset = slideOpening(openings, wall, id, opening.width, desired, step);
  if (offset === null) return opening.offset;
  if (Math.abs(offset - opening.offset) > 1e-9) {
    usePlanStore.setState((s) => ({
      openings: s.openings.map((o) => (o.id === id ? { ...o, offset } : o)),
    }));
  }
  return offset;
}

/** Change an opening's width, nudging it along the wall if it needs the room. False when it can't fit. */
export function setOpeningWidth(id: string, width: number): boolean {
  if (!canEdit() || !Number.isFinite(width)) return false;
  const { walls, openings } = usePlanStore.getState();
  const opening = openings.find((o) => o.id === id);
  const wall = opening && walls.find((w) => w.id === opening.wallId);
  if (!opening || !wall) return false;
  const max = dist(wall.a, wall.b) - 2 * OPENING_GAP;
  if (max < MIN_OPENING) return false;
  const w = r3(Math.min(max, Math.max(MIN_OPENING, width)));
  const offset = slideOpening(openings, wall, id, w, opening.offset);
  if (offset === null) return false;
  if (w === opening.width && offset === opening.offset) return true;
  usePlanStore.setState((s) => ({
    openings: s.openings.map((o) => (o.id === id ? { ...o, width: w, offset } : o)),
  }));
  return true;
}

/** Set or clear the note shown on a furniture item. */
export function setFurnitureLabel(id: string, text: string): void {
  if (!canEdit()) return;
  const label = text.trim().slice(0, 60);
  const item = usePlanStore.getState().furniture.find((f) => f.id === id);
  if (!item || (item.label ?? '') === label) return;
  if (label) {
    usePlanStore.getState().updateFurniture(id, { label });
    return;
  }
  usePlanStore.setState((s) => ({
    furniture: s.furniture.map((f) => {
      if (f.id !== id) return f;
      const next: Furniture = { ...f };
      delete next.label;
      return next;
    }),
  }));
}

/** Move the given furniture to `start + delta` (start positions frozen when the move began). */
export function placeFurniture(start: Map<string, Point>, delta: Point): void {
  if (!canEdit()) return;
  usePlanStore.setState((s) => ({
    furniture: s.furniture.map((f) => {
      const from = start.get(f.id);
      return from ? { ...f, x: r3(from.x + delta.x), y: r3(from.y + delta.y) } : f;
    }),
  }));
}

/** Turn the selected furniture in place. Quarter turns stay exact. */
export function rotateSelection(delta: number): boolean {
  const ids = useUiStore.getState().selectedFurnitureIds;
  if (!canEdit() || !ids.length) return false;
  usePlanStore.setState((s) => ({
    furniture: s.furniture.map((f) =>
      ids.includes(f.id) ? { ...f, rotation: normAngle(f.rotation + delta) } : f,
    ),
  }));
  return true;
}

/** Copy the selected furniture one grid step down-right and select the copies. */
export function duplicateSelection(): string[] {
  const ui = useUiStore.getState();
  if (!canEdit() || !ui.selectedFurnitureIds.length) return [];
  const plan = usePlanStore.getState();
  const step = plan.settings.gridSize > 0 ? plan.settings.gridSize : 0.5;
  const copies: Furniture[] = plan.furniture
    .filter((f) => ui.selectedFurnitureIds.includes(f.id))
    .map((f) => ({ ...f, id: crypto.randomUUID(), x: r3(f.x + step), y: r3(f.y + step) }));
  if (!copies.length) return [];
  usePlanStore.setState((s) => ({ furniture: [...s.furniture, ...copies] }));
  const ids = copies.map((c) => c.id);
  ui.setFurnitureSelection(ids);
  return ids;
}

/** Remove whatever is selected. */
export function deleteSelection(): boolean {
  if (!canEdit()) return false;
  const ui = useUiStore.getState();
  const plan = usePlanStore.getState();
  // Selections can outlive what they point at (undo, a swapped plan).
  const wallIds = ui.selectedWallIds.filter((id) => plan.walls.some((w) => w.id === id));
  const openingIds = ui.selectedOpeningIds.filter((id) => plan.openings.some((o) => o.id === id));
  const itemIds = ui.selectedFurnitureIds.filter((id) => plan.furniture.some((f) => f.id === id));
  if (!wallIds.length && !openingIds.length && !itemIds.length) return false;
  transact(() => {
    if (openingIds.length) plan.deleteOpenings(openingIds);
    if (wallIds.length) plan.deleteWalls(wallIds);
    if (itemIds.length) plan.deleteFurniture(itemIds);
  });
  ui.setSelection([]);
  return true;
}

/**
 * Move the selection by `delta`: furniture and walls translate (attached
 * walls stretch); a door or window slides along its wall when the arrow
 * points along it.
 */
export function nudgeSelection(delta: Point): boolean {
  const ui = useUiStore.getState();
  if (!canEdit()) return false;
  const plan = usePlanStore.getState();
  let moved = false;

  if (ui.selectedFurnitureIds.length) {
    const start = new Map<string, Point>();
    for (const f of plan.furniture) {
      if (ui.selectedFurnitureIds.includes(f.id)) start.set(f.id, { x: f.x, y: f.y });
    }
    if (start.size) {
      placeFurniture(start, delta);
      moved = true;
    }
  }

  if (ui.selectedWallIds.length) {
    const groups = wallMoveGroups(plan.walls, ui.selectedWallIds);
    if (groups.length) {
      transact(() => {
        moveJunctions(groups, delta);
        finishWallEdit();
      });
      moved = true;
    }
  }

  for (const id of ui.selectedOpeningIds) {
    const opening = plan.openings.find((o) => o.id === id);
    const wall = opening && plan.walls.find((w) => w.id === opening.wallId);
    const len = wall ? dist(wall.a, wall.b) : 0;
    if (!opening || !wall || len < 1e-6) continue;
    const along = (delta.x * (wall.b.x - wall.a.x) + delta.y * (wall.b.y - wall.a.y)) / len;
    const step = Math.hypot(delta.x, delta.y);
    if (Math.abs(along) < step * 0.5) continue;
    moveOpening(id, opening.offset + Math.sign(along) * step);
    moved = true;
  }
  return moved;
}
