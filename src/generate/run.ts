/**
 * The Generate feature's state and actions: the brief, the option cards, the
 * run in flight. Lives outside the panel so closing the panel loses nothing.
 */
import { create } from 'zustand';
import { aiErrorMessage, AiError, aiReady, isAbort } from '../ai/client';
import { furnishWholePlan } from '../ai/furnishAll';
import { undo } from '../history';
import { applyPlanData, getPlanData } from '../plan';
import { DEFAULT_PLAN_NAME } from '../store';
import { beginPreview, usePreviewStore } from '../preview';
import { toast, toastError } from '../toast';
import { useUiStore } from '../uiStore';
import { formatArea, formatLength } from '../units';
import type { PlanData } from '../types';
import { askLayout } from './ai';
import { IDEAS, OUTLINE_IDEAS, VARIATIONS } from './aiPrompt';
import {
  applyPatch,
  defaultBrief,
  parseBriefText,
  sanitizeBrief,
  SHAPES,
  targetArea,
  type Brief,
} from './brief';
import { draftOptions } from './draft';
import { dressOption } from './dress';
import { keepSetup, planRooms, restoreKept, type KeepSetup, type PlanRoom } from './keep';
import { IN_PLACE, layoutToPlan, type Layout } from './layout';
import { outlineFromPolygon, outlineSegments, readOutline, squareOff, unionOutline, type Outline, type Rect } from './outline';
import type { Recipe } from './procedural';
import { scoreLayout, type Scorecard } from './score';
import { presetOutline, type PresetShape } from './shapes';

export type Engine = 'claude' | 'builtin';

export interface GenOption {
  id: string;
  /** A–E */
  letter: string;
  status: 'pending' | 'ready' | 'failed';
  engine: Engine;
  title: string;
  summary?: string;
  layout?: Layout;
  plan?: PlanData;
  score?: Scorecard;
  /** Built-in engine, wing recipes: how to make more like it. */
  recipe?: Recipe;
  /** The footprint the rooms were fitted into, as rectangles (an outline, or a preset drawn as one). */
  mask?: Rect[];
  /** Fitted into the outline on the canvas: the plan keeps its coordinates and the furniture already there. */
  inPlace?: boolean;
  /** Which family of footprint it is. */
  shape?: string;
  /** Re-planned around rooms that were kept: which, and how to do it again. */
  keep?: KeepSetup;
  error?: string;
}

interface GenerateState {
  brief: Brief;
  options: GenOption[];
  running: boolean;
  /** Which engine the current options came from (null before the first run). */
  engine: Engine | null;
  /** One quiet line about the run (sized down, shape swapped, Claude unreachable…). */
  note: string | null;
  /** The option being previewed on the canvas. */
  activeId: string | null;
  /** The outline (by key) the person set aside in favour of a preset shape; null = use the outline when there is one. */
  outlineOff: string | null;
  /** The outline the current options were fitted into, if they were. */
  outlineKey: string | null;
  /** Rooms of the current plan (by key) to leave exactly where they are; the next run re-plans the rest. */
  keep: string[];
}

const BRIEF_STORAGE = 'gaudi-generate-brief';
const LETTERS = 'ABCDE';
const COUNT = 5;

function loadBrief(): Brief {
  try {
    const raw = localStorage.getItem(BRIEF_STORAGE);
    if (raw) return sanitizeBrief(JSON.parse(raw));
  } catch {
    /* unreadable — fall through */
  }
  return defaultBrief();
}

export const useGenerateStore = create<GenerateState>(() => ({
  brief: loadBrief(),
  options: [],
  running: false,
  engine: null,
  note: null,
  activeId: null,
  outlineOff: null,
  outlineKey: null,
  keep: [],
}));

const set = useGenerateStore.setState;
const get = useGenerateStore.getState;

/* ------------------------------------------------------------------ */
/* Brief                                                               */
/* ------------------------------------------------------------------ */

