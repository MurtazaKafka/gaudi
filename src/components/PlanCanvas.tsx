import { memo, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { DEFAULT_OPENING_WIDTH, OPENING_STEPS, usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { useAiStore } from '../aiStore';
import { useKeyStore } from '../ai/client';
import { customId, furnitureDef, isCustomKind } from '../catalog';
import { dist, midpoint, nearestWallPoint, ptEq, type SnapResult } from '../geometry';
import { cachedWorldFor, handOf, nearestFit } from '../solidity';
import { restOf, stackOrder } from '../stacking';
import { currentUnits, formatLength, parseLength, useUnits } from '../units';
import { toastError } from '../toast';
import { theme } from '../theme';
import type { DetectedRoom } from '../rooms';
import type { Furniture, Opening, OpeningType, Point, Tool } from '../types';
import { FurnitureShape } from './FurnitureShape';
import { RoomAiPanel } from './RoomAiPanel';
import {
  beginGroupDrag,
  copySelection,
  currentSelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  endGroupDrag,
  hasClipboard,
  moveGroupDrag,
  nudgeSelection,
  pasteClipboard,
  roomsFor,
  rotateSelection,
  selectAll,
  selectInBox,
  selectOnPlan,
  standingSelection,
} from './plan/actions';
import { clickSwallowed, groupSelected, NO_SELECTION, swallowNextClick, type PlanSelection } from './plan/marquee';
import { setEditorDriver } from './plan/devHandle';
import {
  arrowDelta,
  dimensionSide,
  fineStep,
  MIN_WALL,
  normAngle,
  placeOpening,
  pointAlong,
  resolveDraftPoint,
  snapPointTo,
  typedLengthKey,
} from './plan/drafting';
import { fitRoomLabel, labelAnchor, openingLabelSpot, roomLabelBox, type LabelBox } from './plan/labels';
import { overPaper, ROOM_FILL_ALPHA, roomTone } from './plan/look';
import { FurnitureInspector, OpeningInspector, RoomLabel, WallLengthTag } from './plan/overlays';
import { entranceMarkerSize, findEntrance, footprintFor, pocheFor } from './plan/poche';
import { roomText } from './plan/roomText';
import {
  EndpointHandle,
  EntranceMarker,
  GridLayerLines,
  HouseShadow,
  LengthTag,
  MeasureLine,
  OpeningShape,
  SnapMarker,
  WallDimensions,
  WallLine,
  WallPoche,
} from './plan/shapes';
import { useRefState } from './plan/useRefState';
import { isInPanel, isKeyboardFocusedControl, isTypingTarget, useViewport } from './plan/useViewport';
import { buildGridLines, SNAP_RADIUS_PX, toScreen, toWorld, type View } from './plan/view';

interface OpeningGhost {
  wallId: string;
  offset: number;
  valid: boolean;
}

/** A dropped measurement. Lives only on the canvas — never in the plan. */
interface Measure {
  a: Point;
  b: Point;
}

declare global {
  interface Window {
    __view?: View;
    __rooms?: DetectedRoom[];
  }
}

const MAX_TYPED_WALL = 500;
const MAX_MEASURES = 40;
/** How far (px) a press must travel before it is a selection rectangle and not a click. */
const MARQUEE_START_PX = 4;
/** Corner handles and length tags are for working on a few walls, not for a rectangle's worth. */
const MAX_WALL_HANDLES = 4;
/** The name the canvas knows a room's floor by (a rectangle may start on one). */
const ROOM_FILL = 'room-fill';

/** Where a door/window would land for a pointer position; reads the store directly. */
function computeGhost(raw: Point, type: OpeningType, scale: number): OpeningGhost | null {
  const { walls, openings } = usePlanStore.getState();
  const hit = nearestWallPoint(raw, walls);
  const threshold = Math.max(0.3, 16 / scale);
  if (!hit || hit.dist >= threshold) return null;
  const wall = walls.find((w) => w.id === hit.wallId);
  if (!wall) return null;
  const spot = placeOpening(openings, wall, DEFAULT_OPENING_WIDTH[type], hit.offset);
  return { wallId: hit.wallId, offset: spot.offset, valid: spot.valid };
}

/** The door (or window) of this tool's kind that the pointer is on, if any. */
function openingUnder(raw: Point, type: OpeningType, scale: number): Opening | null {
  const { walls, openings } = usePlanStore.getState();
  const hit = nearestWallPoint(raw, walls);
  const threshold = Math.max(0.3, 16 / scale);
  if (!hit || hit.dist >= threshold) return null;
  return (
    openings.find((o) => o.wallId === hit.wallId && o.type === type && Math.abs(o.offset - hit.offset) <= o.width / 2) ??
    null
  );
}

/**
 * Click an opening again with its own tool and it steps to the next size: a
 * door becomes a wide door, then a pair; a window gains lights. A size that
 * doesn't fit the wall is skipped; after the largest comes the smallest.
 */
function stepOpening(opening: Opening): void {
  const steps = OPENING_STEPS[opening.type];
  const from = steps.findIndex((w) => w > opening.width + 0.01);
  const start = from === -1 ? 0 : from;
  for (let k = 0; k < steps.length; k++) {
    const width = steps[(start + k) % steps.length];
    if (Math.abs(width - opening.width) < 0.01) return;
    usePlanStore.getState().updateOpeningWidth(opening.id, width);
    const now = usePlanStore.getState().openings.find((o) => o.id === opening.id);
    if (now && Math.abs(now.width - width) < 0.01) return;
  }
}

/** The plan item a canvas node draws (`planItem` attr on it or an ancestor), if any. */
function planItemOf(node: Konva.Node | null): { kind: keyof PlanSelection; id: string } | null {
  for (let n = node; n; n = n.getParent()) {
    const v: unknown = n.getAttr('planItem');
    if (typeof v !== 'string') continue;
    const i = v.indexOf(':');
    const kind = v.slice(0, i);
    return kind === 'walls' || kind === 'openings' || kind === 'furniture' ? { kind, id: v.slice(i + 1) } : null;
  }
  return null;
}

const sameGhost = (a: OpeningGhost | null, b: OpeningGhost | null): boolean =>
  a === b ||
  (!!a && !!b && a.wallId === b.wallId && a.valid === b.valid && Math.abs(a.offset - b.offset) < 1e-9);

/** The cursor a canvas node asks for (`cursor` attr on it or an ancestor). */
function cursorOf(node: Konva.Node | null): string | null {
  for (let n = node; n; n = n.getParent()) {
    const c: unknown = n.getAttr('cursor');
    if (typeof c === 'string') return c;
  }
  return null;
}

/** A read-only view can look and measure, nothing else. */
const usableTool = (tool: Tool, readOnly: boolean): Tool =>
  readOnly && tool !== 'measure' ? 'select' : tool;

/** Where the segment being drawn ends: the typed length when one is readable, else the cursor. */
function draftEnd(anchor: Point, cursor: Point | null, typed: string, lastDir: Point | null): Point | null {
  if (typed) {
    const m = parseLength(typed, currentUnits());
    // No cursor on the canvas: carry on the way the last segment went.
    if (m !== null && m >= MIN_WALL) return pointAlong(anchor, cursor, Math.min(m, MAX_TYPED_WALL), lastDir);
  }
  return cursor;
}

export function PlanCanvas() {
  const stageRef = useRef<Konva.Stage>(null);
  const { containerRef, size, view, spaceDown, panning, fit, onMouseDownCapture } = useViewport();
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const walls = usePlanStore((s) => s.walls);
  const openings = usePlanStore((s) => s.openings);
  const furniture = usePlanStore((s) => s.furniture);
  const settings = usePlanStore((s) => s.settings);
  const units = useUnits();
  const readOnly = useUiStore((s) => s.readOnly);
  const tool = usableTool(
    useUiStore((s) => s.tool),
    readOnly,
  );
  const selectedWallIds = useUiStore((s) => s.selectedWallIds);
  const selectedOpeningIds = useUiStore((s) => s.selectedOpeningIds);
  const selectedFurnitureIds = useUiStore((s) => s.selectedFurnitureIds);
  const selectedRoomKey = useUiStore((s) => s.selectedRoomKey);
  const placingKind = useUiStore((s) => s.placingKind);
  const showDimensions = useUiStore((s) => s.showDimensions);
  const color = useUiStore((s) => s.drawingLook) === 'color';
  const roomNames = usePlanStore((s) => s.roomNames);
  const customItems = usePlanStore((s) => s.customItems);
  const aiStatus = useAiStore((s) => s.status);
  const aiRoomKey = useAiStore((s) => s.roomKey);
  const aiItems = useAiStore((s) => s.items);

  // Drafting state. Each piece is state (to draw) plus a ref (so rapid clicks in
  // one frame and the long-lived key listener always read the current value).
  const [anchor, anchorRef, setAnchor] = useRefState<Point | null>(null);
  const [snap, snapRef, setSnapRaw] = useRefState<SnapResult | null>(null);
  const [typed, typedRef, setTyped] = useRefState('');
  const [lastDir, lastDirRef, setLastDir] = useRefState<Point | null>(null);
  const [measureAnchor, measureAnchorRef, setMeasureAnchor] = useRefState<Point | null>(null);
  const [measures, measuresRef, setMeasures] = useRefState<Measure[]>([]);
  const [placeRotation, placeRotationRef, setPlaceRotation] = useRefState(0);
  const [ghost, setGhost] = useState<OpeningGhost | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  const [editingRoomKey, setEditingRoomKey] = useState<string | null>(null);
  // What the pointer is on, for the Color look's hover tones (the Paper look's walls keep their own).
  const [hoverWallId, setHoverWallId] = useState<string | null>(null);
  const [hoverRoomKey, setHoverRoomKey] = useState<string | null>(null);
  /** Last pointer position in plan meters (unsnapped) and whether Shift / ⌥ were down. */
  const pointer = useRef<{ raw: Point; shift: boolean; alt?: boolean } | null>(null);
  /** Where the furniture being placed would go, and whether it fits there (it is solid: see solidity.ts). */
  const [placeFits, placeFitsRef, setPlaceFits] = useRefState(true);
  /** The selection rectangle being dragged (plan meters), and how to end it. */
  const [marquee, , setMarquee] = useRefState<{ a: Point; b: Point } | null>(null);
  const marqueeDrag = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  /** The selection being moved as one piece: how to show it again (⇧ or ⌥ changed), keep it, or put it back. */
  const groupDrag = useRef<{ again: (shift: boolean, alt: boolean) => void; stop: () => void; cancel: () => void } | null>(
    null,
  );
  const [groupMoving, setGroupMoving] = useState(false);
  /** Furniture in it, moving without walls, is where nothing near fits (drawn red; it goes back if let go). */
  const [groupBlocked, setGroupBlocked] = useState(false);

  const setSnap = (next: SnapResult | null) => {
    const cur = snapRef.current;
    if (cur === next || (cur && next && cur.kind === next.kind && ptEq(cur.p, next.p))) return;
    setSnapRaw(next);
  };

  /** Recompute the live preview from the last pointer position (mouse moved, Shift toggled, anchor changed). */
  const refresh = () => {
    const ptr = pointer.current;
    if (!ptr) return;
    const ui = useUiStore.getState();
    const plan = usePlanStore.getState();
    const active = usableTool(ui.tool, ui.readOnly);
    const { scale } = viewRef.current;

    if (active === 'door' || active === 'window') {
      // On one of its own kind the tool resizes instead of placing: no ghost there.
      const next = openingUnder(ptr.raw, active, scale) ? null : computeGhost(ptr.raw, active, scale);
      setGhost((prev) => (sameGhost(prev, next) ? prev : next));
      setSnap(null);
      ui.setCursor(ptr.raw);
    } else if (active === 'furniture') {
      const spot = placingSpot(ptr.raw, !!ptr.alt);
      if (spot.fits !== placeFitsRef.current) setPlaceFits(spot.fits);
      setSnap({ p: spot.p, kind: 'grid' });
      ui.setCursor(spot.p);
    } else if (active === 'wall' || active === 'measure') {
      const result = resolveDraftPoint(ptr.raw, {
        walls: plan.walls,
        grid: plan.settings.gridSize,
        radius: SNAP_RADIUS_PX / scale,
        anchor: active === 'wall' ? anchorRef.current : measureAnchorRef.current,
        constrain: ptr.shift,
      });
      setSnap(result);
      ui.setCursor(result.p);
    } else {
      // Select: nothing snaps; only the status readout follows the pointer.
      ui.setCursor(ptr.raw);
    }
  };

  /**
   * Where a click would put the piece being placed: the grid point under the
   * pointer, or the nearest spot to it where the piece fits among the walls
   * and furniture; `fits` false when nothing near does. ⌥ places it freely.
   */
  const placingSpot = (raw: Point, free: boolean): { p: Point; fits: boolean } => {
    const plan = usePlanStore.getState();
    const kind = useUiStore.getState().placingKind;
    const p = snapPointTo(raw, fineStep(plan.settings.units));
    if (!kind || free) return { p, fits: true };
    const world = cachedWorldFor(plan, furnitureDef);
    const hand = handOf([{ f: { id: '__placing', kind, x: p.x, y: p.y, rotation: placeRotationRef.current }, def: furnitureDef(kind) }]);
    const last = lastPlaceFit.current;
    const spot = nearestFit(world, hand, 0, 0, last ? { from: { dx: last.x - p.x, dy: last.y - p.y } } : {});
    if (!spot.fits) return { p, fits: false };
    const at = { x: p.x + spot.dx, y: p.y + spot.dy };
    lastPlaceFit.current = at;
    return { p: at, fits: true };
  };
  const lastPlaceFit = useRef<Point | null>(null);

  const endRun = () => {
    setAnchor(null);
    setTyped('');
  };

  /** Add the wall a→p and carry on drawing from p. */
  const commitSegment = (a: Point, p: Point) => {
    if (ptEq(a, p)) return;
    usePlanStore.getState().addWall(a, p);
    const len = dist(a, p);
    setLastDir({ x: (p.x - a.x) / len, y: (p.y - a.y) / len });
    setAnchor(p);
    setTyped('');
    refresh();
  };

  /** Enter with a typed length: place the next point exactly that far along the current direction. */
  const commitTyped = () => {
    const a = anchorRef.current;
    const text = typedRef.current;
    if (!a || !text) return;
    const m = parseLength(text, currentUnits());
    const p = m !== null && m >= MIN_WALL ? draftEnd(a, snapRef.current?.p ?? null, text, lastDirRef.current) : null;
    if (!p) {
      toastError(`Couldn't read “${text}” as a length.`);
      setTyped('');
      return;
    }
    commitSegment(a, p);
  };

  const pointerMove = (raw: Point, shift: boolean, alt = false) => {
    pointer.current = { raw, shift, alt };
    refresh();
  };

  /**
   * A press on bare canvas or a room's floor with the select tool may become a
   * selection rectangle. It is followed on the window, so it carries on (and
   * always ends) wherever the pointer goes; until it has travelled a few
   * pixels it is still just a click. With Shift it adds to the selection.
   * Esc puts back `prior`, what was selected before the press.
   */
  const startMarquee = (start: Point, ev: MouseEvent, prior: PlanSelection) => {
    marqueeDrag.current?.stop();
    const base: PlanSelection = ev.shiftKey ? prior : NO_SELECTION;
    const origin = { x: ev.clientX, y: ev.clientY };
    let active = false;
    const stop = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('blur', stop);
      marqueeDrag.current = null;
      setMarquee(null);
    };
    const onMove = (e: MouseEvent) => {
      if (e.buttons === 0) {
        stop(); // the release happened somewhere we never heard about
        return;
      }
      if (!active && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < MARQUEE_START_PX) return;
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      const p = toWorld(viewRef.current, e.clientX - r.left, e.clientY - r.top);
      active = true;
      setMarquee({ a: start, b: p });
      selectInBox(start, p, base);
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // To the canvas the release is also a click on the room the drag began in.
      if (active) swallowNextClick();
      stop();
    };
    marqueeDrag.current = {
      stop,
      cancel: () => {
        selectOnPlan(prior);
        stop();
      },
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', stop);
  };
  useEffect(() => () => marqueeDrag.current?.stop(), []);

  /** Client pixels → plan meters, with the view as it is now (it may pan or zoom mid-drag). */
  const clientToWorld = (clientX: number, clientY: number): Point | null => {
    const r = containerRef.current?.getBoundingClientRect();
    return r ? toWorld(viewRef.current, clientX - r.left, clientY - r.top) : null;
  };

  /**
   * A press on a selected part of a selection that moves as one piece (two or
   * more walls, or more than one kind of thing): everything selected follows
   * the pointer together, and walls joined to it follow as groupMove.ts says.
   * Followed on the window, so it always ends; until it has travelled a few
   * pixels it is still a click. ⇧ keeps it to one axis, ⌥ lets furniture
   * through things, Esc puts everything back. A mouse is followed by its own
   * events, as the canvas library does; a touch or a pen (`pen`) by pointer events.
   */
  const startGroupDrag = (ev: MouseEvent | PointerEvent, pen: boolean): boolean => {
    if (groupDrag.current) return false;
    const start = clientToWorld(ev.clientX, ev.clientY);
    const d = start ? beginGroupDrag() : null;
    if (!start || !d) return false;
    marqueeDrag.current?.stop();
    const id = pen && 'pointerId' in ev ? ev.pointerId : null;
    const ours = (e: MouseEvent) => id === null || ('pointerId' in e && e.pointerId === id);
    const move = pen ? 'pointermove' : 'mousemove';
    const up = pen ? 'pointerup' : 'mouseup';
    const origin = { x: ev.clientX, y: ev.clientY };
    let last = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, alt: ev.altKey };
    let active = false;

    const show = () => {
      const p = clientToWorld(last.x, last.y);
      if (!p) return;
      const res = moveGroupDrag(d, { x: p.x - start.x, y: p.y - start.y }, { lock: last.shift, free: last.alt });
      if (res === 'lost') finish('lost');
      else setGroupBlocked(d.blocked);
    };
    const onMove = (e: MouseEvent) => {
      if (!ours(e)) return;
      if (e.buttons === 0) {
        finish('drop'); // the release happened somewhere we never heard about
        return;
      }
      if (!active && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < MARQUEE_START_PX) return;
      if (!active) {
        active = true;
        setGroupMoving(true);
      }
      last = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey };
      show();
    };
    const onUp = (e: MouseEvent) => {
      if (!ours(e) || (id === null && e.button !== 0)) return;
      // To the canvas the release is also a click on what was grabbed, which would select it alone.
      if (active) swallowNextClick();
      finish('drop');
    };
    // The browser took the touch for itself.
    const onCancel = (e: PointerEvent) => {
      if (ours(e)) finish('cancel');
    };
    // A finger moving things must not also scroll or zoom the page.
    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    const onBlur = () => finish('drop');
    const handle = {
      again: (shift: boolean, alt: boolean) => {
        last = { ...last, shift, alt };
        if (active) show();
      },
      stop: () => finish('drop'),
      cancel: () => finish('cancel'),
    };
    const finish = (how: 'drop' | 'cancel' | 'lost') => {
      if (groupDrag.current !== handle) return;
      groupDrag.current = null;
      window.removeEventListener(move, onMove);
      window.removeEventListener(up, onUp, true);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('blur', onBlur);
      setGroupMoving(false);
      setGroupBlocked(false);
      endGroupDrag(d, how);
    };
    groupDrag.current = handle;
    window.addEventListener(move, onMove);
    window.addEventListener(up, onUp, true);
    if (pen) {
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
    }
    window.addEventListener('blur', onBlur);
    return true;
  };
  useEffect(() => () => groupDrag.current?.stop(), []);

  /** A press on `target`: if it is a selected part of a selection that moves as one piece, move all of it. */
  const grabSelection = (target: Konva.Node, ev: MouseEvent | PointerEvent, pen: boolean): boolean => {
    const ui = useUiStore.getState();
    if (ui.readOnly || ui.tool !== 'select' || !groupSelected(ui)) return false;
    const hit = planItemOf(target);
    return !!hit && currentSelection()[hit.kind].includes(hit.id) && startGroupDrag(ev, pen);
  };

  /** A left press with the current tool. `bare` = nothing was under the pointer. */
  const pointerDown = (raw: Point, shift: boolean, bare: boolean, alt = false) => {
    pointer.current = { raw, shift, alt };
    const ui = useUiStore.getState();
    const plan = usePlanStore.getState();
    const active = usableTool(ui.tool, ui.readOnly);
    const { scale } = viewRef.current;
    const radius = SNAP_RADIUS_PX / scale;

    if (active === 'measure') {
      const a = measureAnchorRef.current;
      const { p } = resolveDraftPoint(raw, {
        walls: plan.walls,
        grid: plan.settings.gridSize,
        radius,
        anchor: a,
        constrain: shift,
      });
      if (!a) setMeasureAnchor(p);
      else if (!ptEq(a, p)) {
        setMeasures([...measuresRef.current.slice(-(MAX_MEASURES - 1)), { a, b: p }]);
        setMeasureAnchor(null);
      }
      refresh();
      return;
    }

    if (active === 'wall') {
      // Read walls from the store (not the render closure) so rapid clicks
      // snap against walls created moments ago.
      const a = anchorRef.current;
      const { p } = resolveDraftPoint(raw, {
        walls: plan.walls,
        grid: plan.settings.gridSize,
        radius,
        anchor: a,
        constrain: shift,
      });
      if (!a) {
        setAnchor(p);
        setTyped('');
        refresh();
      } else {
        // A typed length wins over where the pointer happens to be.
        const end = draftEnd(a, p, typedRef.current, lastDirRef.current);
        if (end) commitSegment(a, end);
      }
      return;
    }

    if (active === 'door' || active === 'window') {
      // Recompute from the pointer (not the rendered ghost) so a click in the
      // same frame as a mouse move can't place against stale state.
      const existing = openingUnder(raw, active, scale);
      if (existing) {
        stepOpening(existing);
        refresh();
        return;
      }
      const g = computeGhost(raw, active, scale);
      if (g?.valid) {
        plan.addOpening(g.wallId, active, g.offset, DEFAULT_OPENING_WIDTH[active]);
        refresh();
      }
      return;
    }

    if (active === 'furniture') {
      if (ui.placingKind) {
        // Worked out again from the pointer, not from what was drawn: a piece only goes where it fits.
        const spot = placingSpot(raw, alt);
        if (spot.fits) plan.addFurniture(ui.placingKind, spot.p.x, spot.p.y, placeRotationRef.current);
        refresh();
      }
      return;
    }

    // Select tool: clicking bare canvas clears the selection (Shift keeps it, to add to).
    if (bare && !ui.readOnly && !shift) ui.setSelection([]);
  };

  // --- pointer handlers ---
  const handleMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const pos = stageRef.current?.getPointerPosition();
    if (!pos) return;
    pointerMove(toWorld(view, pos.x, pos.y), e.evt.shiftKey, e.evt.altKey);
    // Re-derived on every move, so it can't stick when a shape goes away.
    setHoverCursor(tool === 'select' && !readOnly ? cursorOf(e.target) : null);
  };

  const handleMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos || e.evt.button !== 0) return;
    // A pen's press, already being followed as one (handlePointerDown).
    if (groupDrag.current) return;
    const raw = toWorld(view, pos.x, pos.y);
    const bare = e.target === stage;
    if (!bare && grabSelection(e.target, e.evt, false)) return;
    const ui = useUiStore.getState();
    // What was selected before this press clears it: Esc on the rectangle puts it back.
    const prior = standingSelection();
    pointerDown(raw, e.evt.shiftKey, bare, e.evt.altKey);
    if (ui.tool === 'select' && !ui.readOnly && (bare || e.target.hasName(ROOM_FILL))) startMarquee(raw, e.evt, prior);
  };

  // A touch or a pen can move the selection as one piece too (a mouse comes through handleMouseDown).
  const handlePointerDown = (e: KonvaEventObject<PointerEvent>) => {
    if (e.evt.pointerType === 'mouse' || !e.evt.isPrimary || e.target === stageRef.current) return;
    grabSelection(e.target, e.evt, true);
  };

  const handleMouseLeave = () => {
    pointer.current = null;
    setSnap(null);
    setGhost(null);
    setHoverCursor(null);
    useUiStore.getState().setCursor(null);
  };

  // Right-click ends a wall run / drops a half-made measurement instead of opening a menu.
  const handleContextMenu = (e: KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
    endRun();
    setMeasureAnchor(null);
  };

  // --- keyboard: V W D N F M L C 0 R ⌫ arrows ⌘D Enter Esc (App owns ⌘K ⌘Z G P B ?) ---
  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target)) return;
    const ui = useUiStore.getState();
    // Nothing on the canvas reacts behind the command bar, the shortcut sheet or the API-key dialog.
    if (ui.mode !== 'plan' || ui.commandOpen || ui.shortcutsOpen || useKeyStore.getState().asking) return;

    // While the selection is being moved: Esc puts it back, ⇧ and ⌥ change the move at once, nothing else.
    if (groupDrag.current) {
      if (e.key === 'Escape') {
        e.preventDefault();
        groupDrag.current.cancel();
      } else if (e.key === 'Shift' || e.key === 'Alt') groupDrag.current.again(e.shiftKey, e.altKey);
      return;
    }

    if (e.key === 'Shift') {
      // Lock / release the angle without waiting for the mouse to move.
      if (pointer.current && !pointer.current.shift) {
        pointer.current.shift = true;
        refresh();
      }
      return;
    }
    if (e.key === 'Alt') {
      // ⌥: the piece being placed may overlap things, at once.
      if (pointer.current && !pointer.current.alt) {
        pointer.current.alt = true;
        refresh();
      }
      return;
    }

    const ro = ui.readOnly;
    const active = usableTool(ui.tool, ro);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (e.metaKey || e.ctrlKey) {
      // The chords the canvas owns: ⌘D ⌘C ⌘X ⌘V ⌘A. Everything else (⌘F, any of these with Shift…) is the browser's.
      if (e.altKey || e.shiftKey || ro) return;
      if ('cxva'.includes(key) && isInPanel(e.target)) return;
      if (key === 'd') {
        e.preventDefault();
        if (!e.repeat) duplicateSelection();
      } else if (key === 'c' || key === 'x') {
        // Text selected on the page is the browser's to copy.
        if (window.getSelection()?.toString()) return;
        if (e.repeat) e.preventDefault();
        else if (key === 'c' ? copySelection() : cutSelection()) e.preventDefault();
      } else if (key === 'v') {
        if (!hasClipboard()) return;
        e.preventDefault();
        if (!e.repeat) {
          endRun();
          pasteClipboard(pointer.current?.raw ?? null);
        }
      } else if (key === 'a') {
        e.preventDefault();
        if (!e.repeat) {
          endRun();
          selectAll();
        }
      }
      return;
    }
    if (e.code === 'Space') return;
    // ⌥ with an arrow nudges furniture through whatever is in the way; ⌥ with anything else is not ours.
    if (e.altKey) {
      const step = arrowDelta(e.key, e.shiftKey ? fineStep(currentUnits()) : usePlanStore.getState().settings.gridSize);
      if (step && active === 'select' && nudgeSelection(step, true)) e.preventDefault();
      return;
    }

    // While a wall is being drawn, numbers are a length.
    if (active === 'wall' && anchorRef.current) {
      if (key === 'Enter' && typedRef.current) {
        e.preventDefault();
        commitTyped();
        return;
      }
      const next = typedLengthKey(typedRef.current, e.key);
      if (next !== null) {
        e.preventDefault();
        setTyped(next);
        return;
      }
    }

    const arrow = arrowDelta(
      e.key,
      e.shiftKey ? fineStep(currentUnits()) : usePlanStore.getState().settings.gridSize,
    );
    if (arrow) {
      if (active === 'select' && nudgeSelection(arrow)) e.preventDefault();
      return;
    }
    if (e.repeat) return;
    // Enter on a button the keyboard is on presses that button.
    if (key === 'Enter' && isKeyboardFocusedControl(e.target)) return;

    switch (key) {
      case 'Escape':
        if (marqueeDrag.current) marqueeDrag.current.cancel();
        else if (typedRef.current) setTyped('');
        else if (anchorRef.current) endRun();
        else if (measureAnchorRef.current) setMeasureAnchor(null);
        else if (measuresRef.current.length) setMeasures([]);
        else ui.setTool('select'); // also drops the selection
        break;
      case 'Enter':
        if (anchorRef.current) {
          e.preventDefault(); // don't also press whichever toolbar button was clicked last
          endRun();
        }
        break;
      case 'v':
        ui.setTool('select');
        break;
      case 'm':
        ui.setTool('measure');
        break;
      case 'l':
        ui.setShowDimensions(!ui.showDimensions);
        break;
      case 'c':
        ui.setDrawingLook(ui.drawingLook === 'color' ? 'paper' : 'color');
        break;
      case '0':
        fit();
        break;
      case 'w':
        if (ro) break;
        endRun();
        ui.setTool('wall');
        break;
      case 'd':
        if (!ro) ui.setTool('door');
        break;
      case 'n':
        if (!ro) ui.setTool('window');
        break;
      case 'f':
        if (!ro) ui.setPaletteOpen(!ui.paletteOpen);
        break;
      case 'r': {
        if (ro) break;
        const delta = e.shiftKey ? -Math.PI / 2 : Math.PI / 2;
        if (active === 'furniture') {
          setPlaceRotation(normAngle(placeRotationRef.current + delta));
          refresh(); // turned, it may fit somewhere else
        } else rotateSelection(delta);
        break;
      }
      case 'Delete':
      case 'Backspace':
        if (deleteSelection()) {
          e.preventDefault();
          setHoverCursor(null);
        }
        break;
    }
  });

  const onKeyUp = useEffectEvent((e: KeyboardEvent) => {
    if ((e.key === 'Shift' || e.key === 'Alt') && groupDrag.current) groupDrag.current.again(e.shiftKey, e.altKey);
    if (e.key === 'Shift' && pointer.current?.shift) {
      pointer.current.shift = false;
      refresh();
    }
    if (e.key === 'Alt' && pointer.current?.alt) {
      pointer.current.alt = false;
      refresh();
    }
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => onKeyDown(e);
    const up = (e: KeyboardEvent) => onKeyUp(e);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Transient drafting state must not outlive what it belongs to: the tool,
  // the document (a whole-plan swap bumps fitNonce), edit rights, the view.
  useEffect(() => {
    const unsubUi = useUiStore.subscribe((s, prev) => {
      const toolChanged = s.tool !== prev.tool;
      const swapped =
        s.fitNonce !== prev.fitNonce || s.readOnly !== prev.readOnly || s.mode !== prev.mode;
      if (!toolChanged && !swapped) return;
      marqueeDrag.current?.stop();
      groupDrag.current?.stop();
      if (swapped || s.tool !== 'wall') {
        setAnchor(null);
        setTyped('');
      }
      if (swapped || s.tool !== 'measure') {
        setMeasureAnchor(null);
        setMeasures([]);
      }
      if (swapped) setEditingRoomKey(null);
      // A different document: ids selected in the old one mean nothing here.
      if (s.fitNonce !== prev.fitNonce) s.setSelection([]);
      setSnapRaw(null);
      setGhost(null);
      setHoverCursor(null);
      setHoverWallId(null);
      setHoverRoomKey(null);
    });
    // Something under the pointer may have just been removed (⌫, undo).
    const unsubPlan = usePlanStore.subscribe((s, prev) => {
      if (
        s.walls.length < prev.walls.length ||
        s.openings.length < prev.openings.length ||
        s.furniture.length < prev.furniture.length
      ) {
        setHoverCursor(null);
        setHoverWallId(null);
        setHoverRoomKey(null);
      }
    });
    return () => {
      unsubUi();
      unsubPlan();
    };
  }, [setAnchor, setTyped, setMeasureAnchor, setMeasures, setSnapRaw]);

  const rooms = useMemo(() => roomsFor(walls), [walls]);
  const roomOutlines = useMemo(() => rooms.map((r) => r.polygon), [rooms]);
  const grid = useMemo(
    () => buildGridLines(view, size, settings.gridSize),
    [view, size, settings.gridSize],
  );
  const aiGhosts = useMemo(
    () => aiItems.map((f, i) => ({ ...f, id: `__ai-${i}` })),
    [aiItems],
  );

  // The Color look's geometry. Each piece is rebuilt only when its slice of the
  // plan changes — never on a mouse move, a pan or a zoom.
  const thickness = settings.wallThickness;
  const poche = useMemo(
    () => (color ? pocheFor(walls, openings, thickness) : null),
    [color, walls, openings, thickness],
  );
  const footprint = useMemo(
    () => (color ? footprintFor(walls, thickness, roomOutlines) : null),
    [color, walls, thickness, roomOutlines],
  );
  const entrance = useMemo(
    () =>
      poche
        ? findEntrance(
            poche.body.gaps,
            rooms.map((r) => ({ polygon: r.polygon, name: roomNames[r.key] })),
            thickness,
          )
        : null,
    [poche, rooms, roomNames, thickness],
  );
  // Where each labelled door or window carries its label: outside the house on
  // an outside wall, clear of the swing, and never across a room's own label.
  const openingLabels = useMemo(() => {
    const spots = new Map<string, Point>();
    if (!openings.some((o) => o.label)) return spots;
    const avoid: LabelBox[] = [];
    for (const room of rooms) {
      const at = labelAnchor(room.polygon, room.centroid);
      const text = { name: roomNames[room.key] ?? 'Room', ...roomText(room, units) };
      const box = roomLabelBox(at, fitRoomLabel(room.polygon, at, view.scale, thickness, text), text, view.scale);
      if (box) avoid.push(box);
    }
    for (const o of openings) {
      const wall = o.label ? walls.find((w) => w.id === o.wallId) : undefined;
      const len = wall ? dist(wall.a, wall.b) : 0;
      if (!o.label || !wall || len < 1e-6) continue;
      const dir = { x: (wall.b.x - wall.a.x) / len, y: (wall.b.y - wall.a.y) / len };
      const spot = openingLabelSpot(
        {
          text: o.label,
          center: { x: wall.a.x + dir.x * o.offset, y: wall.a.y + dir.y * o.offset },
          dir,
          width: o.width,
          door: o.type === 'door',
          marker: entrance?.openingId === o.id ? { at: entrance.at, size: entranceMarkerSize(view.scale) } : null,
        },
        { scale: view.scale, thickness, rooms: roomOutlines, avoid },
      );
      if (spot) spots.set(o.id, spot);
    }
    return spots;
  }, [openings, walls, rooms, roomOutlines, roomNames, units, thickness, entrance, view.scale]);
  // What stands on what (stacking.ts), worked out from positions on every edit.
  const rest = useMemo(() => {
    void customItems; // furnitureDef reads a mirror of these
    return restOf(furniture, furnitureDef);
  }, [furniture, customItems]);
  // Rugs and other flat things go down first, so furniture stands on them; whatever rests on a piece is
  // drawn over it, so a click finds the plate before the table it is on.
  const drawOrder = useMemo(() => {
    const flat = (f: Furniture): boolean => {
      const h = isCustomKind(f.kind) ? customItems[customId(f.kind)]?.h : furnitureDef(f.kind).h;
      return h !== undefined && h <= 0.06;
    };
    return stackOrder(furniture, rest, flat);
  }, [furniture, customItems, rest]);

  // The segment being drawn, and the length the status bar shows for it.
  const target = tool === 'wall' && anchor ? draftEnd(anchor, snap?.p ?? null, typed, lastDir) : null;
  const liveLength =
    anchor && target
      ? dist(anchor, target)
      : tool === 'measure' && measureAnchor && snap
        ? dist(measureAnchor, snap.p)
        : null;
  useEffect(() => {
    useUiStore.getState().setDrawingLength(liveLength);
  }, [liveLength]);

  // Test/debug hooks: let tooling map world coords → screen exactly and drive the tools.
  useEffect(() => {
    if (import.meta.env.DEV) window.__view = view;
  }, [view]);
  useEffect(() => {
    if (import.meta.env.DEV) window.__rooms = rooms;
  }, [rooms]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    setEditorDriver({
      state: () => ({
        view: viewRef.current,
        size,
        tool,
        anchor: anchorRef.current,
        typed: typedRef.current,
        snap: snapRef.current,
        ghost,
        measureAnchor: measureAnchorRef.current,
        measures: measuresRef.current,
        look: color ? 'color' : 'paper',
        hoverWallId,
        hoverRoomKey,
        placeRotation: placeRotationRef.current,
        spaceDown,
        panning,
        hoverCursor,
      }),
      hover: (x, y, opts) => pointerMove({ x, y }, !!opts?.shift),
      click: (x, y, opts) => pointerDown({ x, y }, !!opts?.shift, true),
      toClient: (x, y) => {
        const r = containerRef.current?.getBoundingClientRect();
        if (!r) return null;
        const p = toScreen(viewRef.current, { x, y });
        return { x: r.left + p.x, y: r.top + p.y };
      },
      fit,
    });
    return () => setEditorDriver(null);
  });

  const px = (n: number) => n / view.scale; // px → m at current zoom
  const snapRadiusM = SNAP_RADIUS_PX / view.scale;
  const editing = tool === 'select' && !readOnly;

  const cursorStyle = panning
    ? 'grabbing'
    : groupMoving
      ? 'move'
      : spaceDown
        ? 'grab'
        : tool !== 'select' || marquee
          ? 'crosshair'
          : (hoverCursor ?? 'default');

  // Handles, length tags and inspectors belong to a selection of one kind of thing;
  // a mixed one (a rectangle, a paste) is only highlighted, to be moved, copied or deleted whole.
  const kinds =
    Number(selectedWallIds.length > 0) + Number(selectedOpeningIds.length > 0) + Number(selectedFurnitureIds.length > 0);
  const oneKind = editing && kinds === 1 && !marquee;
  // Dragging any selected part of it moves all of it (startGroupDrag), not just that part.
  const grouped = editing && groupSelected({ selectedWallIds, selectedOpeningIds, selectedFurnitureIds });
  const handleWallIds = oneKind && selectedWallIds.length <= MAX_WALL_HANDLES ? selectedWallIds : NO_IDS;
  const selectedWalls = handleWallIds.length ? walls.filter((w) => handleWallIds.includes(w.id)) : [];
  const selectedOpening =
    oneKind && selectedOpeningIds.length === 1
      ? openings.find((o) => o.id === selectedOpeningIds[0])
      : undefined;
  const selectedOpeningWall = selectedOpening && walls.find((w) => w.id === selectedOpening.wallId);
  const selectedItem =
    oneKind && selectedFurnitureIds.length === 1
      ? furniture.find((f) => f.id === selectedFurnitureIds[0])
      : undefined;

  // The AI panel stays up for the room being furnished even if the selection moved.
  const aiRoom = !readOnly && aiStatus !== 'idle' ? rooms.find((r) => r.key === aiRoomKey) : undefined;
  const panelRoom = editing
    ? ((selectedRoomKey ? rooms.find((r) => r.key === selectedRoomKey) : undefined) ?? aiRoom)
    : undefined;

  const ghostWall =
    (tool === 'door' || tool === 'window') && ghost
      ? walls.find((w) => w.id === ghost.wallId)
      : undefined;

  return (
    <div
      ref={containerRef}
      className="plan-canvas"
      style={{ cursor: cursorStyle }}
      onMouseDownCapture={onMouseDownCapture}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        x={view.tx}
        y={view.ty}
        scaleX={view.scale}
        scaleY={view.scale}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onPointerDown={handlePointerDown}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      >
        <Layer listening={false}>
          {footprint && <HouseShadow loops={footprint} />}
          <GridLayerLines grid={grid} scale={view.scale} />
        </Layer>

        {/* The plan itself. Nothing here changes on a mouse move, so drawing and
            measuring only repaint the overlay layer above. */}
        <Layer>
          {rooms.map((room) => (
            <RoomFill
              key={room.key}
              room={room}
              selected={editing && selectedRoomKey === room.key}
              hovered={editing && hoverRoomKey === room.key}
              interactive={editing}
              color={color}
              edge={Math.max(thickness, 2 / view.scale) + 5 / view.scale}
              onRename={setEditingRoomKey}
              onHover={setHoverRoomKey}
            />
          ))}

          {drawOrder.map((f) => {
            const selected = editing && selectedFurnitureIds.includes(f.id);
            return (
              <FurnitureShape
                key={f.id}
                item={f}
                scale={view.scale}
                selected={selected}
                grouped={selected && grouped}
                invalid={selected && grouped && groupBlocked}
                interactive={editing}
                look={color ? 'color' : 'paper'}
              />
            );
          })}

          {/* AI suggestion preview ghosts — only for a room that is still there, never in a read-only view */}
          {aiStatus === 'preview' &&
            aiRoom &&
            aiGhosts.map((f) => (
              <FurnitureShape
                key={f.id}
                item={f}
                scale={view.scale}
                selected={false}
                interactive={false}
                ghost
              />
            ))}

          {poche && (
            <WallPoche
              poche={poche}
              thickness={thickness}
              scale={view.scale}
              selectedIds={editing ? selectedWallIds : NO_IDS}
              hoverId={editing ? hoverWallId : null}
            />
          )}
          {walls.map((w) => {
            const selected = editing && selectedWallIds.includes(w.id);
            return (
              <WallLine
                key={w.id}
                wall={w}
                thickness={settings.wallThickness}
                scale={view.scale}
                selected={selected}
                grouped={selected && grouped}
                interactive={editing}
                poche={color}
                onHover={setHoverWallId}
              />
            );
          })}

          {showDimensions && (
            <WallDimensions
              walls={walls}
              rooms={roomOutlines}
              thickness={settings.wallThickness}
              scale={view.scale}
              units={units}
              hiddenIds={handleWallIds}
            />
          )}

          {openings.map((o) => {
            const wall = walls.find((w) => w.id === o.wallId);
            if (!wall) return null;
            const selected = editing && selectedOpeningIds.includes(o.id);
            return (
              <OpeningShape
                key={o.id}
                wall={wall}
                opening={o}
                thickness={settings.wallThickness}
                scale={view.scale}
                selected={selected}
                grouped={selected && grouped}
                interactive={editing}
                look={color ? 'color' : 'paper'}
                labelAt={openingLabels.get(o.id) ?? null}
              />
            );
          })}

          {entrance && <EntranceMarker entrance={entrance} scale={view.scale} />}
        </Layer>

        {/* Overlay: ghosts, handles, the segment being drawn, measurements. */}
        <Layer>
          {/* furniture placement ghost */}
          {tool === 'furniture' && placingKind && snap && (
            <FurnitureShape
              item={{
                id: '__ghost',
                kind: placingKind,
                x: snap.p.x,
                y: snap.p.y,
                rotation: placeRotation,
              }}
              scale={view.scale}
              selected={false}
              interactive={false}
              ghost
              invalid={!placeFits}
            />
          )}

          {/* door / window placement ghost — red where it can't go */}
          {(tool === 'door' || tool === 'window') && ghost && ghostWall && (
            <OpeningShape
              wall={ghostWall}
              opening={{
                id: '__ghost',
                wallId: ghost.wallId,
                type: tool,
                offset: ghost.offset,
                width: DEFAULT_OPENING_WIDTH[tool],
              }}
              thickness={settings.wallThickness}
              scale={view.scale}
              selected={false}
              interactive={false}
              ghost
              invalid={!ghost.valid}
              look={color ? 'color' : 'paper'}
            />
          )}

          {selectedWalls.map((w) => (
            <EndpointHandles key={w.id} wallId={w.id} scale={view.scale} snapRadiusM={snapRadiusM} />
          ))}

          {/* drawing preview */}
          {tool === 'wall' && anchor && (
            <>
              {target && (
                <Line
                  points={[anchor.x, anchor.y, target.x, target.y]}
                  stroke={theme.accent}
                  strokeWidth={Math.max(settings.wallThickness, px(1.5))}
                  opacity={0.55}
                  lineCap="round"
                  dash={[px(6), px(5)]}
                  listening={false}
                />
              )}
              {(target || typed) && (
                <LengthTag
                  at={target ? midpoint(anchor, target) : anchor}
                  text={typed ? `${typed}_` : formatLength(dist(anchor, target ?? anchor), units)}
                  scale={view.scale}
                  accent
                  clear={settings.wallThickness / 2}
                />
              )}
              <Circle x={anchor.x} y={anchor.y} radius={px(3.5)} fill={theme.accent} listening={false} />
            </>
          )}

          {/* measurements (transient) */}
          {measures.map((m, i) => (
            <MeasureLine key={i} a={m.a} b={m.b} scale={view.scale} units={units} />
          ))}
          {tool === 'measure' && measureAnchor && snap && (
            <MeasureLine a={measureAnchor} b={snap.p} scale={view.scale} units={units} live />
          )}

          {/* the selection rectangle being dragged */}
          {marquee && (
            <Rect
              x={Math.min(marquee.a.x, marquee.b.x)}
              y={Math.min(marquee.a.y, marquee.b.y)}
              width={Math.abs(marquee.b.x - marquee.a.x)}
              height={Math.abs(marquee.b.y - marquee.a.y)}
              fill={theme.accentSoft}
              stroke={theme.accent}
              strokeWidth={px(1)}
              dash={[px(4), px(3)]}
              listening={false}
            />
          )}

          {/* where the next click lands */}
          {(tool === 'wall' || tool === 'measure') && (target ?? snap?.p) && (
            <SnapMarker
              p={(target ?? snap?.p)!}
              endpoint={snap?.kind === 'endpoint' && (!target || ptEq(target, snap.p))}
              scale={view.scale}
            />
          )}
        </Layer>
      </Stage>

      {/* Room labels live in HTML so they stay readable at any zoom. */}
      {rooms.map((room) => (
        <RoomLabel
          key={room.key}
          room={room}
          view={view}
          interactive={editing}
          thickness={thickness}
          editing={editingRoomKey === room.key}
          onStartEdit={() => setEditingRoomKey(room.key)}
          onEndEdit={() => setEditingRoomKey(null)}
        />
      ))}

      {selectedWalls.map((w) => (
        <WallLengthTag
          key={w.id}
          wall={w}
          view={view}
          side={dimensionSide(w, roomOutlines)}
          thickness={settings.wallThickness}
        />
      ))}

      {selectedOpening && selectedOpeningWall && (
        <OpeningInspector
          key={selectedOpening.id}
          opening={selectedOpening}
          wall={selectedOpeningWall}
          view={view}
        />
      )}

      {selectedItem && (
        <FurnitureInspector
          key={selectedItem.id}
          item={selectedItem}
          view={view}
          size={size}
          rest={rest.get(selectedItem.id)}
        />
      )}

      {panelRoom && (
        <RoomAiPanel
          room={panelRoom}
          screenX={panelRoom.centroid.x * view.scale + view.tx}
          screenY={panelRoom.centroid.y * view.scale + view.ty + 36}
        />
      )}
    </div>
  );
}

