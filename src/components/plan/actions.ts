/**
 * Plan edits made from the canvas and keyboard. Each is one undo step, and
 * none does anything while the plan is read-only.
 */
import { usePlanStore } from '../../store';
import { useUiStore } from '../../uiStore';
import { beginGesture, endGesture, transact } from '../../history';
import { dist, ptEq } from '../../geometry';
import { furnitureDef, kindExists, type FurnitureDef } from '../../catalog';
import { PLAN_LIMITS } from '../../plan';
import { detectRooms, type DetectedRoom } from '../../rooms';
import { fitsAt, handOf, nearestFit, sweepFit, worldFor, type Hand, type World } from '../../solidity';
import { carryRiders, restOf, restsOnAny, ridersOf } from '../../stacking';
import { toast, toastError } from '../../toast';
import { currentUnits } from '../../units';
import type { Furniture, PlanData, Point, RestMode, Wall } from '../../types';
import { clipOf, pasteClip, type Clip } from './clip';
import { carryRoomNames, moveGroup, prepareGroupMove, type GroupMove, type Refusal } from './groupMove';
import {
  boxOf,
  groupSelected,
  isGroupSelection,
  liveSelection,
  marqueeHits,
  mergeSelection,
  sameSelection,
  toggleInSelection,
  type PlanSelection,
} from './marquee';
import {
  dragDelta,
  fineStep,
  junctionRefs,
  MIN_WALL,
  movedPoint,
  normAngle,
  OPENING_GAP,
  resizedEnd,
  slideOpening,
  snapPointTo,
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
  usePlanStore.getState().cleanupWalls();
  // Walls that collapsed or doubled up are gone, and so are doors and windows that no longer fit theirs.
  const sel = currentSelection();
  const live = liveSelection(usePlanStore.getState(), sel);
  if (!sameSelection(sel, live)) {
    useUiStore.setState({
      selectedWallIds: live.walls,
      selectedOpeningIds: live.openings,
      selectedFurnitureIds: live.furniture,
    });
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
  // One whole-millimetre move for all of them, so what rides on a piece keeps its exact place on it.
  const dx = r3(delta.x);
  const dy = r3(delta.y);
  usePlanStore.setState((s) => ({
    furniture: s.furniture.map((f) => {
      const from = start.get(f.id);
      return from ? { ...f, x: r3(from.x + dx), y: r3(from.y + dy) } : f;
    }),
  }));
}

/** Plan positions keep millimetres; quarter turns stay exact. */
const tidy = (p: { x: number; y: number; rotation: number }) => ({ x: r3(p.x), y: r3(p.y), rotation: normAngle(p.rotation) });

/** What a move of `ids` takes along: the pieces themselves and everything resting on them. */
export function movingWith(ids: readonly string[]): Map<string, Point> {
  const { furniture } = usePlanStore.getState();
  const riders = ridersOf(restOf(furniture, furnitureDef), ids);
  const start = new Map<string, Point>();
  for (const f of furniture) if (ids.includes(f.id) || riders.has(f.id)) start.set(f.id, { x: f.x, y: f.y });
  return start;
}

/**
 * The selected pieces that are moved by hand — one resting on another
 * selected piece rides on it instead — as solidity.ts checks them.
 */
function handPieces(furniture: readonly Furniture[], ids: ReadonlySet<string>): { f: Furniture; def: FurnitureDef }[] {
  const rest = restOf(furniture, furnitureDef);
  return furniture
    .filter((f) => ids.has(f.id) && !restsOnAny(rest, f.id, ids))
    .map((f) => ({ f, def: furnitureDef(f.kind) }));
}

/** Pieces taken in hand: where each started, the world they must fit in, and the plan as it was. */
export interface InHand {
  start: Map<string, Point>;
  world: World;
  hand: Hand;
  /** The furniture before the move, to put back exactly (the very same list) when the move comes to nothing. */
  furniture: Furniture[];
}

/** Take `ids` in hand for a move: whatever rests on them comes along unchecked; they must fit among everything else. */
export function takeInHand(ids: readonly string[]): InHand {
  const plan = usePlanStore.getState();
  const set = new Set(ids);
  return {
    start: movingWith(ids),
    world: worldFor(plan, furnitureDef, set),
    hand: handOf(handPieces(plan.furniture, set)),
    furniture: plan.furniture,
  };
}

/** How far a turned piece may be nudged to fit at its new angle, m. */
const TURN_REACH = 0.3;

/**
 * Turn the selected furniture in place. Quarter turns stay exact. Whatever
 * rests on a piece turns with it, about the piece's centre, like a tray. A
 * piece that no longer fits at its new angle is nudged to the nearest spot
 * where it does (a little way at most); if there is none it turns anyway —
 * a turn is never refused. `free` skips the nudge.
 */
export function rotateSelection(delta: number, free = false): boolean {
  const ids = useUiStore.getState().selectedFurnitureIds;
  if (!canEdit() || !ids.length) return false;
  const plan = usePlanStore.getState();
  const before = plan.furniture;
  const rest = restOf(before, furnitureDef);
  const selected = new Set(ids);
  // A selected plate on a selected table goes round with the table, not on its own spot.
  const roots = new Set(before.filter((f) => selected.has(f.id) && !restsOnAny(rest, f.id, selected)).map((f) => f.id));
  let turned = before.map((f) => (roots.has(f.id) ? { ...f, rotation: normAngle(f.rotation + delta) } : f));
  if (!free) {
    const hand = handOf(turned.filter((f) => roots.has(f.id)).map((f) => ({ f, def: furnitureDef(f.kind) })));
    const world = worldFor(plan, furnitureDef, selected);
    if (!fitsAt(world, hand, 0, 0)) {
      const spot = nearestFit(world, hand, 0, 0, { reach: TURN_REACH });
      if (spot.fits) turned = turned.map((f) => (roots.has(f.id) ? { ...f, x: r3(f.x + spot.dx), y: r3(f.y + spot.dy) } : f));
    }
  }
  usePlanStore.setState({ furniture: carryRiders(before, turned, rest, tidy) });
  return true;
}

/**
 * Stand an item on what is beneath it, or on the floor. When that is what it
 * would do anyway the choice is left to the guess, so the plan only records
 * real exceptions.
 */
export function setFurnitureRest(id: string, onTop: boolean): void {
  if (!canEdit()) return;
  const plan = usePlanStore.getState();
  const item = plan.furniture.find((f) => f.id === id);
  if (!item) return;
  const bare = (f: Furniture): Furniture => {
    const next: Furniture = { ...f };
    delete next.rest;
    return next;
  };
  const guess = restOf(plan.furniture.map((f) => (f.id === id ? bare(f) : f)), furnitureDef).get(id);
  const want: RestMode | undefined = onTop
    ? guess?.on && guess.on === guess.beneath
      ? undefined
      : 'top'
    : guess?.on
      ? 'floor'
      : undefined;
  if (item.rest === want) return;
  usePlanStore.setState((s) => ({
    furniture: s.furniture.map((f) => (f.id !== id ? f : want ? { ...f, rest: want } : bare(f))),
  }));
}

// ---------- selecting several things ----------

/** What is selected on the plan right now. */
export function currentSelection(): PlanSelection {
  const ui = useUiStore.getState();
  return { walls: ui.selectedWallIds, openings: ui.selectedOpeningIds, furniture: ui.selectedFurnitureIds };
}

/** The selection, less anything that is no longer in the plan: what a new selection may be built on. */
export function standingSelection(): PlanSelection {
  return liveSelection(usePlanStore.getState(), currentSelection());
}

/** Select exactly `sel`. Does nothing (no re-render) when that is already the selection. */
export function selectOnPlan(sel: PlanSelection): void {
  const ui = useUiStore.getState();
  if (ui.selectedRoomKey === null && sameSelection(currentSelection(), sel)) return;
  ui.setPlanSelection(sel);
}

/** Shift-click: add one thing to the selection, or take it out, leaving the rest selected. */
export function toggleOnPlan(kind: keyof PlanSelection, id: string): void {
  selectOnPlan(toggleInSelection(standingSelection(), kind, id));
}

/** Select what lies wholly inside the rectangle between two plan points, on top of `base`. */
export function selectInBox(a: Point, b: Point, base: PlanSelection): void {
  if (!canEdit()) return;
  const hits = marqueeHits(usePlanStore.getState(), boxOf(a, b), furnitureDef);
  selectOnPlan(mergeSelection(base, hits));
}

/** Select every wall, door, window and piece of furniture. */
export function selectAll(): boolean {
  if (!canEdit()) return false;
  const plan = usePlanStore.getState();
  if (!plan.walls.length && !plan.furniture.length) return false;
  const ui = useUiStore.getState();
  if (ui.tool !== 'select') ui.setTool('select');
  selectOnPlan({
    walls: plan.walls.map((w) => w.id),
    openings: plan.openings.map((o) => o.id),
    furniture: plan.furniture.map((f) => f.id),
  });
  return true;
}

// ---------- copy and paste ----------

/** The last thing copied, and how many times it has been pasted without a pointer to aim at. */
let clipboard: { clip: Clip; pastes: number } | null = null;

export const hasClipboard = (): boolean => clipboard !== null;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function describe(walls: number, items: number): string {
  return [walls ? plural(walls, 'wall') : '', items ? plural(items, 'item') : ''].filter(Boolean).join(' and ');
}

/** Copy the selection (walls take their doors and windows along). False when there is nothing to copy. */
export function copySelection(quiet = false): boolean {
  const plan = usePlanStore.getState();
  const clip = clipOf(plan, liveSelection(plan, currentSelection()));
  if (!clip) return false;
  clipboard = { clip, pastes: 0 };
  if (!quiet) toast(`Copied ${describe(clip.walls.length, clip.furniture.length)}.`, { ms: 1800 });
  return true;
}

/** Add `clip`, moved by `delta`, to the plan as one undo step and select what was added. */
function addClip(clip: Clip, delta: Point): PlanSelection | null {
  if (!canEdit()) return null;
  const plan = usePlanStore.getState();
  const pasted = pasteClip(plan, clip, delta, () => crypto.randomUUID(), kindExists);
  if (!pasted.walls.length && !pasted.furniture.length) {
    toastError('Nothing to paste here: it is already in this exact spot.');
    return null;
  }
  if (
    plan.walls.length + pasted.walls.length > PLAN_LIMITS.walls ||
    plan.openings.length + pasted.openings.length > PLAN_LIMITS.openings ||
    plan.furniture.length + pasted.furniture.length > PLAN_LIMITS.furniture
  ) {
    toastError('That would make the plan too large.');
    return null;
  }
  // One store write: one undo step.
  usePlanStore.setState((s) => ({
    walls: pasted.walls.length ? [...s.walls, ...pasted.walls] : s.walls,
    openings: pasted.openings.length ? [...s.openings, ...pasted.openings] : s.openings,
    furniture: pasted.furniture.length ? [...s.furniture, ...pasted.furniture] : s.furniture,
    roomNames: Object.keys(pasted.roomNames).length ? { ...s.roomNames, ...pasted.roomNames } : s.roomNames,
    customItems: Object.keys(pasted.customItems).length ? { ...s.customItems, ...pasted.customItems } : s.customItems,
  }));
  const ui = useUiStore.getState();
  if (ui.tool !== 'select') ui.setTool('select');
  selectOnPlan(pasted.selection);
  return pasted.selection;
}

/**
 * Paste the last copy: centred on `at` (the pointer) when there is one, else a
 * grid step further down-right each time. Lands on the grid either way.
 */
export function pasteClipboard(at: Point | null): boolean {
  if (!canEdit() || !clipboard) return false;
  const { clip } = clipboard;
  const plan = usePlanStore.getState();
  const grid = plan.settings.gridSize > 0 ? plan.settings.gridSize : 0.5;
  let delta: Point;
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    delta = snapPointTo({ x: at.x - clip.center.x, y: at.y - clip.center.y }, grid);
  } else {
    const n = clipboard.pastes + 1;
    delta = { x: grid * n, y: grid * n };
  }
  const added = addClip(clip, delta);
  if (!added) return false;
  if (!at) clipboard.pastes++;
  return true;
}

