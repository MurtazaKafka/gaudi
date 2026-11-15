/**
 * The self-running demo: where it is, and what the caption says. View state
 * only — the demo plays on a preview, so the visitor's own plan is untouched.
 */
import { create } from 'zustand';

export type DemoPhase = 'off' | 'title' | 'playing' | 'end';

interface DemoState {
  phase: DemoPhase;
  /** 0-based index of the step on screen, and how many there are. */
  step: number;
  steps: number;
  caption: string;
  detail: string;
  /** Whether a plan was on the canvas when the demo began (it is waiting to come back). */
  hadPlan: boolean;
}

export const useDemoStore = create<DemoState>(() => ({
  phase: 'off',
  step: 0,
  steps: 0,
  caption: '',
  detail: '',
  hadPlan: false,
}));

export const demoActive = (): boolean => useDemoStore.getState().phase !== 'off';
