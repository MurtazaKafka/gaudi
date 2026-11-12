/**
 * State + orchestration for shared plans.
 *
 * Visitors: `#/p/{id}` loads the plan read-only into a scratch storage key so
 * it never clobbers their own plan. "Propose changes" unlocks editing on that
 * scratch copy; submitting posts it as a draft the owner can accept. An edit
 * link unlocks the same way but publishes directly.
 *
 * Owner: looks at a proposal through `preview.ts` (the real plan is stashed
 * and persisted under its own key the whole time), then accepts it as one
 * undoable step, asks for changes, or dismisses it.
 *
 * Every whole-plan swap here goes through `applyPlanData`: switching between
 * someone else's document and your own is a 'reset' (no undo trail across
 * documents); taking a proposal into your own plan is a 'push' (undoable).
 */
import { create } from 'zustand';
import { emptyPlanData, usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { applyPlanData, clonePlan, getPlanData, normalizePlan } from '../plan';
import { acceptPreview, beginPreview, cancelPreview, usePreviewStore } from '../preview';
import { undo } from '../history';
import { toast, toastError } from '../toast';
import type { PlanData } from '../types';
import {
  editKeyFor,
  editorTokenFor,
  ensureViewId,
  fetchProposal,
  fetchShared,
  myShareId,
  ownerTokenFor,
  publishUpdate,
  rememberEditorToken,
  resolveProposal,
  setEditorKey,
  submitProposalApi,
  type ResolveAction,
  type SharedDoc,
} from './api';
import { parseShareHash, type ShareRole } from './links';
import { resyncCurrentFromStorage } from '../projects/lib';

const OWN_STORAGE = 'gaudi-plan-v1';
const SCRATCH_STORAGE = 'gaudi-shared-scratch';

interface ShareState {
  /** Shared plan currently on the canvas (visitor mode), else null. */
  viewId: string | null;
  /** What this visitor's link lets them do. */
  role: ShareRole;
  doc: SharedDoc | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Visitor has unlocked the scratch copy (a proposal draft, or an editor's edit). */
  proposing: boolean;
  /** pid of a just-submitted proposal (for the confirmation note). */
  submitted: string | null;
  drawerOpen: boolean;
  /** Owner: proposal currently shown through the preview banner. */
  reviewingPid: string | null;
  /** Unused since owner previews moved to preview.ts; kept for session.ts. Always null. */
  previewPid: string | null;
  busy: boolean;
}

export const useShareStore = create<ShareState>(() => ({
  viewId: null,
  role: 'review',
  doc: null,
  status: 'idle',
  error: null,
  proposing: false,
  submitted: null,
  drawerOpen: false,
  reviewingPid: null,
  previewPid: null,
  busy: false,
}));

const set = useShareStore.setState;
const get = useShareStore.getState;

const message = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback;

/** The visitor's own plan as it was when they opened a link (fallback for the way back). */
let ownStash: PlanData | null = null;
/** Bumped whenever the shared view is entered or left, so a slow fetch can tell it is stale. */
let enterSeq = 0;

/** Read the user's own plan straight from its storage key (another tab may have changed it). */
function readOwnPlan(): PlanData | null {
  try {
    const raw = localStorage.getItem(OWN_STORAGE);
    if (!raw) return null;
    const parsed = normalizePlan((JSON.parse(raw) as { state?: unknown }).state);
    return parsed.ok ? parsed.plan : null;
  } catch {
    return null;
  }
}

function dropShareHash(): void {
  if (!location.hash.startsWith('#/p/')) return;
  // replaceState fires no hashchange, so leaving stays one synchronous step.
  history.replaceState(null, '', location.pathname + location.search);
}

function lockCanvas(): void {
  const ui = useUiStore.getState();
  ui.setTool('select');
  ui.setPaletteOpen(false);
  ui.setReadOnly(true);
}

/** Show a fetched shared plan on the (scratch) canvas. A document switch, never an undo step. */
function showShared(doc: SharedDoc): boolean {
  const parsed = normalizePlan(doc.plan);
  if (!parsed.ok) return false;
  applyPlanData(parsed.plan, 'reset');
  return true;
}

// ---------- visitor flows ----------

export async function enterSharedView(id: string): Promise<void> {
  const link = parseShareHash(location.hash);
  const fromLink = link && link.id === id ? link : null;
  if (fromLink?.editorToken) rememberEditorToken(id, fromLink.editorToken);
  const linkRole: ShareRole =
    fromLink?.role === 'view' ? 'view' : editorTokenFor(id) ? 'edit' : 'review';

  if (get().viewId === id && get().status === 'ready') {
    // A view-only id stays view-only, whatever the rest of the link says.
    const role = get().doc?.view ? 'view' : linkRole;
    if (get().role !== role && !get().proposing) set({ role });
    return;
  }

  const seq = ++enterSeq;
  useUiStore.getState().setPanel(null);
  set({ status: 'loading', error: null, drawerOpen: true });
  try {
    const doc = await fetchShared(id);
    if (seq !== enterSeq) return;
    // Validate before anything changes, so a bad plan leaves the user exactly where they were.
    const parsed = normalizePlan(doc.plan);
    if (!parsed.ok) throw new Error('This shared plan could not be read.');

    if (usePreviewStore.getState().active) cancelPreview();
    if (!get().viewId) {
      ownStash = clonePlan(getPlanData());
      // Persist to a scratch key from here on, so the visitor's own plan survives.
      usePlanStore.persist.setOptions({ name: SCRATCH_STORAGE });
    }
    // viewId first: from this point the store no longer holds the user's own plan.
    set({
      viewId: id,
      role: doc.view ? 'view' : linkRole,
      doc,
      status: 'ready',
      error: null,
      proposing: false,
      submitted: null,
      reviewingPid: null,
      drawerOpen: true,
    });
    applyPlanData(parsed.plan, 'reset');
    lockCanvas();
    useUiStore.getState().setMode('plan');
    useUiStore.getState().setPanel(null);
  } catch (e) {
    if (seq !== enterSeq) return;
    // Back on (or still on) the user's own plan, fully editable.
    if (get().viewId) exitSharedView(false);
    const at = ++enterSeq;
    set({ status: 'error', error: message(e, 'This link could not be loaded.') });
    window.setTimeout(() => {
      if (at !== enterSeq || get().status !== 'error') return;
      set({ status: 'idle', error: null });
      dropShareHash();
    }, 6000);
  }
}

export function exitSharedView(clearHash = true): void {
  enterSeq++;
  if (clearHash) dropShareHash();
  if (get().viewId) {
    // A preview started inside the shared view belongs to it; end it first.
    if (usePreviewStore.getState().active) cancelPreview();
    usePlanStore.persist.setOptions({ name: OWN_STORAGE });
    // Still flagged as a shared view while the user's plan goes back in, so nothing treats it as an edit.
    const stored = readOwnPlan();
    // The stored plan may belong to a project another tab opened meanwhile: take its pointer with it.
    if (stored) resyncCurrentFromStorage();
    applyPlanData(stored ?? ownStash ?? emptyPlanData(), 'reset');
    try {
      localStorage.removeItem(SCRATCH_STORAGE);
    } catch {
      /* nothing to do */
    }
    useUiStore.getState().setReadOnly(false);
  }
  ownStash = null;
  set({
    viewId: null,
    role: 'review',
    doc: null,
    status: 'idle',
    error: null,
    proposing: false,
    submitted: null,
    reviewingPid: null,
    busy: false,
  });
}

/** Unlock the scratch copy: a proposal draft for reviewers, a direct edit for editors. */
export function startProposing(): void {
  const { viewId, role } = get();
  if (!viewId || role === 'view') return;
  useUiStore.getState().setReadOnly(false);
  set({ proposing: true, submitted: null, error: null, drawerOpen: true });
}

/** Start a new draft from one of the link's proposals (to answer "needs changes"). */
export async function reviseProposal(pid: string): Promise<void> {
  const { viewId, role } = get();
  if (!viewId || role === 'view') return;
  set({ busy: true, error: null });
  try {
    const p = await fetchProposal(viewId, pid);
    const parsed = normalizePlan(p.plan);
    if (!parsed.ok) throw new Error('That proposal could not be read.');
    if (get().viewId !== viewId) return;
    applyPlanData(parsed.plan, 'reset');
    useUiStore.getState().setReadOnly(false);
    set({ proposing: true, submitted: null, busy: false, drawerOpen: true });
  } catch (e) {
    set({ busy: false, error: message(e, 'That proposal could not be loaded.') });
  }
}

export function discardProposal(): void {
  const { doc, viewId } = get();
  if (!viewId) return;
  if (doc) showShared(doc);
  lockCanvas();
  set({ proposing: false, error: null });
}

export async function sendProposal(author: string, note: string): Promise<void> {
  const { viewId, role, proposing, busy } = get();
  if (!viewId || role === 'view' || !proposing || busy) return;
  set({ busy: true, error: null });
  try {
    const { pid } = await submitProposalApi(viewId, author, note);
    rememberMyProposal(viewId, pid);
    const doc = await fetchShared(viewId).catch(() => get().doc);
    if (get().viewId !== viewId) return;
    if (doc) showShared(doc);
    lockCanvas();
    set({ proposing: false, submitted: pid, doc, busy: false });
  } catch (e) {
    set({ busy: false, error: message(e, 'The proposal could not be sent.') });
  }
}

/** Editor: publish the unlocked scratch copy as the link's new revision. */
export async function publishAsEditor(): Promise<void> {
  const { viewId, role, proposing, busy } = get();
  if (!viewId || role !== 'edit' || !proposing || busy) return;
  set({ busy: true, error: null });
  try {
    await publishUpdate(viewId);
    const doc = await fetchShared(viewId).catch(() => get().doc);
    if (get().viewId !== viewId) return;
    if (doc) showShared(doc);
    lockCanvas();
    set({ proposing: false, doc, busy: false });
    toast('Published to the link.');
  } catch (e) {
    set({ busy: false, error: message(e, 'Could not publish.') });
  }
}

export async function refreshDoc(): Promise<void> {
  const target = () => get().viewId ?? myShareId();
  const id = target();
  if (!id) return;
  try {
    const doc = await fetchShared(id);
    if (target() !== id) return; // left the link, or switched project, meanwhile
    const before = get().doc?.updatedAt;
    set({ doc, status: 'ready', error: null });
    // In plain viewing (not mid-draft), follow the latest published revision.
    if (get().viewId && !get().proposing && before !== doc.updatedAt) showShared(doc);
  } catch (e) {
    if (target() === id) set({ error: message(e, 'Could not refresh.') });
  }
}

// ---- which proposals this browser sent (so "needs changes" can find its author) ----

const MINE_KEY = (id: string) => `gaudi-share-sent-${id}`;

export function myProposals(id: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MINE_KEY(id)) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function rememberMyProposal(id: string, pid: string): void {
  try {
    localStorage.setItem(MINE_KEY(id), JSON.stringify([...myProposals(id), pid].slice(-50)));
  } catch {
    /* not essential */
  }
}

// ---------- owner flows ----------

/** A different project is on the canvas: its link's doc is not this one. */
export function clearShareDoc(): void {
  if (get().viewId) return;
  set({ doc: null, error: null, submitted: null, reviewingPid: null, busy: false });
}

export async function ownerPublish(): Promise<void> {
  const id = myShareId();
  // Never while a preview is up: the canvas is a candidate, not the owner's plan.
  if (!id || get().viewId || usePreviewStore.getState().active) return;
  set({ busy: true, error: null });
  try {
    await publishUpdate(id);
    const doc = await fetchShared(id).catch(() => null);
    if (myShareId() === id && doc) set({ doc });
    set({ busy: false });
    toast('Published to the link.');
  } catch (e) {
    set({ busy: false, error: message(e, 'Could not publish.') });
  }
}

/** One key change per link at a time: two racing resets would leave this browser holding the losing secret. */
const keyChanges = new Map<string, Promise<boolean>>();

/** Make sure this link has an edit secret (links made before edit links existed have none). */
export function ownerEnsureEditorKey(reset = false): Promise<boolean> {
  const id = myShareId();
  if (!id || !ownerTokenFor(id)) return Promise.resolve(false);
  const running = keyChanges.get(id);
  if (running) return running;
  if (editKeyFor(id) && !reset) return Promise.resolve(true);
  const job = setEditorKey(id)
    .then(() => true)
    .catch((e: unknown) => {
      if (reset) toastError(message(e, 'Could not reset the edit link.'));
      return false;
    })
    .finally(() => keyChanges.delete(id));
  keyChanges.set(id, job);
  return job;
}

/** Make sure this link has its view-only id (links made before view ids get one here). */
export function ownerEnsureViewId(): Promise<boolean> {
  const id = myShareId();
  if (!id) return Promise.resolve(false);
  return ensureViewId(id).then(
    () => true,
    () => false,
  );
}

let reviewAccept: (() => void) | null = null;

/** Tell the link a proposal's outcome; local state is already right. */
async function settle(id: string, pid: string, action: ResolveAction, note = ''): Promise<boolean> {
  try {
    await resolveProposal(id, pid, action, note);
    const doc = await fetchShared(id).catch(() => null);
    if (doc && !get().viewId && myShareId() === id) set({ doc });
    return true;
  } catch (e) {
    const text = message(e, 'Could not update the link.');
    if (!get().viewId && myShareId() === id) set({ error: text });
    else toastError(text);
    return false;
  }
}

/** Show a proposal on the canvas. The owner's plan stays safe under its own key (preview.ts). */
export async function ownerPreviewProposal(pid: string): Promise<void> {
  const id = myShareId();
  if (!id || get().viewId) return;
  set({ busy: true, error: null });
  try {
    const p = await fetchProposal(id, pid);
    const parsed = normalizePlan(p.plan);
    if (!parsed.ok) throw new Error('That proposal could not be read.');
    if (myShareId() !== id || get().viewId) {
      set({ busy: false });
      return;
    }
    const onAccept = () => {
      set({ reviewingPid: null });
      void settle(id, pid, 'accept').then((ok) => {
        if (!ok) toastError('Your plan has the changes, but the link does not yet. Publish to update it.');
      });
    };
    reviewAccept = onAccept;
    beginPreview(parsed.plan, {
      label: `Proposal from ${p.author}`,
      acceptLabel: 'Accept',
      onAccept,
      onCancel: () => set({ reviewingPid: null }),
    });
    // After beginPreview: the watcher below clears this whenever the preview is not ours.
    set({ reviewingPid: pid, busy: false });
  } catch (e) {
    set({ busy: false, error: message(e, 'That proposal could not be loaded.') });
  }
}

// If something else takes over the preview (a generated option), we are no longer reviewing.
const unwatchPreview = usePreviewStore.subscribe((s) => {
  if (get().reviewingPid && (!s.active || s.onAccept !== reviewAccept)) set({ reviewingPid: null });
});
if (import.meta.hot) import.meta.hot.dispose(unwatchPreview);

export async function ownerResolve(pid: string, action: ResolveAction, note = ''): Promise<void> {
  const id = myShareId();
  if (!id || get().viewId) return;

  // Accepting the proposal that is on the canvas is the banner's Accept.
  if (action === 'accept' && get().reviewingPid === pid && usePreviewStore.getState().active) {
    acceptPreview();
    return;
  }

  set({ busy: true, error: null });
  try {
    let accepted: PlanData | null = null;
    if (action === 'accept') {
      // Read it first: accepting must bring the proposal into the local plan too,
      // or the next publish would silently undo it.
      const p = await fetchProposal(id, pid);
      const parsed = normalizePlan(p.plan);
      if (!parsed.ok) throw new Error('That proposal could not be read.');
      accepted = parsed.plan;
    }
    await resolveProposal(id, pid, action, note);
    if (get().reviewingPid === pid) cancelPreview();

    if (accepted && myShareId() === id && !get().viewId) {
      if (usePreviewStore.getState().active) cancelPreview();
      applyPlanData(accepted, 'push', true);
      toast('Proposal accepted.', {
        action: { label: 'Undo', run: () => void (!useUiStore.getState().readOnly && undo()) },
      });
    }
    const doc = await fetchShared(id).catch(() => null);
    if (doc && myShareId() === id && !get().viewId) set({ doc });
    set({ busy: false });
  } catch (e) {
    set({ busy: false, error: message(e, 'Could not update the proposal.') });
  }
}
