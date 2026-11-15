/**
 * The demo: Gaudí drives itself for about a minute — draws a house, furnishes
 * it, builds it, dresses it, renders it — with a caption for each step.
 *
 * It uses the real app the way a person would (the same stores, the same 3D
 * view), on a preview: nothing is saved, nothing is undoable, and the plan
 * that was on the canvas comes back when it ends. No AI call is ever made, so
 * it runs without a key and costs nothing.
 */
import { beginPreview, cancelPreview, usePreviewStore } from '../preview';
import { createFromTemplate } from '../projects/projectStore';
import { buildTemplate, templateById } from '../projects/templates';
import { useShareStore } from '../share/shareStore';
import { usePlanStore } from '../store';
import { RENDER_SAMPLES, setRenderSamples, useRenderStore } from '../three/render/renderStore';
import { sceneHandle } from '../three/sceneHandles';
import { useViewStore } from '../three/viewStore';
import type { PlanData, PlanLook, Wall } from '../types';
import { useUiStore } from '../uiStore';
import { useDemoStore } from './demoStore';

const TEMPLATE = 'courtyard';
const FINAL_LOOK: PlanLook = { style: 'warm-modern', roof: 'hip' };

class Stopped extends Error {}

/** One run of the tour. A newer run, or ending the demo, makes every wait in an older one throw. */
let run = 0;

function alive(id: number): void {
  if (id !== run) throw new Stopped();
}

function wait(id: number, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      try {
        alive(id);
        resolve();
      } catch (e) {
        reject(e);
      }
    }, ms);
  });
}

