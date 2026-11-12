/**
 * Undo / redo for the plan document.
 *
 * The plan store is immutable-by-convention, so a snapshot is just the eight
 * document slice references — free to take. A store subscription records the
 * previous snapshot whenever the document changes:
 *
 *  - continuous edits that don't add or remove anything (a drag, typing in a
 *    number field) coalesce into one step while they keep arriving;
 *  - a gesture (`beginGesture` … `endGesture`) is always exactly one step,
 *    whatever happens inside it;
 *  - `pauseHistory` / `resumeHistory` bracket changes that must not be
 *    recorded (loading a shared plan, previewing an option).
 */
import { create } from 'zustand';
import { pickPlan, PLAN_KEYS, usePlanStore } from './store';
import { useUiStore } from './uiStore';
import type { PlanData } from './types';

const LIMIT = 200;
const COALESCE_MS = 600;

let past: PlanData[] = [];
let future: PlanData[] = [];
let paused = 0;
let gesture = 0;
let gestureRecorded = false;
let lastAt = 0;
let lastWasTweak = false;

interface HistoryFlags {
  canUndo: boolean;
  canRedo: boolean;
}

/** Reactive flags for buttons. */
export const useHistoryStore = create<HistoryFlags>(() => ({ canUndo: false, canRedo: false }));

function publish(): void {
  const next = { canUndo: past.length > 0, canRedo: future.length > 0 };
  const cur = useHistoryStore.getState();
  if (cur.canUndo !== next.canUndo || cur.canRedo !== next.canRedo) useHistoryStore.setState(next);
}

const same = (a: PlanData, b: PlanData): boolean => PLAN_KEYS.every((k) => a[k] === b[k]);

function push(snapshot: PlanData): void {
  past.push(snapshot);
  if (past.length > LIMIT) past.shift();
  future = [];
}

usePlanStore.subscribe((state, prev) => {
  if (paused > 0) return;
  const before = pickPlan(prev);
  const after = pickPlan(state);
  if (same(before, after)) return;

  if (gesture > 0) {
    if (!gestureRecorded) {
      push(before);
      gestureRecorded = true;
    }
    future = [];
    publish();
    return;
  }

  // A "tweak" changes values without adding or removing anything.
  const tweak =
    before.walls.length === after.walls.length &&
    before.openings.length === after.openings.length &&
    before.furniture.length === after.furniture.length &&
    Object.keys(before.customItems).length === Object.keys(after.customItems).length;
  const now = performance.now();
  const coalesce = tweak && lastWasTweak && now - lastAt < COALESCE_MS && past.length > 0;
  if (!coalesce) push(before);
  else future = [];
  lastAt = now;
  lastWasTweak = tweak;
  publish();
});

function restore(plan: PlanData): void {
  paused++;
  try {
    usePlanStore.getState().setPlan(plan);
  } finally {
    paused--;
  }
  // Selections may point at things that no longer exist.
  useUiStore.getState().setSelection([]);
  lastAt = 0;
  lastWasTweak = false;
  publish();
}

export function undo(): boolean {
  const prev = past.pop();
  if (!prev) return false;
  future.push(pickPlan(usePlanStore.getState()));
  restore(prev);
  return true;
}

export function redo(): boolean {
  const next = future.pop();
  if (!next) return false;
  past.push(pickPlan(usePlanStore.getState()));
  restore(next);
  return true;
}

/** Forget everything (a different document was loaded). */
export function resetHistory(): void {
  past = [];
  future = [];
  lastAt = 0;
  lastWasTweak = false;
  publish();
}

/** Record the current state as an undo step right now (before a scripted multi-step change). */
export function checkpoint(): void {
  push(pickPlan(usePlanStore.getState()));
  lastAt = 0;
  lastWasTweak = false;
  publish();
}

export function pauseHistory(): void {
  paused++;
}

export function resumeHistory(): void {
  paused = Math.max(0, paused - 1);
  lastAt = 0;
  lastWasTweak = false;
}

/** Start a drag-like gesture: everything until `endGesture` is one undo step. */
export function beginGesture(): void {
  if (gesture === 0) gestureRecorded = false;
  gesture++;
}

export function endGesture(): void {
  gesture = Math.max(0, gesture - 1);
  if (gesture === 0) {
    lastAt = 0;
    lastWasTweak = false;
  }
}

/** Run several store mutations as a single undo step. */
export function transact(fn: () => void): void {
  beginGesture();
  try {
    fn();
  } finally {
    endGesture();
  }
}
