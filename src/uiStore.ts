import { create } from 'zustand';
import type { Point, Tool } from './types';

export type ViewMode = 'plan' | 'model';

/** Transient editor state — never persisted. */
interface UiState {
  mode: ViewMode;
  tool: Tool;
  selectedWallIds: string[];
  /** Snapped cursor position in plan meters, null when off-canvas. */
  cursor: Point | null;
  /** Length of the wall segment currently being drawn, null when idle. */
  drawingLength: number | null;

  setMode: (mode: ViewMode) => void;
  setTool: (tool: Tool) => void;
  setSelection: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  setCursor: (p: Point | null) => void;
  setDrawingLength: (len: number | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  mode: 'plan',
  tool: 'wall',
  selectedWallIds: [],
  cursor: null,
  drawingLength: null,

  setMode: (mode) => set({ mode }),
  setTool: (tool) => set({ tool, selectedWallIds: [] }),
  setSelection: (ids) => set({ selectedWallIds: ids }),
  toggleSelected: (id) =>
    set((s) => ({
      selectedWallIds: s.selectedWallIds.includes(id)
        ? s.selectedWallIds.filter((x) => x !== id)
        : [...s.selectedWallIds, id],
    })),
  setCursor: (p) => set({ cursor: p }),
  setDrawingLength: (len) => set({ drawingLength: len }),
}));
