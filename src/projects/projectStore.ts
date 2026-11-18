/**
 * Projects, wired to the app: which library entry the canvas belongs to,
 * autosave into it, and the handful of things you can do with a project.
 *
 * The working plan stays where it always was (the plan store's own storage
 * key). The library keeps named copies; the current project's copy follows
 * the canvas a moment after every change. Nothing is ever saved while the
 * canvas holds something that is not the user's own plan (a shared link, a
 * proposal or generated option being previewed).
 */
import { create } from 'zustand';
import { emptyPlanData, lastStorageWarning, pickPlan, PLAN_KEYS, usePlanStore } from '../store';
import { applyPlanData, clonePlan, getPlanData } from '../plan';
import { planIsEphemeral } from '../session';
import { cancelPreview, usePreviewStore } from '../preview';
import { parsePlanJSON } from '../serialize';
import { clearShareDoc, enterSharedView, exitSharedView, useShareStore } from '../share/shareStore';
import { toast, toastError } from '../toast';
import { useUiStore } from '../uiStore';
import type { PlanData } from '../types';
import {
  canonical,
  currentProjectId,
  documentToken,
  holderOf,
  isSameDocument,
  library,
  onLibraryChange,
  setCurrentProject,
  switchDocument,
  type DocumentToken,
} from './lib';
import { buildTemplate, TEMPLATES, templateById } from './templates';
import {
  INDEX_KEY,
  LEGACY_SHARE_KEY,
  isBlankPlan,
  uniqueName,
  type MetaPatch,
  type ProjectMeta,
  type SaveResult,
} from './library';

interface ProjectState {
  /** Newest first. */
  projects: ProjectMeta[];
  /** The project the canvas belongs to; null for a blank plan not yet worth keeping. */
  currentId: string | null;
}

export const useProjectStore = create<ProjectState>(() => ({ projects: [], currentId: null }));

function sync(): void {
  useProjectStore.setState({ projects: library.list(), currentId: currentProjectId() });
}

// ---------- autosave ----------

const SAVE_MS = 700;

/** The user's own plan as of the last change, waiting to be written. */
let pending: { id: string | null; plan: PlanData; doc: DocumentToken } | null = null;
let timer: number | undefined;
/** >0 while this module swaps the plan itself (opening a project is not an edit). */
let muted = 0;
let warnedFull = 0;

/**
 * Storage refused a library write. Autosave fails again with every edit, so
 * it is announced at most once a minute, and not on top of the plan store's
 * own notice for the same edit. A refused action (`what` happened) is always
 * answered, once.
 */
function reportFull(what?: string): void {
  const now = Date.now();
  if (!what && now - Math.max(warnedFull, lastStorageWarning()) < 60_000) return;
  warnedFull = now;
  toastError(
    `Browser storage is full — ${what ?? 'this plan is not being saved to Projects. Export it to keep a copy.'}`,
  );
}

/** Save `plan`, captured while document `doc` (project `id`, if it was one) was on the canvas. False when storage refused. */
function write(id: string | null, plan: PlanData, doc: DocumentToken): boolean {
  let res: SaveResult | null = null;
  if (id && library.meta(id)) {
    res = library.save(id, plan);
    // Keep the stored pointer with whichever tab wrote the working plan last.
    if (res.ok && currentProjectId() === id && library.current() !== id) library.setCurrent(id);
  } else if (!isBlankPlan(plan)) {
    // First real content on a fresh canvas (or its project was deleted elsewhere): it becomes a project.
    res = library.create(plan);
    // The canvas follows only if it still holds that document: "no project" is not an identity, and
    // another unsaved plan may have taken the canvas since (a shared link left for another tab's plan).
    if (res.ok && currentProjectId() === id && isSameDocument(doc)) setCurrentProject(res.meta.id);
  }
  return !res || res.ok;
}

function flush(quiet: boolean): boolean {
  window.clearTimeout(timer);
  timer = undefined;
  const job = pending;
  if (!job) return true;
  pending = null;
  const ok = write(job.id, job.plan, job.doc);
  if (!ok) {
    // Still waiting: the next change or the next flush tries again, and the canvas is not given away meanwhile.
    pending = job;
    if (!quiet) reportFull();
  }
  sync();
  return ok;
}

/**
 * Write any waiting change now (before switching project, before the tab
 * goes away). False when storage refused it; the change stays waiting.
 */
export function flushAutosave(): boolean {
  return flush(false);
}

/**
 * Save what is waiting before another document takes the canvas. False, and
 * said, when it could not be saved: switching then would drop those changes,
 * so the plan stays where it is.
 */
function saveBeforeLeaving(): boolean {
  if (flush(true)) return true;
  reportFull("this plan's latest changes could not be saved, so it stays open. Export it, or delete a project to make room.");
  return false;
}

