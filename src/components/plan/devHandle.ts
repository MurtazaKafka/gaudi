/**
 * Dev-only: `window.__gaudi.planEditor` — the canvas's edit actions plus a
 * live probe of its transient state, for tests and browser automation.
 */
import { furnitureDef, type FurnitureKind } from '../../catalog';
import { usePlanStore } from '../../store';
import { useUiStore } from '../../uiStore';
import * as actions from './actions';
import { fitRoomLabel, labelAnchor } from './labels';
import { roomTone, type DrawingLook } from './look';
import { findEntrance, footprintFor, pocheFor } from './poche';
import { roomText } from './roomText';
import { planShapes } from './symbol';
import type { View } from './view';

export interface EditorDriver {
  /** Transient canvas state: view, size, anchor, typed, snap, ghost, measures… */
  state: () => Record<string, unknown>;
  /** Move the pointer to a plan-space point (meters). */
  hover: (x: number, y: number, opts?: { shift?: boolean }) => void;
  /** Left-click the bare canvas at a plan-space point with the current tool. */
  click: (x: number, y: number, opts?: { shift?: boolean }) => void;
  /** Plan-space point → client (viewport) pixels, for synthesizing real mouse events. */
  toClient: (x: number, y: number) => { x: number; y: number } | null;
  fit: () => void;
}

let driver: EditorDriver | null = null;

/** The mounted canvas registers itself here (and unregisters with null). */
export function setEditorDriver(d: EditorDriver | null): void {
  driver = d;
}

const key = (k: string, opts: { shift?: boolean; meta?: boolean; code?: string } = {}): void => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: k,
      code: opts.code ?? (k === ' ' ? 'Space' : ''),
      shiftKey: !!opts.shift,
      metaKey: !!opts.meta,
      bubbles: true,
      cancelable: true,
    }),
  );
};

if (import.meta.env.DEV) {
  const planEditor = {
    ...actions,
    state: () => driver?.state() ?? null,
    hover: (x: number, y: number, opts?: { shift?: boolean }) => driver?.hover(x, y, opts),
    click: (x: number, y: number, opts?: { shift?: boolean }) => driver?.click(x, y, opts),
    toClient: (x: number, y: number) => driver?.toClient(x, y) ?? null,
    fit: () => driver?.fit(),
    /** Press a key as the keyboard would: key('3'), key('Enter'), key('d', { meta: true }). */
    key,
    /** Type a string one key at a time. */
    type: (text: string) => [...text].forEach((ch) => key(ch)),
  };
  /**
   * `window.__gaudi.look` — the Color / Paper switch and a probe of what the
   * Color look is drawing for the plan in the store right now.
   */
  const look = {
    get: (): DrawingLook => useUiStore.getState().drawingLook,
    set: (next: DrawingLook) => useUiStore.getState().setDrawingLook(next === 'paper' ? 'paper' : 'color'),
    toggle: () => {
      const ui = useUiStore.getState();
      ui.setDrawingLook(ui.drawingLook === 'color' ? 'paper' : 'color');
      return useUiStore.getState().drawingLook;
    },
    /** The wall body: is it one clean outline, how many loops, pieces per wall, openings as cut. */
    walls: () => {
      const { walls, openings, settings } = usePlanStore.getState();
      const p = pocheFor(walls, openings, settings.wallThickness);
      return {
        clean: p.body.clean,
        thickness: p.body.thickness,
        loops: p.loops.length,
        tiles: Object.fromEntries([...p.tilesOf].map(([id, t]) => [id, t.length])),
        gaps: p.body.gaps.map((g) => ({ id: g.id, type: g.type, width: g.width })),
        footprintLoops: footprintFor(walls, settings.wallThickness, actions.roomsFor(walls).map((r) => r.polygon)).length,
      };
    },
    /** Every room: its name, kind, colours, and what its label shows at the current zoom. */
    rooms: () => {
      const { walls, roomNames, settings } = usePlanStore.getState();
      const view = (driver?.state().view as View | undefined) ?? { scale: 60, tx: 0, ty: 0 };
      return actions.roomsFor(walls).map((r) => {
        const name = roomNames[r.key];
        const at = labelAnchor(r.polygon, r.centroid);
        const tone = roomTone(name);
        return {
          key: r.key,
          name: name ?? null,
          kind: tone.kind,
          fill: tone.fill,
          labelAt: at,
          ...roomText(r, settings.units),
          label: fitRoomLabel(r.polygon, at, view.scale, settings.wallThickness, {
            name: name ?? 'Room',
            ...roomText(r, settings.units),
          }),
        };
      });
    },
    /** The door marked as the entrance, if any. */
    entrance: () => {
      const { walls, openings, roomNames, settings } = usePlanStore.getState();
      const p = pocheFor(walls, openings, settings.wallThickness);
      return findEntrance(
        p.body.gaps,
        actions.roomsFor(walls).map((r) => ({ polygon: r.polygon, name: roomNames[r.key] })),
        settings.wallThickness,
      );
    },
    /** The top-down parts an item is drawn from: look.symbol('sofa'), look.symbol('custom:abc'). */
    symbol: (kind: FurnitureKind) => planShapes(furnitureDef(kind)),
  };
  const w = window as unknown as { __gaudi?: Record<string, unknown> };
  w.__gaudi = { ...(w.__gaudi ?? {}), planEditor, look };
}
