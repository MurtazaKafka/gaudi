import { create } from 'zustand';
import type { Point, Tool } from './types';
import type { FurnitureKind } from './catalog';
import { readDrawingLook, storeDrawingLook, type DrawingLook } from './components/plan/look';

export type ViewMode = 'plan' | 'model';

/** Panels docked on the right edge. Only one is open at a time (the share drawer counts). */
export type PanelId = 'generate' | 'projects';

/** Transient editor state — never persisted. */
interface UiState {
  mode: ViewMode;
  tool: Tool;
  /** Viewing someone else's plan (or a proposal preview): no mutations. */
  readOnly: boolean;
  selectedWallIds: string[];
  selectedOpeningIds: string[];
  selectedFurnitureIds: string[];
  selectedRoomKey: string | null;
  /** Which catalog item the furniture tool is placing. */
  placingKind: FurnitureKind | null;
  /** Whether the furniture palette panel is open. */
  paletteOpen: boolean;
  /** Snapped cursor position in plan meters, null when off-canvas. */
  cursor: Point | null;
  /** Length of the wall segment currently being drawn, null when idle. */
  drawingLength: number | null;
  /** Which right-hand panel is open, if any. */
  panel: PanelId | null;
  /** ⌘K command bar ("Ask Gaudí"). */
  commandOpen: boolean;
  /** Text to pre-fill the command bar with the next time it opens. */
  commandSeed: string;
  /** Show length labels on every wall. */
  showDimensions: boolean;
  /** How the 2D plan is drawn: 'color' (pastel rooms, solid walls) or 'paper' (line drawing). Per browser. */
  drawingLook: DrawingLook;
  /** Keyboard shortcut sheet. */
  shortcutsOpen: boolean;
  /** Bumped to ask the plan canvas to zoom-to-fit (after a whole-plan swap). */
  fitNonce: number;
  /** Bumped to ask the plan canvas to zoom-to-fit and nothing else: the document is the same one. */
  zoomNonce: number;
  /** Notes to pre-fill the Generate panel's brief with the next time it opens. */
  generateSeed: string;

  setMode: (mode: ViewMode) => void;
  setTool: (tool: Tool) => void;
  setReadOnly: (readOnly: boolean) => void;
  setSelection: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  setOpeningSelection: (ids: string[]) => void;
  setFurnitureSelection: (ids: string[]) => void;
  setRoomSelection: (key: string | null) => void;
  startPlacing: (kind: FurnitureKind) => void;
  setPaletteOpen: (open: boolean) => void;
  /** Bumped to focus the product search field in the palette. */
  productFocusNonce: number;
  /** Focus the Amazon search field in the top bar. */
  openProducts: () => void;
  setCursor: (p: Point | null) => void;
  setDrawingLength: (len: number | null) => void;
  setPanel: (panel: PanelId | null) => void;
  togglePanel: (panel: PanelId) => void;
  openCommand: (seed?: string) => void;
  closeCommand: () => void;
  setShowDimensions: (on: boolean) => void;
  setDrawingLook: (look: DrawingLook) => void;
  setShortcutsOpen: (open: boolean) => void;
  requestFit: () => void;
  /** Zoom the plan to fit, as the 0 key does — selection, drafting state and the model camera are left alone. */
  requestZoomFit: () => void;
  /** Open the Generate panel, optionally seeding its notes field. */
  openGenerate: (seed?: string) => void;
}

const DIMS_PREF = 'gaudi-pref-dimensions';

export const useUiStore = create<UiState>((set) => ({
  mode: 'plan',
  tool: 'wall',
  readOnly: false,
  selectedWallIds: [],
  selectedOpeningIds: [],
  selectedFurnitureIds: [],
  selectedRoomKey: null,
  placingKind: null,
  paletteOpen: false,
  productFocusNonce: 0,
  cursor: null,
  drawingLength: null,
  panel: null,
  commandOpen: false,
  commandSeed: '',
  showDimensions: localStorage.getItem(DIMS_PREF) === '1',
  drawingLook: readDrawingLook(),
  shortcutsOpen: false,
  fitNonce: 0,
  zoomNonce: 0,
  generateSeed: '',

  setMode: (mode) => set({ mode }),
  setReadOnly: (readOnly) => set({ readOnly }),
  setTool: (tool) =>
    set((s) => ({
      tool,
      selectedWallIds: [],
      selectedOpeningIds: [],
      selectedFurnitureIds: [],
      selectedRoomKey: null,
      placingKind: tool === 'furniture' ? s.placingKind : null,
    })),
  setSelection: (ids) =>
    set({
      selectedWallIds: ids,
      selectedOpeningIds: [],
      selectedFurnitureIds: [],
      selectedRoomKey: null,
    }),
  toggleSelected: (id) =>
    set((s) => ({
      selectedWallIds: s.selectedWallIds.includes(id)
        ? s.selectedWallIds.filter((x) => x !== id)
        : [...s.selectedWallIds, id],
    })),
  setOpeningSelection: (ids) =>
    set({
      selectedOpeningIds: ids,
      selectedWallIds: [],
      selectedFurnitureIds: [],
      selectedRoomKey: null,
    }),
  setFurnitureSelection: (ids) =>
    set({
      selectedFurnitureIds: ids,
      selectedWallIds: [],
      selectedOpeningIds: [],
      selectedRoomKey: null,
    }),
  setRoomSelection: (key) =>
    set({
      selectedRoomKey: key,
      selectedWallIds: [],
      selectedOpeningIds: [],
      selectedFurnitureIds: [],
    }),
  startPlacing: (kind) =>
    set({
      tool: 'furniture',
      placingKind: kind,
      selectedWallIds: [],
      selectedOpeningIds: [],
      selectedFurnitureIds: [],
      selectedRoomKey: null,
    }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  openProducts: () =>
    set((s) => ({ productFocusNonce: s.productFocusNonce + 1 })),
  setCursor: (p) => set({ cursor: p }),
  setDrawingLength: (len) => set({ drawingLength: len }),
  setPanel: (panel) => set({ panel }),
  togglePanel: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel })),
  openCommand: (seed = '') => set({ commandOpen: true, commandSeed: seed }),
  closeCommand: () => set({ commandOpen: false, commandSeed: '' }),
  setShowDimensions: (on) => {
    localStorage.setItem(DIMS_PREF, on ? '1' : '0');
    set({ showDimensions: on });
  },
  setDrawingLook: (look) => {
    storeDrawingLook(look);
    set({ drawingLook: look });
  },
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  requestFit: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
  requestZoomFit: () => set((s) => ({ zoomNonce: s.zoomNonce + 1 })),
  openGenerate: (seed = '') => set({ panel: 'generate', generateSeed: seed }),
}));
