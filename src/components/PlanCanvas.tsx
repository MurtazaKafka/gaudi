import { memo, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Stage } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { DEFAULT_OPENING_WIDTH, usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { useAiStore } from '../aiStore';
import { useKeyStore } from '../ai/client';
import { customId, furnitureDef, isCustomKind } from '../catalog';
import { dist, midpoint, nearestWallPoint, ptEq, type SnapResult } from '../geometry';
import { currentUnits, formatLength, parseLength, useUnits } from '../units';
import { toastError } from '../toast';
import { theme } from '../theme';
import type { DetectedRoom } from '../rooms';
import type { Furniture, OpeningType, Point, Tool } from '../types';
import { FurnitureShape } from './FurnitureShape';
import { RoomAiPanel } from './RoomAiPanel';
import {
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  roomsFor,
  rotateSelection,
} from './plan/actions';
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
import { isKeyboardFocusedControl, isTypingTarget, useViewport } from './plan/useViewport';
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
  /** Last pointer position in plan meters (unsnapped) and whether Shift was down. */
  const pointer = useRef<{ raw: Point; shift: boolean } | null>(null);

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
      const next = computeGhost(ptr.raw, active, scale);
      setGhost((prev) => (sameGhost(prev, next) ? prev : next));
      setSnap(null);
      ui.setCursor(ptr.raw);
    } else if (active === 'furniture') {
      const p = snapPointTo(ptr.raw, fineStep(plan.settings.units));
      setSnap({ p, kind: 'grid' });
      ui.setCursor(p);
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

  const pointerMove = (raw: Point, shift: boolean) => {
    pointer.current = { raw, shift };
    refresh();
  };

  /** A left press with the current tool. `bare` = nothing was under the pointer. */
  const pointerDown = (raw: Point, shift: boolean, bare: boolean) => {
    pointer.current = { raw, shift };
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
      const g = computeGhost(raw, active, scale);
      if (g?.valid) {
        plan.addOpening(g.wallId, active, g.offset, DEFAULT_OPENING_WIDTH[active]);
        refresh();
      }
      return;
    }

    if (active === 'furniture') {
      if (ui.placingKind) {
        const p = snapPointTo(raw, fineStep(plan.settings.units));
        plan.addFurniture(ui.placingKind, p.x, p.y, placeRotationRef.current);
      }
      return;
    }

    // Select tool: clicking bare canvas clears the selection.
    if (bare && !ui.readOnly) ui.setSelection([]);
  };

  // --- pointer handlers ---
  const handleMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const pos = stageRef.current?.getPointerPosition();
    if (!pos) return;
    pointerMove(toWorld(view, pos.x, pos.y), e.evt.shiftKey);
    // Re-derived on every move, so it can't stick when a shape goes away.
    setHoverCursor(tool === 'select' && !readOnly ? cursorOf(e.target) : null);
  };

  const handleMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos || e.evt.button !== 0) return;
    pointerDown(toWorld(view, pos.x, pos.y), e.evt.shiftKey, e.target === stage);
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

    if (e.key === 'Shift') {
      // Lock / release the angle without waiting for the mouse to move.
      if (pointer.current && !pointer.current.shift) {
        pointer.current.shift = true;
        refresh();
      }
      return;
    }

    const ro = ui.readOnly;
    const active = usableTool(ui.tool, ro);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (e.metaKey || e.ctrlKey) {
      // The only chord the canvas owns. Everything else (⌘V, ⌘F, ⌘D-with-Shift…) is the browser's.
      if (key === 'd' && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!e.repeat) duplicateSelection();
      }
      return;
    }
    if (e.altKey || e.code === 'Space') return;

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
        if (typedRef.current) setTyped('');
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
        if (active === 'furniture') setPlaceRotation(normAngle(placeRotationRef.current + delta));
        else rotateSelection(delta);
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
    if (e.key === 'Shift' && pointer.current?.shift) {
      pointer.current.shift = false;
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
  // Rugs and other flat things go down first, so furniture stands on them.
  const drawOrder = useMemo(() => {
    const flat = (f: Furniture): number => {
      const h = isCustomKind(f.kind) ? customItems[customId(f.kind)]?.h : furnitureDef(f.kind).h;
      return h !== undefined && h <= 0.06 ? 0 : 1;
    };
    return furniture.some((f) => flat(f) === 0) ? [...furniture].sort((a, b) => flat(a) - flat(b)) : furniture;
  }, [furniture, customItems]);

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
    : spaceDown
      ? 'grab'
      : tool !== 'select'
        ? 'crosshair'
        : (hoverCursor ?? 'default');

  const selectedWalls = editing ? walls.filter((w) => selectedWallIds.includes(w.id)) : [];
  const selectedOpening =
    editing && selectedOpeningIds.length === 1
      ? openings.find((o) => o.id === selectedOpeningIds[0])
      : undefined;
  const selectedOpeningWall = selectedOpening && walls.find((w) => w.id === selectedOpening.wallId);
  const selectedItem =
    editing && selectedFurnitureIds.length === 1
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

          {drawOrder.map((f) => (
            <FurnitureShape
              key={f.id}
              item={f}
              scale={view.scale}
              selected={editing && selectedFurnitureIds.includes(f.id)}
              interactive={editing}
              look={color ? 'color' : 'paper'}
            />
          ))}

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
          {walls.map((w) => (
            <WallLine
              key={w.id}
              wall={w}
              thickness={settings.wallThickness}
              scale={view.scale}
              selected={editing && selectedWallIds.includes(w.id)}
              interactive={editing}
              poche={color}
              onHover={setHoverWallId}
            />
          ))}

          {showDimensions && (
            <WallDimensions
              walls={walls}
              rooms={roomOutlines}
              thickness={settings.wallThickness}
              scale={view.scale}
              units={units}
              hiddenIds={editing ? selectedWallIds : NO_IDS}
            />
          )}

          {openings.map((o) => {
            const wall = walls.find((w) => w.id === o.wallId);
            if (!wall) return null;
            return (
              <OpeningShape
                key={o.id}
                wall={wall}
                opening={o}
                thickness={settings.wallThickness}
                scale={view.scale}
                selected={editing && selectedOpeningIds.includes(o.id)}
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
        <FurnitureInspector key={selectedItem.id} item={selectedItem} view={view} size={size} />
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
        listening={interactive}
        perfectDrawEnabled={false}
        onClick={(e) => {
          if (e.evt.button !== 0) return;
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
