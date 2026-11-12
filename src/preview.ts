/**
 * Try a whole plan on the canvas without committing to it.
 *
 * `beginPreview` stashes the real plan and shows the candidate read-only (in
 * both Plan and Model views); `acceptPreview` makes it the plan as one undoable
 * step; `cancelPreview` puts the original back. While a preview is up the
 * store persists to a scratch key, so a reload can never lose the real plan.
 */
import { create } from 'zustand';
import { applyPlanData, clonePlan, getPlanData } from './plan';
import { pauseHistory, resumeHistory } from './history';
import { usePlanStore } from './store';
import { useUiStore } from './uiStore';
import type { PlanData } from './types';

const PREVIEW_STORAGE = 'gaudi-preview-scratch';

interface PreviewState {
  active: boolean;
  /** Shown in the banner, e.g. "Option B · 3 bed, 142 m²". */
  label: string;
  acceptLabel: string;
  stash: PlanData | null;
  ownStorage: string | null;
  onAccept: (() => void) | null;
  onCancel: (() => void) | null;
}

export const usePreviewStore = create<PreviewState>(() => ({
  active: false,
  label: '',
  acceptLabel: 'Use this plan',
  stash: null,
  ownStorage: null,
  onAccept: null,
  onCancel: null,
}));

export interface PreviewOptions {
  label: string;
  acceptLabel?: string;
  onAccept?: () => void;
  onCancel?: () => void;
}

/** Show `plan` as a preview. Calling it again while one is up just swaps the candidate. */
export function beginPreview(plan: PlanData, opts: PreviewOptions): void {
  const cur = usePreviewStore.getState();
  if (!cur.active) {
    const ownStorage = usePlanStore.persist.getOptions().name ?? 'gaudi-plan-v1';
    const stash = clonePlan(getPlanData());
    pauseHistory();
    usePlanStore.persist.setOptions({ name: PREVIEW_STORAGE });
    usePreviewStore.setState({ active: true, stash, ownStorage });
    const ui = useUiStore.getState();
    ui.setTool('select');
    ui.setPaletteOpen(false);
    ui.setReadOnly(true);
  }
  usePlanStore.getState().setPlan(plan);
  useUiStore.getState().requestFit();
  usePreviewStore.setState({
    label: opts.label,
    acceptLabel: opts.acceptLabel ?? 'Use this plan',
    onAccept: opts.onAccept ?? null,
    onCancel: opts.onCancel ?? null,
  });
}

function end(): { stash: PlanData | null; candidate: PlanData } {
  const { stash, ownStorage } = usePreviewStore.getState();
  const candidate = clonePlan(getPlanData());
  // Restore the real plan (unrecorded) under the real storage key. That write names this tab's project as
  // the working copy's owner (projects/lib.ts), so the plan and its pointer go back as a pair even if
  // another tab opened a different project while the preview was up…
  if (ownStorage) usePlanStore.persist.setOptions({ name: ownStorage });
  if (stash) usePlanStore.getState().setPlan(stash);
  resumeHistory();
  try {
    localStorage.removeItem(PREVIEW_STORAGE);
  } catch {
    /* storage unavailable: nothing was kept there either */
  }
  useUiStore.getState().setReadOnly(false);
  useUiStore.getState().requestFit();
  usePreviewStore.setState({
    active: false,
    label: '',
    stash: null,
    ownStorage: null,
    onAccept: null,
    onCancel: null,
  });
  return { stash, candidate };
}

export function acceptPreview(): void {
  const { active, onAccept } = usePreviewStore.getState();
  if (!active) return;
  const { candidate } = end();
  // …then apply the candidate as a normal, undoable edit.
  applyPlanData(candidate, 'push');
  onAccept?.();
}

export function cancelPreview(): void {
  const { active, onCancel } = usePreviewStore.getState();
  if (!active) return;
  end();
  onCancel?.();
}