function frame(id: number): Promise<number> {
  return new Promise((resolve, reject) => {
    requestAnimationFrame((now) => {
      try {
        alive(id);
        resolve(now);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Wait until `test` holds, or `timeout` ms have gone by. True if it came to hold. */
async function until(id: number, test: () => boolean, timeout: number): Promise<boolean> {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > timeout) return false;
    await wait(id, 60);
  }
  return true;
}

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type V3 = [number, number, number];

/** Glide the camera to a new place and aim over `ms`. */
async function fly(id: number, position: V3, target: V3, ms: number): Promise<void> {
  const h = sceneHandle.current;
  if (!h || !h.controls) return;
  const p0: V3 = [h.camera.position.x, h.camera.position.y, h.camera.position.z];
  const t0: V3 = [h.controls.target.x, h.controls.target.y, h.controls.target.z];
  const start = performance.now();
  for (;;) {
    const now = await frame(id);
    const live = sceneHandle.current;
    if (!live || !live.controls) return;
    const k = ease(Math.min(1, (now - start) / ms));
    live.camera.position.set(p0[0] + (position[0] - p0[0]) * k, p0[1] + (position[1] - p0[1]) * k, p0[2] + (position[2] - p0[2]) * k);
    live.controls.target.set(t0[0] + (target[0] - t0[0]) * k, t0[1] + (target[1] - t0[1]) * k, t0[2] + (target[2] - t0[2]) * k);
    live.controls.update();
    live.invalidate();
    if (k >= 1) return;
  }
}

/** Turn the camera slowly around what it is looking at, for `ms`. */
async function orbit(id: number, radians: number, ms: number): Promise<void> {
  const start = performance.now();
  let last = 0;
  for (;;) {
    const now = await frame(id);
    const h = sceneHandle.current;
    if (!h || !h.controls) return;
    const k = ease(Math.min(1, (now - start) / ms));
    const step = (k - last) * radians;
    last = k;
    const dx = h.camera.position.x - h.controls.target.x;
    const dz = h.camera.position.z - h.controls.target.z;
    const c = Math.cos(step);
    const s = Math.sin(step);
    h.camera.position.set(h.controls.target.x + dx * c - dz * s, h.camera.position.y, h.controls.target.z + dx * s + dz * c);
    h.controls.update();
    h.invalidate();
    if (k >= 1) return;
  }
}

/** Slide the time of day from where it is to `hour`. */
async function turnClock(id: number, hour: number, ms: number): Promise<void> {
  const from = useViewStore.getState().sunHour;
  const start = performance.now();
  for (;;) {
    const now = await frame(id);
    const k = ease(Math.min(1, (now - start) / ms));
    useViewStore.getState().setSunHour(from + (hour - from) * k);
    if (k >= 1) return;
  }
}

/** Walls in the order a person would draw them: each one starting where an earlier one ended. */
function drawingOrder(walls: Wall[]): Wall[] {
  const left = [...walls];
  const out: Wall[] = [];
  const key = (p: { x: number; y: number }): string => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  const seen = new Set<string>();
  let tip: string | null = null;
  while (left.length > 0) {
    let i = tip === null ? -1 : left.findIndex((w) => key(w.a) === tip || key(w.b) === tip);
    if (i === -1) i = left.findIndex((w) => seen.has(key(w.a)) || seen.has(key(w.b)));
    if (i === -1) i = 0;
    const [w] = left.splice(i, 1);
    out.push(w);
    const a = key(w.a);
    const b = key(w.b);
    tip = tip === a ? b : tip === b ? a : b;
    seen.add(a);
    seen.add(b);
  }
  return out;
}

function say(step: number, caption: string, detail = ''): void {
  useDemoStore.setState({ phase: 'playing', step, caption, detail });
}

/** Where the plan sits: its centre and half-size, as the 3D view sees it (x east, z south). */
function boundsOf(plan: PlanData): { x: number; z: number; r: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const w of plan.walls) {
    for (const p of [w.a, w.b]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { x: (minX + maxX) / 2, z: (minY + maxY) / 2, r: Math.max((maxX - minX) / 2, (maxY - minY) / 2, 3) };
}

const STEPS = 9;

async function play(id: number, full: PlanData): Promise<void> {
  const ui = useUiStore.getState();
  const view = useViewStore.getState();
  const plan = usePlanStore.getState();
  const b = boundsOf(full);
  const aerial: V3 = [b.x + b.r * 1.4, b.r * 2.3, b.z + b.r * 1.8];
  const centre: V3 = [b.x, 0, b.z];

  // ---- behind the title card: fetch everything the 3D view will want, so nothing pops in later
  useDemoStore.setState({ phase: 'title', step: 0, steps: STEPS, caption: '', detail: '' });
  const shown = performance.now();
  plan.setPlan({ ...full, look: { style: 'warm-modern', roof: 'hip' } });
  view.setView('exterior');
  ui.setMode('model');
  await until(id, () => sceneHandle.current !== null, 8000);
  for (const style of ['scandinavian', 'mediterranean', 'warm-modern']) {
    usePlanStore.getState().setLook({ style });
    await wait(id, 120);
  }
  useViewStore.getState().setSunHour(19.3);
  await wait(id, 150);
  useViewStore.getState().setSunHour(12);
  await until(id, () => sceneHandle.current?.lit() ?? false, 5000);
  await wait(id, 900);
  // Back to the drawing board, zoomed to where the house will be.
  ui.setMode('plan');
  ui.setDrawingLook('color');
  ui.requestFit();
  await wait(id, 120);
  plan.setPlan({ ...full, walls: [], openings: [], furniture: [], look: { style: 'warm-modern', roof: 'none' } });
  const since = performance.now() - shown;
  if (since < 2600) await wait(id, 2600 - since);

  // ---- 1 · walls
  say(0, 'Draw the walls', 'or describe the house in a sentence and let Gaudí draft five layouts');
  const walls = drawingOrder(full.walls);
  for (let i = 1; i <= walls.length; i++) {
    usePlanStore.setState({ walls: walls.slice(0, i) });
    await wait(id, 95);
  }
  await wait(id, 700);

  // ---- 2 · openings
  say(1, 'Rooms name and measure themselves', 'doors and windows snap into the walls');
  for (let i = 1; i <= full.openings.length; i++) {
    usePlanStore.setState({ openings: full.openings.slice(0, i) });
    await wait(id, 75);
  }
  await wait(id, 900);

  // ---- 3 · furniture
  say(2, 'Furnish it', 'by hand, with AI, or with real products from a shopping link, built in 3D at true size');
  for (let i = 1; i <= full.furniture.length; i++) {
    usePlanStore.setState({ furniture: full.furniture.slice(0, i) });
    await wait(id, 60);
  }
  await wait(id, 1700);

  // ---- 4 · build
  say(3, 'One click builds the house', 'the model is always made from the plan, never drawn twice');
  useViewStore.getState().setView('dollhouse');
  useViewStore.getState().setPose({ position: aerial, target: centre, fitNonce: useUiStore.getState().fitNonce });
  ui.setMode('model');
  await until(id, () => sceneHandle.current !== null, 8000);
  await wait(id, 1900);
  await orbit(id, 0.6, 3400);

  // ---- 5 · looks
  say(4, 'Choose a look', 'materials, furniture and light change together');
  for (const style of ['scandinavian', 'mediterranean', 'warm-modern']) {
    usePlanStore.getState().setLook({ style });
    await orbit(id, 0.22, 1700);
  }

  // ---- 6 · roof
  say(5, 'Put the roof on', 'flat, gable or hip, fitted to any outline');
  usePlanStore.getState().setLook({ roof: FINAL_LOOK.roof });
  useViewStore.getState().setView('exterior');
  const [fx, fz] = useViewStore.getState().front;
  const [sx, sz] = [-fz, fx];
  const corner: V3 = [b.x + fx * b.r * 2.4 + sx * b.r * 2.1, b.r * 0.8 + 2.5, b.z + fz * b.r * 2.4 + sz * b.r * 2.1];
  await fly(id, corner, [b.x, 1.1, b.z], 2200);
  await wait(id, 1300);

  // ---- 7 · time of day
  say(6, 'See it at any hour', 'the sun moves, and the lamps come on at dusk');
  await turnClock(id, 19.2, 3600);
  await wait(id, 1200);

  // ---- 8 · look inside, by lamplight
  say(7, 'Look in on any room', 'or walk through it at eye level');
  useViewStore.getState().setView('dollhouse');
  await fly(id, [b.x + b.r * 0.75, b.r * 1.15, b.z + b.r * 1.05], [b.x - b.r * 0.1, 0.4, b.z - b.r * 0.1], 2400);
  await orbit(id, -0.5, 3400);

  // ---- 9 · render
  say(8, 'Render it', 'real light bounces, traced in the browser, saved up to 4K');
  useViewStore.getState().setView('exterior');
  await Promise.all([turnClock(id, 15.5, 1600), fly(id, corner, [b.x, 1.1, b.z], 2000)]);
  await wait(id, 300);
  const samples = RENDER_SAMPLES;
  setRenderSamples(40);
  try {
    useRenderStore.getState().start();
    const settled = await until(
      id,
      () => ['done', 'error', 'off'].includes(useRenderStore.getState().phase),
      20000,
    );
    if (settled && useRenderStore.getState().phase === 'done') await wait(id, 2600);
  } finally {
    setRenderSamples(samples);
    useRenderStore.getState().stop();
  }

  useDemoStore.setState({ phase: 'end', caption: '', detail: '' });
}

/** Put the app's view settings back the way the tour found them. */
function restoreView(saved: { drawingLook: ReturnType<typeof useUiStore.getState>['drawingLook'] }): void {
  useRenderStore.getState().stop();
  useViewStore.getState().setSunHour(12);
  useViewStore.getState().setView('dollhouse');
  useViewStore.getState().setPose(null);
  useUiStore.getState().setDrawingLook(saved.drawingLook);
}

let savedView: { drawingLook: ReturnType<typeof useUiStore.getState>['drawingLook'] } | null = null;

/** Start the demo (or start it over). Does nothing while a shared plan or another preview is up. */
export function startDemo(): void {
  if (useShareStore.getState().viewId) return;
  const replay = useDemoStore.getState().phase !== 'off';
  if (!replay && usePreviewStore.getState().active) return;
  const template = templateById(TEMPLATE);
  if (!template) return;
  const { plan: full } = buildTemplate(template, { units: usePlanStore.getState().settings.units });

  const id = ++run;
  const ui = useUiStore.getState();
  if (!replay) {
    const now = usePlanStore.getState();
    savedView = { drawingLook: ui.drawingLook };
    useDemoStore.setState({ hadPlan: now.walls.length > 0 || now.furniture.length > 0 });
    ui.setPanel(null);
    ui.closeCommand();
    useShareStore.setState({ drawerOpen: false });
    beginPreview({ ...full, walls: [], openings: [], furniture: [] }, { label: 'Demo' });
  } else {
    useRenderStore.getState().stop();
    useViewStore.getState().setSunHour(12);
  }

  void play(id, full).catch((e) => {
    if (!(e instanceof Stopped)) {
      // Whatever went wrong, never leave the visitor stuck inside a demo.
      if (id === run) endDemo('back');
    }
  });
}

/**
 * End the demo. 'back' returns to the plan that was there (or the empty start
 * sheet); 'keep' also opens the demo house as a new project of the visitor's own.
 */
export function endDemo(how: 'back' | 'keep'): void {
  if (useDemoStore.getState().phase === 'off') return;
  run++;
  if (savedView) restoreView(savedView);
  savedView = null;
  useDemoStore.setState({ phase: 'off', caption: '', detail: '' });
  cancelPreview();
  if (location.hash === '#/demo') window.history.replaceState(null, '', location.pathname + location.search);
  const ui = useUiStore.getState();
  if (how === 'keep' && createFromTemplate(TEMPLATE)) {
    usePlanStore.getState().setLook(FINAL_LOOK);
    useViewStore.getState().setView('exterior');
    ui.setMode('model');
  } else {
    ui.setMode('plan');
  }
}
