import { create } from 'zustand';
import type { Furniture } from './types';

export type AiStatus = 'idle' | 'loading' | 'preview' | 'error';

/** State for one in-flight or previewed AI furnishing suggestion. */
interface AiState {
  status: AiStatus;
  roomKey: string | null;
  items: Omit<Furniture, 'id'>[];
  /** suggestions discarded by geometry validation */
  dropped: number;
  error: string | null;

  start: (roomKey: string) => void;
  succeed: (items: Omit<Furniture, 'id'>[], dropped: number) => void;
  fail: (error: string) => void;
  clear: () => void;
}

export const useAiStore = create<AiState>((set) => ({
  status: 'idle',
  roomKey: null,
  items: [],
  dropped: 0,
  error: null,

  start: (roomKey) => set({ status: 'loading', roomKey, items: [], dropped: 0, error: null }),
  succeed: (items, dropped) => set({ status: 'preview', items, dropped }),
  fail: (error) => set({ status: 'error', error }),
  clear: () => set({ status: 'idle', roomKey: null, items: [], dropped: 0, error: null }),
}));

declare global {
  interface Window {
    __ai?: typeof useAiStore;
  }
}
if (import.meta.env.DEV) window.__ai = useAiStore;

const KEY_STORAGE = 'gaudi-anthropic-key';

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function setApiKey(key: string): void {
  if (key.trim()) localStorage.setItem(KEY_STORAGE, key.trim());
  else localStorage.removeItem(KEY_STORAGE);
}
