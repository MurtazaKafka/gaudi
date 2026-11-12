/** Tiny transient notices, bottom-center. Replaces alert(); can carry one action (e.g. Undo). */
import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  dismiss: (id: number) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let nextId = 1;

export function toast(
  text: string,
  opts: { tone?: 'info' | 'error'; action?: Toast['action']; ms?: number } = {},
): void {
  const id = nextId++;
  const t: Toast = { id, text, tone: opts.tone ?? 'info', action: opts.action };
  useToastStore.setState((s) => ({ toasts: [...s.toasts.slice(-2), t] }));
  window.setTimeout(() => useToastStore.getState().dismiss(id), opts.ms ?? (opts.action ? 7000 : 4000));
}

export const toastError = (text: string): void => toast(text, { tone: 'error', ms: 6000 });