function onPlanChange(state: PlanData, prev: PlanData): void {
  if (muted > 0) return;
  if (PLAN_KEYS.every((k) => state[k] === prev[k])) return;
  // Captured only while the canvas is the user's own plan, so what is written later is always theirs.
  if (planIsEphemeral()) return;
  pending = { id: currentProjectId(), plan: pickPlan(state), doc: documentToken() };
  window.clearTimeout(timer);
  timer = window.setTimeout(flushAutosave, SAVE_MS);
}

// ---------- switching ----------

/** Step out of a shared link or a preview so the canvas is the user's own plan again. */
function leaveEphemeral(): void {
  if (usePreviewStore.getState().active) cancelPreview();
  if (useShareStore.getState().viewId) exitSharedView();
}

/** Put a different document on the canvas. Not an edit: no autosave, fresh undo history. */
function swapTo(plan: PlanData, id: string | null): void {
  const before = getPlanData();
  muted++;
  try {
    // The pointer moves with the plan, and only if the plan goes in.
    switchDocument(id, () => applyPlanData(plan, 'reset'));
  } catch (e) {
    try {
      applyPlanData(before, 'skip'); // whatever part of the old plan was replaced
    } catch {
      /* the first error is the one to report */
    }
    throw e;
  } finally {
    muted--;
  }
  const ui = useUiStore.getState();
  ui.setSelection([]);
  if (ui.tool === 'furniture') ui.setTool('select');
  ui.setPaletteOpen(false);
  clearShareDoc();
  sync();
}

function blankPlan(): PlanData {
  const plan = emptyPlanData();
  // Units are a habit of the person, not of the plan.
  plan.settings.units = usePlanStore.getState().settings.units;
  return plan;
}

export function openProject(id: string): boolean {
  leaveEphemeral();
  if (!saveBeforeLeaving()) return false;
  if (id === currentProjectId()) return true;
  const rec = library.record(id);
  if (!rec) {
    library.prune();
    sync();
    toastError('That project could not be read.');
    return false;
  }
  swapTo(rec.plan, id);
  return true;
}

/** A clean sheet. The plan that was open is already in the library. */
export function newProject(): void {
  leaveEphemeral();
  if (!saveBeforeLeaving()) return;
  if (!currentProjectId() && isBlankPlan(getPlanData())) return;
  swapTo(blankPlan(), null);
}

/** Add `plan` to the library under a free name and open it. */
export function createProject(plan: PlanData, extra: MetaPatch = {}): string | null {
  leaveEphemeral();
  if (!saveBeforeLeaving()) return null;
  const name = uniqueName(plan.name, library.list().map((p) => p.name));
  const res = library.create({ ...plan, name }, extra);
  if (!res.ok) {
    reportFull('the new project could not be made. Delete a project to make room.');
    return null;
  }
  const rec = library.record(res.meta.id);
  if (!rec) return null;
  swapTo(rec.plan, res.meta.id);
  return res.meta.id;
}

/**
 * "Open plan…": the file becomes a project of its own. The plan that was on
 * the canvas is saved first and stays in the library. Every outcome is shown.
 */
export function openPlanFile(text: string): string | null {
  const parsed = parsePlanJSON(text);
  if (!parsed.ok) {
    toastError(`Couldn't open that file: ${parsed.error}`);
    return null;
  }
  const id = createProject(parsed.plan);
  if (!id) return null;
  toast(`Opened “${library.meta(id)?.name ?? parsed.plan.name}” as a new project.`);
  return id;
}

export function duplicateProject(id: string): void {
  if (id === currentProjectId()) flushAutosave();
  const res = library.duplicate(id);
  if (!res.ok) {
    if (res.reason === 'quota') reportFull('the copy could not be made. Delete a project to make room.');
    else toastError('That project could not be read.');
  }
  sync();
}

export function renameProject(id: string, name: string): void {
  const clean = name.trim();
  if (!clean) return;
  if (id === currentProjectId()) {
    // The canvas is (or goes back to being) this project: rename the plan itself, undoably, and save at once.
    leaveEphemeral();
    usePlanStore.getState().setName(clean);
    flushAutosave();
    return;
  }
  const res = library.rename(id, clean);
  if (!res.ok && res.reason === 'quota') reportFull('the project could not be renamed.');
  sync();
}

/** Rename the plan on the canvas (the top bar's name field). */
export function renameCurrent(name: string): void {
  if (useUiStore.getState().readOnly) return;
  usePlanStore.getState().setName(name);
  if (!planIsEphemeral()) flushAutosave();
}

/** Delete at once; the toast offers the way back. */
export function deleteProject(id: string): void {
  const wasCurrent = id === currentProjectId();
  if (wasCurrent) {
    leaveEphemeral();
    flushAutosave();
    pending = null; // a change that could not be saved goes with the project
  }
  const name = library.meta(id)?.name ?? 'Project';
  const removed = library.remove(id);
  if (wasCurrent) {
    const next = library.list()[0];
    const rec = next ? library.record(next.id) : null;
    if (rec) swapTo(rec.plan, rec.meta.id);
    else swapTo(blankPlan(), null);
  }
  sync();
  toast(`Deleted “${name}”.`, {
    action: removed
      ? {
          label: 'Undo',
          run: () => {
            const res = library.restore(removed);
            if (!res.ok) {
              reportFull('the project could not be put back.');
              return;
            }
            sync();
            if (wasCurrent) openProject(removed.meta.id);
          },
        }
      : undefined,
  });
}

