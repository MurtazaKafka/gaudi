import { create } from 'zustand';
import type { Furniture } from './types';

export type AiStatus = 'idle' | 'loading' | 'preview' | 'error';

const NOTE_KEY = 'gaudi-furnish-note';

function readNote(): string {
  try {
    return sessionStorage.getItem(NOTE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * State for the one in-flight or previewed AI furnishing suggestion.
 * The plan canvas reads `status`, `roomKey` and `items` (ghosts); everything
 * else belongs to the furnish controller in aiFurnish.ts.
 */
interface AiState {
  status: AiStatus;
  roomKey: string | null;
  items: Omit<Furniture, 'id'>[];
  /** suggestions discarded by geometry validation */
  dropped: number;
  error: string | null;
  /** Identifies the current run; results from any other run are ignored. */
  runId: number;
  /** Accepting replaces the room's existing furniture. */
  replace: boolean;
  /** Optional one-line style note, remembered for the session. */
  note: string;

  /** Begin a run; returns its id. */
  start: (roomKey: string, replace?: boolean) => number;
  succeed: (runId: number, items: Omit<Furniture, 'id'>[], dropped: number) => void;
  fail: (runId: number, error: string) => void;
  clear: () => void;
  setNote: (note: string) => void;
}

export const useAiStore = create<AiState>((set, get) => ({
  status: 'idle',
  roomKey: null,
  items: [],
  dropped: 0,
  error: null,
  runId: 0,
  replace: false,
  note: readNote(),

  start: (roomKey, replace = false) => {
    const runId = get().runId + 1;
    set({ status: 'loading', roomKey, items: [], dropped: 0, error: null, runId, replace });
    return runId;
  },
  succeed: (runId, items, dropped) => {
    if (get().runId !== runId || get().status !== 'loading') return;
    set({ status: 'preview', items, dropped });
  },
  fail: (runId, error) => {
    if (get().runId !== runId || get().status !== 'loading') return;
    set({ status: 'error', error });
  },
  // Bumping runId orphans whatever request is still in the air.
  clear: () =>
    set((s) => ({
      status: 'idle',
      roomKey: null,
      items: [],
      dropped: 0,
      error: null,
      replace: false,
      runId: s.runId + 1,
    })),
  setNote: (note) => {
    try {
      sessionStorage.setItem(NOTE_KEY, note);
    } catch {
      // private mode: the note just lasts until reload
    }
    set({ note });
  },
}));

declare global {
  interface Window {
    __ai?: typeof useAiStore;
  }
}
if (import.meta.env.DEV) window.__ai = useAiStore;

// Key handling lives with the API client; re-exported for existing call sites.
export { getApiKey, setApiKey } from './ai/client';