export function setBrief(patch: Partial<Brief>): void {
  const brief = sanitizeBrief({ ...get().brief, ...patch });
  set({ brief });
  try {
    localStorage.setItem(BRIEF_STORAGE, JSON.stringify(brief));
  } catch {
    /* storage full or blocked — the brief still works for this session */
  }
}

/** Use a sentence as the wish line, and pick out anything it clearly states (counts, size, shape, spaces). */
export function applyBriefText(text: string): void {
  const t = text.trim().slice(0, 300);
  if (!t) return;
  const { patch } = parseBriefText(t);
  setBrief({ ...applyPatch(get().brief, patch), wishes: t });
}

/* ------------------------------------------------------------------ */
/* The outline on the canvas                                            */
/* ------------------------------------------------------------------ */

/** The plan the person is working on (under a preview the store holds the candidate, the real one is stashed). */
function realPlan(): PlanData {
  const pv = usePreviewStore.getState();
  return pv.active && pv.stash ? pv.stash : getPlanData();
}

let outlineWalls: PlanData['walls'] | null = null;
let outlineCache: Outline | null = null;

/** Read `walls` as a bare outline (remembered for the last wall list, so it can be called on every render). */
export function outlineOf(walls: PlanData['walls']): Outline | null {
  if (walls !== outlineWalls) {
    outlineWalls = walls;
    outlineCache = readOutline(walls);
  }
  return outlineCache;
}

/** The outline the next run will fill: one is drawn, rooms can be fitted into it, and it hasn't been set aside. */
export function outlineInUse(): Outline | null {
  const o = outlineOf(realPlan().walls);
  return o && !o.issue && get().outlineOff !== o.key ? o : null;
}

/** Choose between the outline on the canvas and the preset shapes. */
export function setUseOutline(on: boolean): void {
  const o = outlineOf(realPlan().walls);
  set({ outlineOff: on || !o ? null : o.key });
}

function freshWalls(polygon: readonly { x: number; y: number }[]): PlanData['walls'] {
  return outlineSegments(polygon).map((s) => ({ id: crypto.randomUUID(), a: s.a, b: s.b }));
}

/** The floor area a preset outline is drawn at for the current brief. */
function outlineArea(brief: Brief): number {
  const lot = brief.lot ? brief.lot.w * brief.lot.d * 0.9 : Infinity;
  return Math.min(targetArea(brief) * (brief.area ? 1 : 1.04), lot);
}

/** A preset shape as an outline sized for the brief, turned if that is the only way it fits the lot. */
function presetFor(shape: PresetShape, brief: Brief): { polygon: { x: number; y: number }[]; w: number; h: number } | null {
  const preset = presetOutline(shape, outlineArea(brief));
  if (!preset) return null;
  const lot = brief.lot;
  const turned =
    !!lot &&
    (preset.box.w > lot.w + 1e-6 || preset.box.h > lot.d + 1e-6) &&
    preset.box.h <= lot.w + 1e-6 &&
    preset.box.w <= lot.d + 1e-6;
  return turned
    ? { polygon: preset.polygon.map((p) => ({ x: p.y, y: p.x })).reverse(), w: preset.box.h, h: preset.box.w }
    : { polygon: preset.polygon, w: preset.box.w, h: preset.box.h };
}

/** The shapes the wing recipes can't make: these are always drawn as an outline and filled. */
const FRAMED: readonly string[] = ['Z', 'H', 'plus', 'step'];

/**
 * The fixed footprint Claude is given for the next fresh run, if there is
 * one: the outline on the canvas, or — for the shapes that only exist as
 * outlines — the preset at the brief's size.
 */
export function frameForRun(): Outline | null {
  const drawn = outlineInUse();
  if (drawn) return drawn;
  const brief = get().brief;
  if (keptKeys().length || !FRAMED.includes(brief.shape)) return null;
  const preset = presetFor(brief.shape as PresetShape, brief);
  const frame = preset && outlineFromPolygon(preset.polygon);
  return frame && !frame.issue ? frame : null;
}

