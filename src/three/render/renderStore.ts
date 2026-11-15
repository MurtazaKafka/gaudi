/**
 * Render mode: path-trace the current 3D view into a finished picture.
 * View state only — never part of the plan, never an undo step.
 */
import { create } from 'zustand';

/** How large the finished picture is. */
export type RenderSize = 'screen' | '2k' | '4k';
export const RENDER_SIZES: readonly { id: RenderSize; label: string; width: number | null }[] = [
  { id: 'screen', label: 'Screen', width: null },
  { id: '2k', label: '2K', width: 2560 },
  { id: '4k', label: '4K', width: 3840 },
];

export type RenderPhase = 'off' | 'preparing' | 'rendering' | 'done' | 'error';

/** Samples per pixel for a finished render. More = cleaner, slower. */
export let RENDER_SAMPLES = 100;
/** Dev only: change the sample target while tuning. */
export function setRenderSamples(n: number): void {
  RENDER_SAMPLES = n;
}

/** Light balance for the traced picture. Tuned by eye against the live view. */
export const RENDER_TUNING = {
  /** Sky (environment) strength relative to the live view's sky light. */
  sky: 1,
  /** Strength of a photographed sky relative to the live view. */
  skyPhoto: 0.8,
  /** Sun strength when a photographed sky supplies the fill light. */
  sunWithSky: 1.6,
  /** Exposure multiplier while tracing. */
  exposure: 1,
  /** Fraction of the canvas's device pixels traced (1 = full retina resolution). */
  scale: 0.75,
  /** Light bounces per path. */
  bounces: 3,
  /** Sun (directional light) strength relative to the live view. The live renderer divides direct light by π; the tracer doesn't. */
  sun: 1 / Math.PI,
  /** Room lamp strength relative to the live view. */
  lamp: 1,
  /** 0 = the live view's sky colours, 1 = white sky. */
  neutralSky: 0.3,
};

interface RenderState {
  phase: RenderPhase;
  samples: number;
  error: string | null;
  /** Bumped to ask the canvas for the current picture. */
  saveNonce: number;
  size: RenderSize;
  /** Bumped to start the render over (a new size). */
  runNonce: number;
  setSize: (size: RenderSize) => void;
  start: () => void;
  stop: () => void;
  requestSave: () => void;
}

export const useRenderStore = create<RenderState>((set) => ({
  phase: 'off',
  samples: 0,
  error: null,
  saveNonce: 0,
  size: 'screen',
  runNonce: 0,
  setSize: (size) =>
    set((s) =>
      s.size === size
        ? s
        : { size, runNonce: s.runNonce + 1, samples: 0, phase: s.phase === 'off' ? 'off' : 'preparing' },
    ),
  start: () => set({ phase: 'preparing', samples: 0, error: null }),
  stop: () => set({ phase: 'off', samples: 0, error: null }),
  requestSave: () => set((s) => ({ saveNonce: s.saveNonce + 1 })),
}));

export const isRendering = (): boolean => useRenderStore.getState().phase !== 'off';

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__render = { store: useRenderStore, setSamples: setRenderSamples, tuning: RENDER_TUNING };
}
