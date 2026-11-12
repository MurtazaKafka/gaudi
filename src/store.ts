import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { toastError } from './toast';
import type {
  CustomItem,
  Furniture,
  Opening,
  OpeningType,
  PlanData,
  PlanLook,
  PlanSettings,
  Point,
  Wall,
} from './types';
import { customKind, setCustomDefs, type FurnitureKind } from './catalog';
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

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
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

export interface PlanState extends PlanData {

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
  addFurniture: (kind: FurnitureKind, x: number, y: number, rotation: number) => string;
  /** Add several at once (AI suggestions land as one batch). */
  addFurnitureBatch: (items: Omit<Furniture, 'id'>[]) => void;
  moveFurniture: (id: string, x: number, y: number) => void;
  rotateFurniture: (id: string, delta: number) => void;
  deleteFurniture: (ids: string[]) => void;
  setRoomName: (key: string, name: string) => void;
  updateSettings: (patch: Partial<PlanSettings>) => void;
  /** Patch any fields of one furniture item (label, kind, position…). */
  updateFurniture: (id: string, patch: Partial<Omit<Furniture, 'id'>>) => void;
  /** Add or replace a plan-local furniture definition. */
  putCustomItem: (item: CustomItem) => void;
  /** Remove a custom definition and every placed instance of it. */
  removeCustomItem: (id: string) => void;
  setLook: (patch: Partial<PlanLook>) => void;
  setName: (name: string) => void;
  /** Replace the whole document. Prefer `applyPlanData` (plan.ts), which also handles history. */
  setPlan: (plan: PlanData) => void;
}

export const defaultSettings: PlanSettings = {
  wallHeight: 2.7,
  wallThickness: 0.1,
  gridSize: 0.5,
  units: 'm',
};

export const defaultLook: PlanLook = { style: 'maquette', roof: 'none' };

export const DEFAULT_PLAN_NAME = 'Untitled plan';

export function emptyPlanData(): PlanData {
  return {
    name: DEFAULT_PLAN_NAME,
    walls: [],
    openings: [],
    furniture: [],
    roomNames: {},
    settings: { ...defaultSettings },
    customItems: {},
    look: { ...defaultLook },
  };
}

/** The document fields of the store — the single list of what "the plan" is. */
export const PLAN_KEYS = [
  'name',
  'walls',
  'openings',
  'furniture',
  'roomNames',
  'settings',
  'customItems',
  'look',
] as const satisfies readonly (keyof PlanData)[];

export function pickPlan(s: PlanData): PlanData {
  return {
    name: s.name,
    walls: s.walls,
    openings: s.openings,
    furniture: s.furniture,
    roomNames: s.roomNames,
    settings: s.settings,
    customItems: s.customItems,
    look: s.look,
  };
}

let lastFullWarning = 0;

/** When the "storage is full" notice below was last shown (epoch ms, 0 = never), so nothing else repeats it. */
export const lastStorageWarning = (): number => lastFullWarning;

/**
 * localStorage, except a refused write (quota, private mode) is reported
 * instead of thrown — a throw here would escape from whichever store action
 * happened to trigger the save and leave the app half-updated.
 */
const safeStorage = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      const now = Date.now();
      if (now - lastFullWarning > 30_000) {
        lastFullWarning = now;
        toastError("This browser's storage is full — changes aren't being saved. Export the plan, or delete old projects.");
      }
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  },
};

export const usePlanStore = create<PlanState>()(
  persist(
    (set, get) => ({
      ...emptyPlanData(),

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

  addFurniture: (kind, x, y, rotation) => {
    const id = crypto.randomUUID();
    set((s) => ({
      furniture: [...s.furniture, { id, kind, x: round3(x), y: round3(y), rotation }],
    }));
    return id;
  },

  addFurnitureBatch: (items) =>
    set((s) => ({
      furniture: [
        ...s.furniture,
        ...items.map((f) => ({ ...f, id: crypto.randomUUID() })),
      ],
    })),

  moveFurniture: (id, x, y) =>
    set((s) => ({
      furniture: s.furniture.map((f) =>
        f.id === id ? { ...f, x: round3(x), y: round3(y) } : f,
      ),
    })),

  rotateFurniture: (id, delta) =>
    set((s) => ({
      furniture: s.furniture.map((f) =>
        f.id === id ? { ...f, rotation: f.rotation + delta } : f,
      ),
    })),

  deleteFurniture: (ids) =>
    set((s) => ({ furniture: s.furniture.filter((f) => !ids.includes(f.id)) })),

  setRoomName: (key, name) =>
    set((s) => {
      const roomNames = { ...s.roomNames };
      if (name.trim()) roomNames[key] = name.trim();
      else delete roomNames[key];
      return { roomNames };
    }),

  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),

  updateFurniture: (id, patch) =>
    set((s) => ({
      furniture: s.furniture.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    })),

  putCustomItem: (item) =>
    set((s) => ({ customItems: { ...s.customItems, [item.id]: item } })),

  removeCustomItem: (id) =>
    set((s) => {
      const customItems = { ...s.customItems };
      delete customItems[id];
      const kind = customKind(id);
      return { customItems, furniture: s.furniture.filter((f) => f.kind !== kind) };
    }),

  setLook: (patch) => set((s) => ({ look: { ...s.look, ...patch } })),

  setName: (name) => set({ name: name.trim().slice(0, 80) || DEFAULT_PLAN_NAME }),

  setPlan: (plan) => set(pickPlan(plan)),
    }),
    {
      name: 'gaudi-plan-v1',
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => pickPlan(s),
      // Plans saved before a field existed pick up its default.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PlanData>;
        return {
          ...current,
          ...p,
          name: typeof p.name === 'string' && p.name ? p.name : current.name,
          settings: { ...defaultSettings, ...(p.settings ?? {}) },
          customItems: p.customItems ?? {},
          look: { ...defaultLook, ...(p.look ?? {}) },
        };
      },
    },
  ),
);

// Keep catalog lookups (`furnitureDef('custom:…')`) in step with the plan.
setCustomDefs(usePlanStore.getState().customItems);
usePlanStore.subscribe((s, prev) => {
  if (s.customItems !== prev.customItems) setCustomDefs(s.customItems);
});

declare global {
  interface Window {
    __plan?: typeof usePlanStore;
  }
}
if (import.meta.env.DEV) window.__plan = usePlanStore;