/** Start a new project from a starter template. */
export function createFromTemplate(templateId: string): string | null {
  const template = templateById(templateId);
  if (!template) return null;
  // Read the units after stepping out of any shared view: the user's habit, not the visitor plan's.
  leaveEphemeral();
  if (template.big) {
    // A whole campus is fetched, not built here: the project appears when it arrives.
    const units = usePlanStore.getState().settings.units;
    toast(`Opening ${template.name}…`);
    void template.big.load().then(
      (plan) => {
        createProject({ ...plan, settings: { ...plan.settings, units } }, { template: template.id });
      },
      () => toastError(`${template.name} could not be opened. Check the connection and try again.`),
    );
    return `opening:${template.id}`;
  }
  const { plan } = buildTemplate(template, { units: usePlanStore.getState().settings.units });
  return createProject(plan, { template: template.id });
}

/**
 * Copy the shared plan on the canvas into the visitor's own library as a new
 * project, remember where it came from, and leave the shared view.
 */
export function remixShared(): string | null {
  const share = useShareStore.getState();
  if (!share.viewId) return null;
  const from = share.viewId;
  // What is on the canvas: the shared plan, plus anything the visitor changed in a draft.
  const source = clonePlan(getPlanData());
  exitSharedView();
  const id = createProject({ ...source, name: `${source.name} (remix)` }, {
    remixedFrom: from,
    remixedName: source.name,
  });
  if (!id) return null;
  useShareStore.setState({ drawerOpen: false });
  toast('Remixed into your projects.');
  return id;
}

// ---------- start-up ----------

function hasLegacyShare(): boolean {
  try {
    return localStorage.getItem(LEGACY_SHARE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Line the library up with the working plan: adopt a plan from before
 * projects existed, move the old one-per-browser share link onto it, and
 * catch up if the tab closed before the last autosave.
 *
 * The working plan is only ever saved into the project it names as its owner
 * (lib.ts stamps that into the working copy with every write). The stored
 * pointer is shared by every tab and may have moved since the copy was
 * written, so on its own it proves nothing: a working copy with no owner goes
 * to a project only when that project already holds exactly this plan
 * (`holderOf`), and otherwise becomes a project of its own.
 */
function init(): void {
  if (planIsEphemeral()) {
    sync();
    return;
  }
  const plan = getPlanData();
  const blank = isBlankPlan(plan);
  // At start-up this is the owner the working copy names, or nobody.
  let cur = currentProjectId();
  if (cur && !library.meta(cur)) cur = null;
  let inStep = false;
  if (!cur && !blank) {
    cur = holderOf(plan);
    inStep = cur !== null;
  }
  // A blank canvas next to a saved project means the working copy was lost, not emptied: leave the project be.
  if (cur && blank) cur = null;
  setCurrentProject(cur);
  if (!cur && (!blank || hasLegacyShare())) {
    const res = library.create(plan);
    if (res.ok) {
      cur = res.meta.id;
      setCurrentProject(cur);
    }
  } else if (cur && !inStep) {
    const rec = library.record(cur);
    if (!rec || canonical(rec.plan) !== canonical(plan)) library.save(cur, plan);
  }
  if (cur) library.adoptLegacyShare(cur);
  sync();
}

init();

const unsubPlan = usePlanStore.subscribe(onPlanChange);
const unsubLib = onLibraryChange(sync);

/** Another tab changed the library. */
function onStorage(e: StorageEvent): void {
  if (e.key === null || e.key === INDEX_KEY) sync();
}
function onHide(): void {
  if (document.visibilityState === 'hidden') flushAutosave();
}
window.addEventListener('storage', onStorage);
window.addEventListener('pagehide', flushAutosave);
document.addEventListener('visibilitychange', onHide);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    flushAutosave();
    unsubPlan();
    unsubLib();
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pagehide', flushAutosave);
    document.removeEventListener('visibilitychange', onHide);
  });
}

if (import.meta.env.DEV) {
  // Dev handle for tests and the console: window.__gaudi.projects
  const w = window as unknown as { __gaudi?: Record<string, unknown> };
  w.__gaudi = {
    ...(w.__gaudi ?? {}),
    projects: {
      library,
      store: useProjectStore,
      current: currentProjectId,
      open: openProject,
      create: createProject,
      openFile: openPlanFile,
      newPlan: newProject,
      duplicate: duplicateProject,
      rename: renameProject,
      remove: deleteProject,
      remix: remixShared,
      flush: flushAutosave,
      templates: TEMPLATES,
      fromTemplate: createFromTemplate,
    },
    // Share flows: __gaudi.share.enter(id) / .exit() / .store.getState()
    share: { store: useShareStore, enter: enterSharedView, exit: exitSharedView },
  };
}
