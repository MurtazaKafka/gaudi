/**
 * State + orchestration for shared plans.
 *
 * Visitors: `#/p/{id}` loads the plan read-only into a scratch storage key so
 * it never clobbers their own plan. "Propose changes" unlocks editing on that
 * scratch copy; submitting posts it as a draft the owner can accept.
 *
 * Owner: previews proposals by stashing their local plan, loading the
 * proposal read-only, then accepting (keeps it + publishes a revision) or
 * going back (restores the stash).
 */
import { create } from 'zustand';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { importPlanJSON } from '../serialize';
import {
  currentPlanObject,
  fetchProposal,
  fetchShared,
  myShareId,
  publishUpdate,
  resolveProposal,
  submitProposalApi,
  type SharedDoc,
} from './api';

const OWN_STORAGE = 'gaudi-plan-v1';
const SCRATCH_STORAGE = 'gaudi-shared-scratch';

interface ShareState {
  /** Shared plan currently being viewed (visitor mode), else null. */
  viewId: string | null;
  doc: SharedDoc | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  proposing: boolean;
  /** pid of a just-submitted proposal (for the confirmation note). */
  submitted: string | null;
  drawerOpen: boolean;
  /** Owner: proposal being previewed on the canvas. */
  previewPid: string | null;
  stash: unknown | null;
  busy: boolean;
}

export const useShareStore = create<ShareState>(() => ({
  viewId: null,
  doc: null,
  status: 'idle',
  error: null,
  proposing: false,
  submitted: null,
  drawerOpen: false,
  previewPid: null,
  stash: null,
  busy: false,
}));

const set = useShareStore.setState;
const get = useShareStore.getState;

function loadPlanObject(plan: unknown): boolean {
  const r = importPlanJSON(JSON.stringify(plan));
  return r.ok;
}

// ---------- visitor flows ----------

export async function enterSharedView(id: string): Promise<void> {
  if (get().viewId === id && get().status === 'ready') return;
  set({ viewId: id, status: 'loading', error: null, proposing: false, submitted: null });
  try {
    const doc = await fetchShared(id);
    // Redirect persistence to a scratch key so the visitor's own plan survives.
    usePlanStore.persist.setOptions({ name: SCRATCH_STORAGE });
    if (!loadPlanObject(doc.plan)) throw new Error('This shared plan could not be read.');
    const ui = useUiStore.getState();
    ui.setTool('select');
    ui.setPaletteOpen(false);
    ui.setReadOnly(true);
    ui.setMode('plan');
    set({ doc, status: 'ready', drawerOpen: true });
  } catch (e) {
    set({ status: 'error', error: e instanceof Error ? e.message : 'Failed to load.' });
  }
}

export function exitSharedView(clearHash = true): void {
  if (clearHash && location.hash.startsWith('#/p/')) {
    location.hash = '';
    return; // hashchange listener re-enters here with clearHash=false
  }
  usePlanStore.persist.setOptions({ name: OWN_STORAGE });
  void usePlanStore.persist.rehydrate();
  useUiStore.getState().setReadOnly(false);
  set({
    viewId: null,
    doc: null,
    status: 'idle',
    error: null,
    proposing: false,
    submitted: null,
    previewPid: null,
    stash: null,
  });
}

export function startProposing(): void {
  useUiStore.getState().setReadOnly(false);
  set({ proposing: true, submitted: null, drawerOpen: true });
}

export function discardProposal(): void {
  const { doc } = get();
  if (doc) loadPlanObject(doc.plan);
  useUiStore.getState().setReadOnly(true);
  useUiStore.getState().setTool('select');
  set({ proposing: false });
}

export async function sendProposal(author: string, note: string): Promise<void> {
  const { viewId } = get();
  if (!viewId) return;
  set({ busy: true, error: null });
  try {
    const { pid } = await submitProposalApi(viewId, author, note);
    const doc = await fetchShared(viewId);
    loadPlanObject(doc.plan);
    useUiStore.getState().setReadOnly(true);
    useUiStore.getState().setTool('select');
    set({ proposing: false, submitted: pid, doc, busy: false });
  } catch (e) {
    set({ busy: false, error: e instanceof Error ? e.message : 'Failed to submit.' });
  }
}

export async function refreshDoc(): Promise<void> {
  const id = get().viewId ?? myShareId();
  if (!id) return;
  try {
    const doc = await fetchShared(id);
    set({ doc, status: 'ready' });
    // In plain viewing (not mid-proposal), track the latest accepted revision.
    if (get().viewId && !get().proposing) loadPlanObject(doc.plan);
  } catch (e) {
    set({ error: e instanceof Error ? e.message : 'Failed to refresh.' });
  }
}

// ---------- owner flows ----------

export async function ownerPublish(): Promise<void> {
  const id = myShareId();
  if (!id) return;
  set({ busy: true, error: null });
  try {
    await publishUpdate(id);
    const doc = await fetchShared(id);
    set({ doc, busy: false });
  } catch (e) {
    set({ busy: false, error: e instanceof Error ? e.message : 'Failed to publish.' });
  }
}

export async function ownerPreviewProposal(pid: string): Promise<void> {
  const id = myShareId();
  if (!id) return;
  set({ busy: true, error: null });
  try {
    const stash = currentPlanObject();
    const p = await fetchProposal(id, pid);
    if (!loadPlanObject(p.plan)) throw new Error('Proposal could not be read.');
    useUiStore.getState().setReadOnly(true);
    useUiStore.getState().setTool('select');
    set({ previewPid: pid, stash, busy: false });
  } catch (e) {
    set({ busy: false, error: e instanceof Error ? e.message : 'Failed to load proposal.' });
  }
}

export function ownerClosePreview(): void {
  const { stash } = get();
  if (stash) loadPlanObject(stash);
  useUiStore.getState().setReadOnly(false);
  set({ previewPid: null, stash: null });
}

export async function ownerResolve(pid: string, action: 'accept' | 'dismiss'): Promise<void> {
  const id = myShareId();
  if (!id) return;
  set({ busy: true, error: null });
  try {
    await resolveProposal(id, pid, action);
    if (action === 'accept' && get().previewPid === pid) {
      // Keep the proposal as the local plan; drop the stash.
      useUiStore.getState().setReadOnly(false);
      set({ previewPid: null, stash: null });
    }
    const doc = await fetchShared(id);
    set({ doc, busy: false });
  } catch (e) {
    set({ busy: false, error: e instanceof Error ? e.message : 'Failed to resolve.' });
  }
}