/**
 * Put a preset footprint on the canvas as plain walls, sized for the brief —
 * to be reshaped by dragging its walls, then filled. One undo step. A plan
 * that already has rooms is not overwritten: the outline is shown as a
 * preview to accept or dismiss.
 */
export function drawOutline(shape: PresetShape): void {
  const ui = useUiStore.getState();
  if (ui.readOnly) return;
  const brief = get().brief;
  const preset = presetFor(shape, brief);
  const label = SHAPES.find((s) => s.id === shape)?.label ?? 'Shape';
  if (!preset) {
    toast(`${label} needs a larger house than this brief.`);
    return;
  }
  const { polygon } = preset;
  const real = getPlanData();
  const bare = real.walls.length === 0 || readOutline(real.walls) !== null;
  const plan: PlanData = {
    ...real,
    walls: freshWalls(polygon),
    openings: [],
    roomNames: {},
    furniture: bare ? real.furniture : [],
  };
  set({ outlineOff: null });
  if (bare) {
    applyPlanData(plan, 'push', true);
    ui.setTool('select');
    toast(`${label} outline drawn — drag a wall to reshape it, then generate.`);
    return;
  }
  const units = real.settings.units;
  beginPreview(plan, {
    label: `${label} outline · ${formatLength(preset.w, units, 1)} × ${formatLength(preset.h, units, 1)}`,
    acceptLabel: 'Use this outline',
    onAccept: () => {
      useUiStore.getState().setTool('select');
      toast('The outline replaced your plan.', {
        action: { label: 'Undo', run: () => !useUiStore.getState().readOnly && undo() },
      });
    },
  });
}

/** Replace an outline that has angled walls (or steps too small for a room) with a square-cornered one. One undo step. */
export function squareOffOutline(): void {
  if (useUiStore.getState().readOnly) return;
  const real = getPlanData();
  const o = readOutline(real.walls);
  if (!o || !o.issue) return;
  const polygon = squareOff(o.polygon);
  applyPlanData({ ...real, walls: freshWalls(polygon), openings: [], roomNames: {} }, 'push', true);
  set({ outlineOff: null });
  toast('Outline squared off.', {
    action: { label: 'Undo', run: () => !useUiStore.getState().readOnly && undo() },
  });
}

/* ------------------------------------------------------------------ */
/* Keeping rooms                                                        */
/* ------------------------------------------------------------------ */

let roomsWalls: PlanData['walls'] | null = null;
let roomsNames: PlanData['roomNames'] | null = null;
let roomsCache: PlanRoom[] = [];

/** The rooms of a plan, for the "keep" list (remembered for the last plan, so it can be called on every render). */
export function roomsOf(walls: PlanData['walls'], roomNames: PlanData['roomNames']): PlanRoom[] {
  if (walls !== roomsWalls || roomNames !== roomsNames) {
    roomsWalls = walls;
    roomsNames = roomNames;
    roomsCache = walls.length > 400 ? [] : planRooms({ walls, roomNames });
  }
  return roomsCache;
}

/** The kept rooms that still exist on the plan (a plan needs a second room for keeping to mean anything). */
export function keptKeys(): string[] {
  const real = realPlan();
  const rooms = roomsOf(real.walls, real.roomNames);
  if (rooms.length < 2) return [];
  return get().keep.filter((k) => rooms.some((r) => r.key === k));
}

export function toggleKeep(key: string): void {
  set((s) => ({ keep: s.keep.includes(key) ? s.keep.filter((k) => k !== key) : [...s.keep, key] }));
}

/**
 * Options fitted to an outline are only good for that outline: once a
 * different one is on the canvas they are dropped. (An accepted option
 * leaves no outline at all — the rest of the set stays, to try another.)
 */
export function forgetStaleOptions(key: string | null): void {
  const s = get();
  if (!key || !s.outlineKey || s.outlineKey === key || s.running || usePreviewStore.getState().active) return;
  set({ options: [], note: null, outlineKey: null, activeId: null });
}