const NO_IDS: string[] = [];

/**
 * The floor of a detected room. Click selects it, double-click renames it.
 * Color look: a pastel wash by what the room is (from its name), deeper under
 * the pointer, and warmed toward the accent with a line along the inside of
 * its walls when selected. Paper look: the one grey wash.
 */
const RoomFill = memo(function RoomFill({
  room,
  selected,
  hovered,
  interactive,
  color,
  edge,
  onRename,
  onHover,
}: {
  room: DetectedRoom;
  selected: boolean;
  hovered: boolean;
  interactive: boolean;
  color: boolean;
  /** width of the selection line, m: the wall it hides under plus what shows inside it */
  edge: number;
  onRename: (key: string) => void;
  onHover: (key: string | null) => void;
}) {
  const name = usePlanStore((s) => s.roomNames[room.key]);
  const points = useMemo(() => room.polygon.flatMap((p) => [p.x, p.y]), [room]);
  const tone = roomTone(name);
  const fill = !color
    ? selected
      ? theme.accentSoft
      : theme.roomFill
    : overPaper(selected ? tone.selected : hovered ? tone.hover : tone.fill, ROOM_FILL_ALPHA);
  return (
    <>
      <Line
        points={points}
        closed
        fill={fill}
        name={ROOM_FILL}
        listening={interactive}
        perfectDrawEnabled={false}
        onClick={(e) => {
          // The release that ends a selection rectangle is not a click on the room it began in.
          if (e.evt.button !== 0 || clickSwallowed()) return;
          e.cancelBubble = true;
          useUiStore.getState().setRoomSelection(room.key);
        }}
        onDblClick={() => onRename(room.key)}
        onMouseEnter={() => onHover(room.key)}
        onMouseLeave={() => onHover(null)}
      />
      {color && selected && (
        // Half of this line lies under the walls and the rest is clipped to the
        // room, so what shows is a thin accent line hugging the inside faces.
        <Group
          listening={false}
          clipFunc={(ctx) => {
            ctx.beginPath();
            for (let i = 0; i + 1 < points.length; i += 2) {
              if (i === 0) ctx.moveTo(points[i], points[i + 1]);
              else ctx.lineTo(points[i], points[i + 1]);
            }
            ctx.closePath();
          }}
        >
          <Line
            points={points}
            closed
            stroke={theme.accent}
            strokeWidth={edge}
            lineJoin="miter"
            listening={false}
            perfectDrawEnabled={false}
          />
        </Group>
      )}
    </>
  );
});

/** Both corner handles of a selected wall (the wall is read live so a drag never works on a stale copy). */
function EndpointHandles({
  wallId,
  scale,
  snapRadiusM,
}: {
  wallId: string;
  scale: number;
  snapRadiusM: number;
}) {
  const wall = usePlanStore((s) => s.walls.find((w) => w.id === wallId));
  if (!wall) return null;
  return (
    <>
      <EndpointHandle wall={wall} end="a" scale={scale} snapRadiusM={snapRadiusM} />
      <EndpointHandle wall={wall} end="b" scale={scale} snapRadiusM={snapRadiusM} />
    </>
  );
}
