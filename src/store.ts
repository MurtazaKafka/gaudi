import { create } from 'zustand';
import type { Opening, OpeningType, PlanSettings, Point, Wall } from './types';
import { dist, ptEq } from './geometry';

export const DEFAULT_OPENING_WIDTH: Record<OpeningType, number> = {
  door: 0.9,
  window: 1.2,
};

/** Margin kept between openings and wall ends / each other. */
const OPENING_GAP = 0.05;

export function openingFits(
  openings: Opening[],
  wall: Wall,
  offset: number,
  width: number,
  ignoreId?: string,
): boolean {
  const len = dist(wall.a, wall.b);
  if (offset - width / 2 < -1e-9 || offset + width / 2 > len + 1e-9) return false;
  return openings.every(
    (o) =>
      o.wallId !== wall.id ||
      o.id === ignoreId ||
      Math.abs(o.offset - offset) >= (o.width + width) / 2 + OPENING_GAP,
  );
}

/** Clamp an opening's center so it sits fully on the wall. */
export function clampOffset(wall: Wall, offset: number, width: number): number {
  const len = dist(wall.a, wall.b);
  const half = width / 2 + OPENING_GAP;
  return Math.min(Math.max(offset, half), Math.max(half, len - half));
}

export interface EndpointRef {
  wallId: string;
  end: 'a' | 'b';
}

interface PlanState {
  walls: Wall[];
  openings: Opening[];
  roomNames: Record<string, string>;
  settings: PlanSettings;

  addWall: (a: Point, b: Point) => void;
  deleteWalls: (ids: string[]) => void;
  /** Move a fixed set of wall endpoints (a junction frozen at drag start) to `to`. */
  moveEndpoints: (refs: EndpointRef[], to: Point) => void;
  /** Drop zero-length walls and exact duplicates (after drags). Returns removed ids. */
  cleanupWalls: () => string[];
  /** Place an opening centered at `offset` (m from endpoint A). No-op if it doesn't fit. */
  addOpening: (wallId: string, type: OpeningType, offset: number, width: number) => void;
  deleteOpenings: (ids: string[]) => void;
  updateOpeningWidth: (id: string, width: number) => void;
  setRoomName: (key: string, name: string) => void;
  updateSettings: (patch: Partial<PlanSettings>) => void;
}

export const defaultSettings: PlanSettings = {
  wallHeight: 2.7,
  wallThickness: 0.1,
  gridSize: 0.5,
};

export const usePlanStore = create<PlanState>((set, get) => ({
  walls: [],
  openings: [],
  roomNames: {},
  settings: { ...defaultSettings },

  addWall: (a, b) => {
    if (ptEq(a, b)) return;
    const exists = get().walls.some(
      (w) => (ptEq(w.a, a) && ptEq(w.b, b)) || (ptEq(w.a, b) && ptEq(w.b, a)),
    );
    if (exists) return;
    set((s) => ({
      walls: [...s.walls, { id: crypto.randomUUID(), a: { ...a }, b: { ...b } }],
    }));
  },

  deleteWalls: (ids) =>
    set((s) => ({
      walls: s.walls.filter((w) => !ids.includes(w.id)),
      openings: s.openings.filter((o) => !ids.includes(o.wallId)),
    })),

  moveEndpoints: (refs, to) =>
    set((s) => ({
      walls: s.walls.map((w) => {
        const moveA = refs.some((r) => r.wallId === w.id && r.end === 'a');
        const moveB = refs.some((r) => r.wallId === w.id && r.end === 'b');
        if (!moveA && !moveB) return w;
        return { ...w, a: moveA ? { ...to } : w.a, b: moveB ? { ...to } : w.b };
      }),
    })),

  cleanupWalls: () => {
    const removed: string[] = [];
    const kept: Wall[] = [];
    for (const w of get().walls) {
      const degenerate = dist(w.a, w.b) < 0.01;
      const dup = kept.some(
        (k) => (ptEq(k.a, w.a) && ptEq(k.b, w.b)) || (ptEq(k.a, w.b) && ptEq(k.b, w.a)),
      );
      if (degenerate || dup) removed.push(w.id);
      else kept.push(w);
    }

    // Re-fit openings: walls may have shrunk under them.
    const openings: Opening[] = [];
    for (const o of get().openings) {
      if (removed.includes(o.wallId)) continue;
      const wall = kept.find((w) => w.id === o.wallId);
      if (!wall) continue;
      if (dist(wall.a, wall.b) < o.width + 2 * OPENING_GAP) continue;
      const offset = clampOffset(wall, o.offset, o.width);
      openings.push(offset === o.offset ? o : { ...o, offset });
    }

    set({ walls: kept, openings });
    return removed;
  },

  addOpening: (wallId, type, offset, width) => {
    const { walls, openings } = get();
    const wall = walls.find((w) => w.id === wallId);
    if (!wall) return;
    const clamped = clampOffset(wall, offset, width);
    if (!openingFits(openings, wall, clamped, width)) return;
    set((s) => ({
      openings: [
        ...s.openings,
        { id: crypto.randomUUID(), wallId, type, offset: clamped, width },
      ],
    }));
  },

  deleteOpenings: (ids) =>
    set((s) => ({ openings: s.openings.filter((o) => !ids.includes(o.id)) })),

  updateOpeningWidth: (id, width) => {
    const { walls, openings } = get();
    const opening = openings.find((o) => o.id === id);
    const wall = opening && walls.find((w) => w.id === opening.wallId);
    if (!opening || !wall) return;
    const w = Math.min(Math.max(width, 0.4), dist(wall.a, wall.b) - 2 * OPENING_GAP);
    const offset = clampOffset(wall, opening.offset, w);
    if (!openingFits(openings, wall, offset, w, id)) return;
    set((s) => ({
      openings: s.openings.map((o) => (o.id === id ? { ...o, width: w, offset } : o)),
    }));
  },

  setRoomName: (key, name) =>
    set((s) => {
      const roomNames = { ...s.roomNames };
      if (name.trim()) roomNames[key] = name.trim();
      else delete roomNames[key];
      return { roomNames };
    }),

  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
}));

declare global {
  interface Window {
    __plan?: typeof usePlanStore;
  }
}
if (import.meta.env.DEV) window.__plan = usePlanStore;
