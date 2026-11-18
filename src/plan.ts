/**
 * The plan as a value: read it, validate one from outside, swap it in.
 * Every feature that produces or consumes whole plans (import, share, undo,
 * AI generation, projects, exports) goes through these three functions.
 */
import {
  DEFAULT_PLAN_NAME,
  defaultLook,
  defaultSettings,
  pickPlan,
  usePlanStore,
} from './store';
import { isBuiltinKind, isCustomKind, customId } from './catalog';
import { sanitizeCustomItem } from './customItems';
import { cleanLevels } from './levels';
import { pauseHistory, resetHistory, resumeHistory } from './history';
import { useUiStore } from './uiStore';
import type {
  CustomItem,
  Furniture,
  Opening,
  PlanData,
  PlanLook,
  PlanSettings,
  Point,
  RoofKind,
  Wall,
} from './types';

/** Snapshot of the current document (shares references with the store — treat as immutable). */
export function getPlanData(): PlanData {
  return pickPlan(usePlanStore.getState());
}

/** A deep, JSON-safe copy — for stashing, uploading, or handing to a model. */
export function clonePlan(plan: PlanData): PlanData {
  return JSON.parse(JSON.stringify(plan)) as PlanData;
}

/**
 * Replace the document.
 *  - 'push'  (default): undoable — one step back restores what was there.
 *  - 'reset': a different document; history starts over.
 *  - 'skip':  not recorded at all (previews, restores).
 */
export function applyPlanData(
  plan: PlanData,
  history: 'push' | 'reset' | 'skip' = 'push',
  /** Zoom the canvas to the new plan. Default: yes for document switches, no for edits. */
  fit: boolean = history !== 'push',
): void {
  if (history === 'push') {
    usePlanStore.getState().setPlan(plan);
  } else {
    pauseHistory();
    try {
      usePlanStore.getState().setPlan(plan);
    } finally {
      resumeHistory();
    }
    if (history === 'reset') resetHistory();
  }
  if (fit) useUiStore.getState().requestFit();
}

function isPoint(p: unknown): p is Point {
  return (
    typeof p === 'object' &&
    p !== null &&
    Number.isFinite((p as Point).x) &&
    Number.isFinite((p as Point).y)
  );
}

const ROOFS: readonly RoofKind[] = ['none', 'flat', 'gable', 'hip'];

/** Hard ceilings on what a plan may contain — far above any real house, low enough that a hostile file can't hang the app. */
// Large enough for a campus of a hundred buildings in one plan; small enough that a hostile file cannot stall the page.
export const PLAN_LIMITS = { walls: 8000, openings: 8000, furniture: 6000, rooms: 2500, text: 80, coord: 2000 } as const;

type Raw = Record<string, unknown>;

/**
 * Validate anything plan-shaped (a file, a shared link, model output) into a
 * clean PlanData. Bad openings/furniture are dropped rather than failing the
 * whole plan; structurally broken input returns an error.
 */
export function normalizePlan(raw: unknown): { ok: true; plan: PlanData } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Not a plan file.' };
  const f = raw as Raw;
  if (!Array.isArray(f.walls)) return { ok: false, error: 'Missing walls array.' };
  if (f.walls.length > PLAN_LIMITS.walls) return { ok: false, error: 'This plan has too many walls to open.' };
  const inRange = (p: Point) => Math.abs(p.x) <= PLAN_LIMITS.coord && Math.abs(p.y) <= PLAN_LIMITS.coord;
  const short = (t: string) => t.trim().slice(0, PLAN_LIMITS.text);

  const walls: Wall[] = [];
  for (const w of f.walls as Raw[]) {
    if (!isPoint(w?.a) || !isPoint(w?.b)) return { ok: false, error: 'Malformed wall.' };
    if (!inRange(w.a) || !inRange(w.b)) return { ok: false, error: 'This plan is too large to open.' };
    const levels = cleanLevels(w.levels);
    walls.push({
      id: typeof w.id === 'string' ? w.id : crypto.randomUUID(),
      a: { x: w.a.x, y: w.a.y },
      b: { x: w.b.x, y: w.b.y },
      // Only a real storey count survives; 1 is the default and is left out.
      ...(levels !== undefined ? { levels } : {}),
    });
  }

  const wallIds = new Set(walls.map((w) => w.id));
  const openings: Opening[] = [];
  for (const o of (Array.isArray(f.openings) ? f.openings.slice(0, PLAN_LIMITS.openings) : []) as Raw[]) {
    if (
      typeof o?.wallId !== 'string' ||
      !wallIds.has(o.wallId) ||
      (o.type !== 'door' && o.type !== 'window') ||
      !Number.isFinite(o.offset) ||
      !Number.isFinite(o.width)
    )
      continue;
    openings.push({
      id: typeof o.id === 'string' ? o.id : crypto.randomUUID(),
      wallId: o.wallId,
      type: o.type,
      offset: o.offset as number,
      width: o.width as number,
      ...(typeof o.label === 'string' && short(o.label) ? { label: short(o.label) } : {}),
    });
  }

  const customItems: Record<string, CustomItem> = {};
  if (typeof f.customItems === 'object' && f.customItems !== null) {
    for (const [id, item] of Object.entries(f.customItems as Raw).slice(0, 200)) {
      const clean = sanitizeCustomItem(id, item);
      if (clean) customItems[id] = clean;
    }
  }

  const furniture: Furniture[] = [];
  for (const fu of (Array.isArray(f.furniture) ? f.furniture.slice(0, PLAN_LIMITS.furniture) : []) as Raw[]) {
    const kind = fu?.kind;
    const known = isBuiltinKind(kind) || (isCustomKind(kind) && Object.hasOwn(customItems, customId(kind)));
    if (!known || !Number.isFinite(fu.x) || !Number.isFinite(fu.y) || !Number.isFinite(fu.rotation))
      continue;
    furniture.push({
      id: typeof fu.id === 'string' ? fu.id : crypto.randomUUID(),
      kind,
      x: fu.x as number,
      y: fu.y as number,
      rotation: fu.rotation as number,
      ...(typeof fu.label === 'string' && short(fu.label) ? { label: short(fu.label) } : {}),
      ...(fu.rest === 'floor' || fu.rest === 'top' ? { rest: fu.rest } : {}),
    });
  }

  const s = (f.settings ?? {}) as Raw;
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  const settings: PlanSettings = {
    wallHeight: num(s.wallHeight, defaultSettings.wallHeight, 1.8, 8),
    wallThickness: num(s.wallThickness, defaultSettings.wallThickness, 0.03, 0.6),
    gridSize: num(s.gridSize, defaultSettings.gridSize, 0.05, 2),
    units: s.units === 'ft' ? 'ft' : 'm',
  };

  const roomNames: Record<string, string> = {};
  if (typeof f.roomNames === 'object' && f.roomNames !== null) {
    for (const [k, v] of Object.entries(f.roomNames as Raw).slice(0, PLAN_LIMITS.rooms)) {
      if (typeof v === 'string' && short(v)) roomNames[k] = short(v);
    }
  }

  const l = (f.look ?? {}) as Raw;
  const look: PlanLook = {
    style: typeof l.style === 'string' && l.style ? l.style.slice(0, 40) : defaultLook.style,
    roof: ROOFS.includes(l.roof as RoofKind) ? (l.roof as RoofKind) : defaultLook.roof,
  };

  const name =
    typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 80) : DEFAULT_PLAN_NAME;

  return { ok: true, plan: { name, walls, openings, furniture, roomNames, settings, customItems, look } };
}
