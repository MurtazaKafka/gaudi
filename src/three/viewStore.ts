/**
 * How the model is being looked at: which view, the time of day, the camera.
 * None of this is part of the plan — it is never saved, shared or undone.
 * (No three.js import here: the app shell may read this store.)
 */
import { create } from 'zustand';

export type SceneView = 'dollhouse' | 'exterior' | 'walk';
export type OrbitView = Exclude<SceneView, 'walk'>;

export const SUN_MIN = 6;
export const SUN_MAX = 20;
export const SUN_NOON = 12;

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

  setView: (view: SceneView) => void;
  setWalking: (walking: boolean) => void;
  /** Leave walk mode for the orbit view it was entered from. */
  stepOut: () => void;
  setSunHour: (hour: number) => void;
  setPose: (pose: CameraPose | null) => void;
  resetView: () => void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: 'dollhouse',
  orbitView: 'dollhouse',
  walking: false,
  sunHour: SUN_NOON,
  pose: null,
  resetNonce: 0,

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
}));

/** "6:30", "14:00" — plain 24-hour clock. */
export function formatHour(hour: number): string {
  const total = Math.round(hour * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${m.toString().padStart(2, '0')}`;
}
