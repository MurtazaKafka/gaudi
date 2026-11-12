/**
 * The one library instance, bound to this browser's localStorage, plus a tiny
 * change signal so the project list re-reads after anything writes to it.
 * (Kept apart from projectStore so the share client can read the current
 * project's link without importing the autosave machinery.)
 */
import { clonePlan, normalizePlan } from '../plan';
import { usePlanStore } from '../store';
import { createLibrary, isBlankPlan, isProjectId, type StorageLike } from './library';
import type { PlanData } from '../types';

/** localStorage, or a throwaway in-memory stand-in when the browser refuses it. */
function browserStorage(): StorageLike {
  try {
    const s = window.localStorage;
    s.getItem('gaudi-projects-v1');
    return s;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    };
  }
}

const storage = browserStorage();

export const library = createLibrary(storage, { normalize: normalizePlan });

const listeners = new Set<() => void>();

/** Run `fn` after every library write made outside the project store. */
export function onLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function libraryChanged(): void {
  for (const fn of [...listeners]) fn();
}

// ---------- whose plan the working copy is ----------

/** The plan store's own storage key: the user's working plan, shared by every tab. */
const WORKING_KEY = 'gaudi-plan-v1';

interface WorkingCopy {
  /**
   * The project the copy says it belongs to: an id, null (not a project
   * yet), or undefined when it names no owner (written before it could) or
   * cannot be read.
   */
  owner: string | null | undefined;
  /** The stored plan, not yet validated. */
  state: unknown;
}

function readWorking(): WorkingCopy {
  try {
    const raw = storage.getItem(WORKING_KEY);
    const saved = raw ? (JSON.parse(raw) as unknown) : null;
    if (typeof saved !== 'object' || saved === null) return { owner: undefined, state: undefined };
    const owner = 'owner' in saved ? (isProjectId(saved.owner) ? saved.owner : null) : undefined;
    return { owner, state: 'state' in saved ? saved.state : undefined };
  } catch {
    return { owner: undefined, state: undefined };
  }
}

/** Whose plan the working copy was when this tab started (see `WorkingCopy.owner`). */
const ownerAtStart = readWorking().owner;

/** A plan as text, for telling whether two are the same plan. */
export const canonical = (plan: PlanData): string => {
  const r = normalizePlan(clonePlan(plan));
  return r.ok ? JSON.stringify(r.plan) : '';
};

/**
 * Whose a plan is when its working copy names no owner: a project that
 * already holds exactly this plan — the stored pointer's first, then any of
 * the same name — or nobody. The pointer on its own proves nothing: every tab
 * moves it, so it may have changed since the copy was written.
 */
export function holderOf(plan: PlanData): string | null {
  const hint = library.current();
  const ids = library.list().filter((p) => p.name === plan.name && p.id !== hint).map((p) => p.id);
  if (hint) ids.unshift(hint);
  let text: string | undefined;
  for (const id of ids) {
    const rec = library.record(id);
    if (rec && canonical(rec.plan) === (text ??= canonical(plan))) return id;
  }
  return null;
}

/**
 * Which project this tab's canvas belongs to. Read once, at start-up, from
 * the working copy itself (nobody's when it does not say: the project store
 * then looks for a project that holds exactly that plan). After that each tab
 * keeps its own, so two tabs on two projects never save into each other.
 */
let tabCurrent: string | null = ownerAtStart ?? null;
/** The owner this tab last saw or wrote on the working copy. */
let stamped: string | null | undefined = ownerAtStart;
/** Goes up each time a different document is put on the canvas. */
let documentSeq = 0;

type PlanStorage = NonNullable<ReturnType<typeof usePlanStore.persist.getOptions>['storage']>;

/**
 * Every write of the working copy carries its owner, in the same value. Tabs
 * share that one key, so "which project is this plan?" kept anywhere else can
 * be changed by another tab between a write and the next start-up, and the
 * plan would then be saved into the wrong project.
 */
