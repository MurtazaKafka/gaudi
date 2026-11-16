/**
 * How the model is being looked at: which view, the time of day, the camera.
 * None of this is part of the plan — it is never saved, shared or undone.
 * (No three.js import here: the app shell may read this store.)
 */
import { create } from 'zustand';
import type { Lens } from './lens';

export type SceneView = 'dollhouse' | 'exterior' | 'walk';
export type OrbitView = Exclude<SceneView, 'walk'>;

/** Ready-made camera positions. */
export type Shot = 'aerial' | 'street' | 'corner' | 'top';
export const SHOTS: readonly { id: Shot; label: string; hint: string }[] = [
  { id: 'aerial', label: 'Aerial', hint: 'Looking down from the corner' },
  { id: 'street', label: 'Street', hint: 'Eye level, facing the entrance' },
  { id: 'corner', label: 'Corner', hint: 'Low three-quarter view' },
  { id: 'top', label: 'Top', hint: 'Straight down' },
];

export const SUN_MIN = 6;
export const SUN_MAX = 20;
export const SUN_NOON = 12;
/** Where the clock starts: mid-afternoon, when the light rakes across the walls instead of falling flat from overhead. */
export const SUN_DEFAULT = 15;

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  /** uiStore.fitNonce when the pose was taken — a newer nonce means the plan was replaced. */
  fitNonce: number;
}

interface ViewState {
  view: SceneView;
  /** The orbit view to return to when stepping out of a walk. */
  orbitView: OrbitView;
  /** True once the walker has stepped in (first-person); false while choosing where. */
  walking: boolean;
  /** 6 … 20, hours. */
  sunHour: number;
  /** Orbit camera, kept across Plan ↔ Model toggles. */
  pose: CameraPose | null;
  /** Bumped to ask the scene to refit its camera. */
  resetNonce: number;
  /** The shot last asked for, and a counter so asking again re-aims. */
  shot: Shot;
  shotNonce: number;
  /** Which way the house faces (unit vector in plan x/z, out of the front door). */
  front: [number, number];
  /** The lens on the orbit camera. */
  lens: Lens;
  /** Keep upright walls upright from outside (shift the lens instead of tilting the camera). */
  straight: boolean;
  /** Dress the rooms in the 3D view (rugs, pictures, lamps…). Never part of the plan. */
  details: boolean;

  setView: (view: SceneView) => void;
  setWalking: (walking: boolean) => void;
  /** Leave walk mode for the orbit view it was entered from. */
  stepOut: () => void;
  setSunHour: (hour: number) => void;
  setPose: (pose: CameraPose | null) => void;
  resetView: () => void;
  takeShot: (shot: Shot) => void;
  setFront: (front: [number, number]) => void;
  setLens: (lens: Lens) => void;
  setStraight: (straight: boolean) => void;
  setDetails: (details: boolean) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: 'dollhouse',
  orbitView: 'dollhouse',
  walking: false,
  sunHour: SUN_DEFAULT,
  pose: null,
  resetNonce: 0,
  shot: 'aerial',
  shotNonce: 0,
  front: [0, 1],
  lens: 'normal',
  straight: true,
  details: true,

  setView: (view) =>
    set((s) => ({
      view,
      walking: false,
      orbitView: view === 'walk' ? s.orbitView : view,
    })),
  setWalking: (walking) => set({ walking }),
  stepOut: () => set((s) => (s.view === 'walk' ? { view: s.orbitView, walking: false } : s)),
  setSunHour: (hour) =>
    set({ sunHour: Number.isFinite(hour) ? Math.min(SUN_MAX, Math.max(SUN_MIN, hour)) : SUN_NOON }),
  setPose: (pose) => set({ pose }),
  resetView: () => set((s) => ({ resetNonce: s.resetNonce + 1 })),
  takeShot: (shot) =>
    set((s) => ({
      shot,
      shotNonce: s.shotNonce + 1,
      // Shots from outside make sense with the roof on; walking ends.
      view: s.view === 'walk' ? s.orbitView : s.view,
      walking: false,
    })),
  setFront: (front) => set((s) => (s.front[0] === front[0] && s.front[1] === front[1] ? s : { front })),
  setLens: (lens) => set({ lens }),
  setStraight: (straight) => set({ straight }),
  setDetails: (details) => set({ details }),
}));

/** "6:30", "14:00" — plain 24-hour clock. */
export function formatHour(hour: number): string {
  const total = Math.round(hour * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${m.toString().padStart(2, '0')}`;
}
