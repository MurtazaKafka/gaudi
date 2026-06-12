import { create } from 'zustand';
import type { Point, Tool } from './types';
import type { FurnitureKind } from './catalog';

export type ViewMode = 'plan' | 'model';

/** Transient editor state — never persisted. */
interface UiState {
  mode: ViewMode;
  tool: Tool;
  selectedWallIds: string[];
  selectedOpeningIds: string[];
  selectedFurnitureIds: string[];
  /** Which catalog item the furniture tool is placing. */
  placingKind: FurnitureKind | null;
  /** Whether the furniture palette panel is open. */
  paletteOpen: boolean;
  /** Snapped cursor position in plan meters, null when off-canvas. */
  cursor: Point | null;
  /** Length of the wall segment currently being drawn, null when idle. */
  drawingLength: number | null;

  setMode: (mode: ViewMode) => void;
  setTool: (tool: Tool) => void;
  setSelection: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  setOpeningSelection: (ids: string[]) => void;
  setFurnitureSelection: (ids: string[]) => void;
  startPlacing: (kind: FurnitureKind) => void;
  setPaletteOpen: (open: boolean) => void;
  setCursor: (p: Point | null) => void;
  setDrawingLength: (len: number | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  mode: 'plan',
  tool: 'wall',
  selectedWallIds: [],
  selectedOpeningIds: [],
  selectedFurnitureIds: [],
  placingKind: null,
  paletteOpen: false,
  cursor: null,
  drawingLength: null,

  setMode: (mode) => set({ mode }),
  setTool: (tool) =>
    set((s) => ({
      tool,
      selectedWallIds: [],
      selectedOpeningIds: [],
      selectedFurnitureIds: [],
      placingKind: tool === 'furniture' ? s.placingKind : null,
    })),
  setSelection: (ids) =>
    set({ selectedWallIds: ids, selectedOpeningIds: [], selectedFurnitureIds: [] }),
  toggleSelected: (id) =>
    set((s) => ({
      selectedWallIds: s.selectedWallIds.includes(id)
        ? s.selectedWallIds.filter((x) => x !== id)
        : [...s.selectedWallIds, id],
    })),
  setOpeningSelection: (ids) =>
    set({ selectedOpeningIds: ids, selectedWallIds: [], selectedFurnitureIds: [] }),
  setFurnitureSelection: (ids) =>
    set({ selectedFurnitureIds: ids, selectedWallIds: [], selectedOpeningIds: [] }),
  startPlacing: (kind) =>
    set({
      tool: 'furniture',
      placingKind: kind,
      selectedWallIds: [],
      selectedOpeningIds: [],
      selectedFurnitureIds: [],
    }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setCursor: (p) => set({ cursor: p }),
  setDrawingLength: (len) => set({ drawingLength: len }),
}));