function stampWorkingCopy(): void {
  const now = usePlanStore.persist.getOptions().storage as (PlanStorage & { plain?: PlanStorage }) | undefined;
  if (!now) return;
  const plain = now.plain ?? now; // a hot reload wraps the original again, not the old wrapper
  usePlanStore.persist.setOptions({
    storage: {
      plain,
      getItem: (name) => plain.getItem(name),
      removeItem: (name) => plain.removeItem(name),
      setItem: (name, value) => {
        if (name !== WORKING_KEY) return plain.setItem(name, value);
        stamped = tabCurrent;
        return plain.setItem(name, { ...value, owner: tabCurrent } as typeof value);
      },
    } as PlanStorage,
  });
}
stampWorkingCopy();

export const currentProjectId = (): string | null => tabCurrent;

/** Which document is on the canvas, to be asked about later (see `isSameDocument`). */
export interface DocumentToken {
  seq: number;
  id: string | null;
}

export const documentToken = (): DocumentToken => ({ seq: documentSeq, id: tabCurrent });

/**
 * True when the canvas still belongs to the document `token` was taken on:
 * nothing else has taken the canvas since (a plan that became a project on
 * its first save is still the same document), or it is back on the same
 * saved project.
 */
export const isSameDocument = (token: DocumentToken): boolean =>
  token.seq === documentSeq || (token.id !== null && token.id === tabCurrent);

/**
 * The plan on the canvas now belongs to `id` (it was just saved as a project,
 * or stopped being one). The same document: only the pointer moves.
 */
export function setCurrentProject(id: string | null): void {
  tabCurrent = id;
  library.setCurrent(id);
  // Rewrite the working copy so it names its new owner. Only when the store is on the user's own key:
  // while a shared link or a preview is up it writes elsewhere, and the write that brings the plan back stamps it.
  if ((stamped ?? null) !== id && usePlanStore.persist.getOptions().name === WORKING_KEY) {
    usePlanStore.setState(usePlanStore.getState());
  }
}

/**
 * Put a different document on the canvas. `load` swaps the plan in; the
 * working copy it writes is stamped as `id`'s. If it throws, the pointer has
 * not moved; the stored pointer follows only once the plan is in.
 */
export function switchDocument(id: string | null, load: () => void): void {
  const before = tabCurrent;
  tabCurrent = id;
  try {
    load();
  } catch (e) {
    tabCurrent = before;
    throw e;
  }
  library.setCurrent(id);
  documentSeq++;
}

/**
 * Take the pointer from storage again. Call when this tab reloads its working
 * plan from storage (leaving a shared link): another tab may have switched
 * projects meanwhile, and the plan and the pointer must stay a pair.
 */
export function resyncCurrentFromStorage(): void {
  const copy = readWorking();
  let next = copy.owner ?? null;
  if (!next) {
    const parsed = normalizePlan(copy.state);
    if (parsed.ok && !isBlankPlan(parsed.plan)) next = holderOf(parsed.plan);
  }
  tabCurrent = next;
  stamped = copy.owner;
  // Read back from storage, it is the same document only if it is the same saved project.
  documentSeq++;
  libraryChanged();
}

/** The share link that belongs to the project on the canvas, if it has one. */
export function currentShareId(): string | null {
  return (tabCurrent && library.meta(tabCurrent)?.shareId) || null;
}

/**
 * Record `shareId` as the current project's link. A plan that was never
 * saved (blank, untitled) becomes a project first. False if storage refused.
 */
export function attachShareToCurrent(shareId: string, plan: PlanData): boolean {
  let id = tabCurrent;
  if (!id || !library.meta(id)) {
    const made = library.create(plan);
    if (!made.ok) return false;
    id = made.meta.id;
    setCurrentProject(id);
  }
  const ok = library.patch(id, { shareId }).ok;
  libraryChanged();
  return ok;
}