/**
 * Copy the selection and remove exactly what was copied: the walls with their
 * doors and windows, and the furniture. A door or window selected without its
 * wall cannot be copied, so it stays (and stays selected).
 */
export function cutSelection(): boolean {
  if (!canEdit() || !copySelection(true)) return false;
  const { clip } = clipboard!;
  const plan = usePlanStore.getState();
  const wallIds = clip.walls.map((w) => w.id);
  const itemIds = clip.furniture.map((f) => f.id);
  transact(() => {
    if (wallIds.length) plan.deleteWalls(wallIds);
    if (itemIds.length) plan.deleteFurniture(itemIds);
  });
  selectOnPlan(liveSelection(usePlanStore.getState(), currentSelection()));
  toast(`Cut ${describe(clip.walls.length, clip.furniture.length)}.`, { ms: 1800 });
  return true;
}

/**
 * Copy the selection one grid step down-right and select the copies (walls
 * with their doors and windows, furniture). The clipboard is left alone.
 * Returns the ids of the furniture copies.
 */
export function duplicateSelection(): string[] {
  if (!canEdit()) return [];
  const plan = usePlanStore.getState();
  const clip = clipOf(plan, liveSelection(plan, currentSelection()));
  if (!clip) return [];
  const step = plan.settings.gridSize > 0 ? plan.settings.gridSize : 0.5;
  return addClip(clip, { x: step, y: step })?.furniture ?? [];
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
 * points along it. Furniture stops at whatever it meets on the way, unless
 * `free` (⌥ held).
 */
export function nudgeSelection(delta: Point, free = false): boolean {
  if (!canEdit()) return false;
  const ui = useUiStore.getState();
  // Walls with anything else, or several walls: the selection moves as one piece, as it drags.
  if (ui.selectedWallIds.length && groupSelected(ui)) {
    const d = beginGroupDrag();
    if (!d) return false;
    const moved = moveGroupDrag(d, delta, { lock: false, free: true, exact: true }) === 'moved';
    endGroupDrag(d, 'drop');
    return moved;
  }
  // Walls move as a step of their own, so with walls in a mixed selection the
  // whole press must be one: else one ⌘Z puts back the walls and leaves the
  // rest. Without walls the moves are plain edits, which already merge into
  // one step (and a held arrow into one step for the whole run).
  if (!useUiStore.getState().selectedWallIds.length) return nudgeParts(delta, free);
  let moved = false;
  transact(() => {
    moved = nudgeParts(delta, free);
  });
  return moved;
}

function nudgeParts(delta: Point, free: boolean): boolean {
  const ui = useUiStore.getState();
  const plan = usePlanStore.getState();
  let moved = false;

  if (ui.selectedFurnitureIds.length) {
    // Whatever stands on a moved piece goes with it.
    const taken = takeInHand(ui.selectedFurnitureIds);
    if (taken.start.size) {
      const go = free ? { dx: delta.x, dy: delta.y } : sweepFit(taken.world, taken.hand, delta.x, delta.y);
      if (Math.abs(go.dx) > 1e-9 || Math.abs(go.dy) > 1e-9) placeFurniture(taken.start, { x: go.dx, y: go.dy });
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

// ---------- moving the selection as one piece ----------

/** What a refused move would have done, as the toast says it. */
/** At most this many steps are tried when a drag goes past where the walls can go. */
const MAX_WALK = 40;

const REFUSED: Record<Refusal, string> = {
  short: 'A wall joined to it would get too short.',
  opening: 'A door or window would no longer fit on its wall.',
  detach: 'It would come off a wall it is joined to.',
  overlap: 'It would run into another wall.',
};

/** A move of the whole selection, from the press to the release. */
export interface GroupDrag {
  /** The plan as it was, to put back exactly (Esc, or furniture let go where it doesn't fit). */
  readonly before: Pick<PlanData, 'walls' | 'openings' | 'furniture' | 'roomNames'>;
  /** The walls, doors and windows: worked out once (groupMove.ts). */
  readonly move: GroupMove;
  /** The furniture in it, and whatever rests on that: where each started. */
  readonly start: Map<string, Point>;
  /**
   * Furniture moving without walls is solid, as when it is dragged alone
   * (solidity.ts): what it must fit among. With walls it goes with them.
   */
  readonly solid: InHand | null;
  /** The move snaps to this: the grid with walls in it, the fine step without. */
  readonly step: number;
  /** The move on show, and whether ⌥ was down for it. */
  shown: Point;
  free: boolean;
  /** Furniture: where it last fitted, and whether it fits now (drawn red when not). */
  fit: Point;
  blocked: boolean;
  /** Why the last move asked for was refused (it then stays where it was), and whether the toast said so. */
  refused: Refusal | null;
  told: boolean;
  /** Bridging walls' ids: the same all through the drag, so the canvas doesn't redraw them from scratch. */
  readonly ids: Map<string, string>;
  /** The bridges on show, to work out room names again only when they change. */
  bridges: string;
  /** What this drag last wrote: anything else in the store means the plan changed under it. */
  wrote: Pick<PlanData, 'walls' | 'openings' | 'furniture'>;
}

/**
 * Start moving the selection as one piece, when it is one that moves that
 * way (`isGroupSelection`). Everything until `endGroupDrag` is one undo step.
 */
export function beginGroupDrag(): GroupDrag | null {
  if (!canEdit()) return null;
  const plan = usePlanStore.getState();
  const sel = liveSelection(plan, currentSelection());
  if (!isGroupSelection(sel)) return null;
  const withWalls = sel.walls.length > 0;
  const solid = !withWalls && sel.furniture.length ? takeInHand(sel.furniture) : null;
  const before = { walls: plan.walls, openings: plan.openings, furniture: plan.furniture, roomNames: plan.roomNames };
  beginGesture();
  return {
    before,
    move: prepareGroupMove(plan, sel.walls, sel.openings),
    start: solid ? solid.start : movingWith(sel.furniture),
    solid,
    step: withWalls ? (plan.settings.gridSize > 0 ? plan.settings.gridSize : 0.5) : fineStep(currentUnits()),
    shown: { x: 0, y: 0 },
    free: false,
    fit: { x: 0, y: 0 },
    blocked: false,
    refused: null,
    told: false,
    ids: new Map(),
    bridges: '',
    wrote: before,
  };
}

/**
 * Show the selection moved by `raw` (plan meters from the press), snapped to
 * the drag's step unless `exact`; `lock` keeps it to one axis, `free` lets
 * furniture through things. A move the walls can't make takes the selection
 * as far toward it as they can go, a step at a time, as if it ran into
 * something; the toast says why it stopped.
 * 'lost' when the plan changed under the drag: end it, and leave the plan be.
 */
export function moveGroupDrag(
  d: GroupDrag,
  raw: Point,
  opts: { lock: boolean; free: boolean; exact?: boolean },
): 'moved' | 'held' | 'lost' {
  const s = usePlanStore.getState();
  if (!canEdit() || s.walls !== d.wrote.walls || s.openings !== d.wrote.openings || s.furniture !== d.wrote.furniture) {
    return 'lost';
  }
  let delta = opts.exact ? raw : dragDelta(raw, d.step, opts.lock);
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return 'held';
  if (ptEq(delta, d.shown) && opts.free === d.free) return 'held';

  const newId = (key: string): string => {
    let id = d.ids.get(key);
    if (!id) d.ids.set(key, (id = crypto.randomUUID()));
    return id;
  };
  let res = moveGroup(d.move, delta, newId);
  if (!res.ok) {
    const why = res.why;
    if (!d.told) {
      d.told = true;
      toast(`Can’t move it that far: ${REFUSED[why].charAt(0).toLowerCase()}${REFUSED[why].slice(1)}`, { ms: 2600 });
    }
    // However fast the pointer went past the limit, stop at the limit, not where the last move left it.
    const from = d.shown;
    const n = opts.exact ? 0 : Math.min(MAX_WALK, Math.ceil(dist(from, delta) / d.step));
    let reached: { delta: Point; res: Extract<ReturnType<typeof moveGroup>, { ok: true }> } | null = null;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const q = snapPointTo({ x: from.x + (delta.x - from.x) * t, y: from.y + (delta.y - from.y) * t }, d.step);
      // ⇧ keeps every stop on the axis the move is held to, even when that axis just changed.
      const p = opts.lock ? { x: delta.x === 0 ? 0 : q.x, y: delta.y === 0 ? 0 : q.y } : q;
      if (ptEq(p, from) || (reached && ptEq(p, reached.delta))) continue;
      const step = moveGroup(d.move, p, newId);
      if (!step.ok) break;
      reached = { delta: p, res: step };
    }
    if (!reached) {
      d.refused = why;
      return 'held';
    }
    delta = reached.delta;
    res = reached.res;
  }
  d.refused = null;

  // Furniture: with the walls, exactly; on its own, kept out of things (shown red where nothing near fits).
  let go = delta;
  d.blocked = false;
  if (d.solid && !opts.free) {
    const spot = nearestFit(d.solid.world, d.solid.hand, delta.x, delta.y, { from: { dx: d.fit.x, dy: d.fit.y } });
    d.blocked = !spot.fits;
    if (spot.fits) go = d.fit = { x: spot.dx, y: spot.dy };
  }
  const dx = r3(go.x);
  const dy = r3(go.y);
  // Back where it started: the very same list, so a drag that ends there leaves nothing behind.
  const furnitureMoves = d.start.size > 0 && (dx !== 0 || dy !== 0);
  const furniture = furnitureMoves
    ? d.before.furniture.map((f) => {
        const from = d.start.get(f.id);
        return from ? { ...f, x: r3(from.x + dx), y: r3(from.y + dy) } : f;
      })
    : d.before.furniture;

  // Room names follow a room whose walls changed (a bridge joined them) only when the bridges change.
  const bridges = res.walls.length > d.before.walls.length ? res.walls.slice(d.before.walls.length).map((w) => w.id).join() : '';
  const patch: Partial<PlanData> = { walls: res.walls, openings: res.openings, furniture };
  if (bridges !== d.bridges) {
    d.bridges = bridges;
    patch.roomNames = bridges ? carryRoomNames(d.before.roomNames, d.before.walls, res.walls, roomsFor) : d.before.roomNames;
  }
  usePlanStore.setState(patch);
  d.wrote = { walls: res.walls, openings: res.openings, furniture };
  d.shown = delta;
  d.free = opts.free;
  return 'moved';
}

/**
 * End the move. 'drop' keeps it — except furniture let go where nothing near
 * fits, which puts everything back as it was; 'cancel' puts everything back;
 * 'lost' leaves the plan as something else made it. Nothing moved, or put
 * back: no undo step is left.
 */
export function endGroupDrag(d: GroupDrag, how: 'drop' | 'cancel' | 'lost'): void {
  try {
    if (how === 'lost' || d.wrote === d.before || !canEdit()) return;
    const s = usePlanStore.getState();
    if (s.walls !== d.wrote.walls || s.openings !== d.wrote.openings || s.furniture !== d.wrote.furniture) return;
    // Let go where it started (moved, then brought back): nothing to tidy, and no undo step is left.
    const home = s.walls === d.before.walls && s.openings === d.before.openings && s.furniture === d.before.furniture;
    if (how === 'cancel' || d.blocked || home) {
      usePlanStore.setState({ ...d.before });
      return;
    }
    const names = carryRoomNames(d.before.roomNames, d.before.walls, s.walls, roomsFor);
    if (names !== s.roomNames) usePlanStore.setState({ roomNames: names });
    finishWallEdit();
  } finally {
    endGesture();
  }
}
