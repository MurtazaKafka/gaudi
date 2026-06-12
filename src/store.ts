import { create } from 'zustand';
import type { Opening, PlanSettings, Point, Wall } from './types';
import { dist, ptEq } from './geometry';

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
    if (removed.length) {
      set((s) => ({
        walls: kept,
        openings: s.openings.filter((o) => !removed.includes(o.wallId)),
      }));
    }
    return removed;
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