/* ------------------------------------------------------------------ */
/* Running                                                              */
/* ------------------------------------------------------------------ */

let controller: AbortController | null = null;
let runId = 0;
/** Bumped per run of the built-in engine so "again" gives a different set; reset when the brief changes. */
let seed = 0;
let seedKey = '';
let nextOptionId = 1;

/** The canvas is showing something that isn't ours to replace (a shared plan, someone's proposal). */
function blocked(): boolean {
  return useUiStore.getState().readOnly && !usePreviewStore.getState().active;
}

function briefKey(b: Brief, outline: Outline | null): string {
  return JSON.stringify({ ...b, wishes: '', outline: outline?.key ?? null });
}

type Made = Omit<GenOption, 'id' | 'letter'>;

interface Source {
  recipe?: Recipe;
  mask?: Rect[];
  inPlace?: boolean;
  shape?: string;
  keep?: KeepSetup;
}

function buildOption(layout: Layout, brief: Brief, engine: Engine, src: Source = {}): Made {
  // Rooms fitted into the person's outline stay exactly where they are.
  const built = layoutToPlan(layout, src.inPlace ? IN_PLACE : {}).plan;
  // Kept rooms get their names and furniture back.
  const plan = src.keep ? restoreKept(built, realPlan(), src.keep) : built;
  return {
    status: 'ready',
    engine,
    title: layout.title?.trim() || 'Layout',
    summary: layout.summary,
    layout,
    plan,
    // The outline decides the size, so there is no target to be over or under.
    score: scoreLayout(layout, src.inPlace ? { ...brief, area: null, lot: null } : brief),
    ...src,
  };
}

function patchOption(id: string, patch: Partial<GenOption>): void {
  set((s) => ({ options: s.options.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
}

function builtinOptions(
  brief: Brief,
  count: number,
  outline: Outline | null,
  base?: GenOption,
  keep?: KeepSetup,
): { made: Made[]; note: string | null } {
  const like = base?.layout
    ? { layout: base.layout, recipe: base.recipe, mask: base.mask, inPlace: base.inPlace, shape: base.shape }
    : undefined;
  const res = draftOptions(brief, { count, seed, outline: like ? null : outline, like, keep });
  const made: Made[] = [];
  for (const d of res.options) {
    try {
      made.push(buildOption(d.layout, brief, 'builtin', { recipe: d.recipe, mask: d.mask, inPlace: d.inPlace, shape: d.shape, keep }));
    } catch {
      /* a layout that can't become a plan is simply not offered */
    }
  }
  return { made, note: res.note };
}

export function cancelRun(): void {
  controller?.abort();
  controller = null;
  runId++;
  set((s) => ({ running: false, options: s.options.filter((o) => o.status === 'ready') }));
}

/**
 * Fill the option slots. With `likeId`, that option stays and the others are
 * regenerated as variations of it; otherwise all five are replaced. If the
 * canvas holds a bare outline (and it hasn't been set aside for a preset
 * shape), the rooms are fitted inside it.
 */
export function generate(likeId?: string): void {
  if (blocked()) return;
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  const run = ++runId;
  const brief = get().brief;

  const base = likeId ? get().options.find((o) => o.id === likeId && o.status === 'ready') : undefined;

  // Rooms being kept: the rest of the plan is re-planned around them (by the built-in drafter).
  let keep: KeepSetup | undefined = base?.keep;
  if (!base) {
    const keys = keptKeys();
    if (keys.length) {
      const res = keepSetup(realPlan(), keys);
      if (!res.ok) {
        controller = null;
        set({ options: [], running: false, engine: null, note: res.error, activeId: null });
        return;
      }
      keep = res.setup;
    }
  }
  // Variations of an option fitted to the outline stay in that outline; anything else starts from the canvas.
  const outline = keep ? null : base ? (base.inPlace ? outlineInUse() : null) : outlineInUse();

  const key = briefKey(brief, outline) + (keep ? `|keep:${keep.kept.map((k) => `${k.at.x},${k.at.y}`).join(';')}` : '');
  if (key !== seedKey) {
    seedKey = key;
    seed = 0;
  } else seed++;

  const kept: GenOption[] = base ? [{ ...base, letter: 'A' }] : [];
  const open = COUNT - kept.length;
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  // Claude needs the outline itself to vary a plan inside it; without one those variations are drawn here.
  const useClaude = aiReady() && online && !keep && !(base?.inPlace && !outline);

  const stillPreviewing = kept.some((o) => o.id === get().activeId);
  if (!stillPreviewing && get().activeId && usePreviewStore.getState().active) {
    // The option on the canvas is about to disappear from the list; keep the preview, drop the highlight.
    set({ activeId: null });
  }

  if (!useClaude) {
    const { made, note } = builtinOptions(brief, open, outline, base, keep);
    const options = [...kept, ...made.map((m) => ({ ...m, id: `g${nextOptionId++}`, letter: '' }))].map((o, i) => ({
      ...o,
      letter: LETTERS[i],
    }));
    controller = null;
    set({
      options,
      running: false,
      engine: 'builtin',
      outlineKey: outline?.key ?? null,
      note: note ?? (aiReady() && !online ? 'You’re offline — drawn by the built-in drafter.' : null),
    });
    if (stillPreviewing && base) previewOption(base.id);
    return;
  }

  // Claude: one call per slot, each steered by a different idea, landing as they finish.
  // A fixed footprint — the outline on the canvas, a shape that only exists as an outline, or
  // the footprint of the option being varied — is handed over and the reply held to it.
  let frame: Outline | null = outline;
  if (!frame && base?.mask && !base.inPlace) {
    const polygon = unionOutline(base.mask);
    frame = polygon ? outlineFromPolygon(polygon) : null;
  } else if (!frame && !base) frame = frameForRun();
  if (frame?.issue) frame = null;
  const ideas = base ? VARIATIONS : frame ? OUTLINE_IDEAS : IDEAS;
  const slots: GenOption[] = Array.from({ length: open }, (_, i) => ({
    id: `g${nextOptionId++}`,
    letter: '',
    status: 'pending' as const,
    engine: 'claude' as const,
    title: ideas[i % ideas.length].title,
  }));
  set({
    options: [...kept, ...slots].map((o, i) => ({ ...o, letter: LETTERS[i] })),
    running: true,
    engine: 'claude',
    outlineKey: outline?.key ?? null,
    note: null,
  });
  // The kept card is now "A": make the banner say so too.
  if (stillPreviewing && base) previewOption(base.id);

  let left = slots.length;
  let failures = 0;
  let firstError: unknown = null;
  let spare: Made[] | null = null;
  const fallback = (): Partial<GenOption> => {
    spare ??= builtinOptions(brief, COUNT, outline, base).made;
    return spare.shift() ?? { status: 'failed', error: 'Not drawn.' };
  };
  const src: Source = outline
    ? { inPlace: true, mask: outline.rects, shape: 'outline' }
    : frame
      ? { mask: frame.rects, shape: base?.shape ?? brief.shape }
      : {};

  slots.forEach((slot, i) => {
    askLayout(brief, ideas[i % ideas.length], { signal: ctrl.signal, base: base?.layout, outline: frame ?? undefined })
      .then((res) => {
        if (run === runId) patchOption(slot.id, buildOption(res.layout, brief, 'claude', src));
      })
      .catch((e: unknown) => {
        // A cancelled or superseded run bumps runId; anything else that fails gets a built-in stand-in.
        if (run !== runId) return;
        failures++;
        if (!isAbort(e)) firstError ??= e;
        // A missing or rejected key fails every slot the same way: stop the rest.
        if (e instanceof AiError && (e.kind === 'auth' || e.kind === 'no-key')) ctrl.abort();
        patchOption(slot.id, fallback());
      })
      .finally(() => {
        if (--left > 0 || run !== runId) return;
        controller = null;
        set({
          running: false,
          note:
            failures === 0
              ? null
              : failures === slots.length
                ? 'Claude couldn’t be reached — drawn by the built-in drafter.'
                : 'Some options were drawn by the built-in drafter.',
          ...(failures === slots.length ? { engine: 'builtin' as const } : {}),
        });
        if (failures === slots.length && firstError) toastError(aiErrorMessage(firstError));
      });
  });
}

/* ------------------------------------------------------------------ */
/* Preview and accept                                                  */
/* ------------------------------------------------------------------ */

let activeLabel = '';

// If the preview ends or something else takes it over, no card is "on the canvas" any more.
usePreviewStore.subscribe((s) => {
  if (get().activeId && (!s.active || s.label !== activeLabel)) set({ activeId: null });
});

function optionFacts(o: GenOption): string {
  const s = o.score!;
  const beds = s.bedrooms.got === 0 ? 'Studio' : `${s.bedrooms.got} bed`;
  return `${beds} · ${s.bathrooms.got} bath · ${formatArea(s.area, getPlanData().settings.units)}`;
}

/** Show an option on the canvas (and in Model view). The preview banner accepts it. */
export function previewOption(id: string): void {
  const option = get().options.find((o) => o.id === id);
  if (!option?.plan || blocked()) return;
  const pv = usePreviewStore.getState();
  // Under a preview the store holds the candidate; the real plan is the stash.
  const real = pv.active && pv.stash ? pv.stash : getPlanData();
  const wasEmpty = real.walls.length === 0 && real.furniture.length === 0;
  // Look, units and name stay the document's own (see dress.ts).
  const plan: PlanData = dressOption(option.plan, real, get().brief, {
    defaultName: DEFAULT_PLAN_NAME,
    // Furniture standing in a bare outline stays; an option re-planned around kept rooms
    // already carries the furniture that stays; anything else starts unfurnished.
    keepFurniture: !!option.inPlace && !option.keep && readOutline(real.walls) !== null,
  });
  const replanned = !!option.keep;
  const inPlace = !!option.inPlace;
  const letter = option.letter;
  activeLabel = `Option ${letter} · ${optionFacts(option)}`;
  beginPreview(plan, {
    label: activeLabel,
    onAccept: () => {
      set({ activeId: null, keep: [] });
      useUiStore.getState().setPanel(null);
      if (!wasEmpty) {
        toast(replanned ? `Option ${letter} re-planned the rest of your plan.` : inPlace ? `Option ${letter} now fills your outline.` : `Option ${letter} replaced your plan.`, {
          action: { label: 'Undo', run: () => !useUiStore.getState().readOnly && undo() },
        });
      }
      offerFurnish(wasEmpty ? `Option ${letter} is your plan now.` : 'Empty rooms — want furniture?');
    },
    onCancel: () => set({ activeId: null }),
  });
  set({ activeId: id });
}

let furnishing = false;

function offerFurnish(text: string): void {
  toast(text, {
    ms: 9000,
    action: {
      label: 'Furnish it',
      run: () => {
        if (furnishing || useUiStore.getState().readOnly) return;
        furnishing = true;
        toast('Furnishing every room…');
        furnishWholePlan()
          .then((r) => {
            if (r.placed === 0) toast('Nothing to add — the rooms couldn’t be furnished.');
            else {
              toast(`Placed ${r.placed} pieces in ${r.rooms} ${r.rooms === 1 ? 'room' : 'rooms'}.`, {
                action: { label: 'Undo', run: () => !useUiStore.getState().readOnly && undo() },
              });
            }
          })
          .catch((e: unknown) => {
            if (!isAbort(e)) toastError(aiErrorMessage(e));
          })
          .finally(() => {
            furnishing = false;
          });
      },
    },
  });
}
