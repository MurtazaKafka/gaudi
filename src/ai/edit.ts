/**
 * "Ask Gaudí": change the current plan from one line of text.
 *
 * The plan is described to Claude (describe.ts), it answers with operations
 * (ops.ts), they are applied to a copy, validated, and committed as a single
 * undo step.
 */
import { AiError, askJson } from './client';
import { describePlan, type Selection } from './describe';
import { OPS_GUIDE, applyOps, editSchema, type ApplyResult, type EditReply } from './ops';
import { applyPlanData, getPlanData, normalizePlan } from '../plan';
import { transact, undo } from '../history';
import { detectRooms } from '../rooms';
import { PLAN_KEYS } from '../store';
import { toast } from '../toast';
import { useUiStore } from '../uiStore';
import type { PlanData } from '../types';

const SYSTEM = `You are the editing hand inside Gaudí, a calm floor-plan drafting tool. The user has a plan on the canvas, may have selected something on it, and typed one short request. You reply with the operations that carry it out.

How to work:
- Read the plan description carefully and work out which walls, rooms, openings or pieces the request is about. "this", "it", "here" refer to the user's selection.
- Do what was asked and nothing more. Keep every room closed. Prefer the smallest set of operations.
- Compass words mean the plan's axes: north is up (-y), south is down (+y), east is right (+x), west is left (-x).
- To change a room's size, move the wall on the side that should grow or shrink. "1 m wider" with nothing else said: move one side wall outward, preferring an exterior wall so neighbouring rooms keep their size.
- Furniture goes where a person would put it: against walls where natural, clear of doors, not overlapping.
- If the request is unclear but has an obvious reading, take it. If it cannot be done with the operations available, reply with a single "cannot" operation that says why in one plain sentence.
- summary: one short sentence, past tense, plain words, in the user's units, no ids (say "the kitchen's east wall", not "W4").`;

export interface EditOutcome {
  status: 'done' | 'nothing' | 'cannot';
  /** what to tell the user */
  message: string;
  applied: number;
  dropped: number;
}

function currentSelection(): Selection {
  const ui = useUiStore.getState();
  return {
    wallIds: ui.selectedWallIds,
    openingIds: ui.selectedOpeningIds,
    furnitureIds: ui.selectedFurnitureIds,
    roomKey: ui.selectedRoomKey,
  };
}

const samePlan = (a: PlanData, b: PlanData): boolean => PLAN_KEYS.every((k) => a[k] === b[k]);

const sentence = (s: string): string => {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const cut = t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
};

/** Drop selections that point at things the edit removed. */
function pruneSelection(plan: PlanData): void {
  const ui = useUiStore.getState();
  if (ui.selectedWallIds.length) {
    const kept = ui.selectedWallIds.filter((id) => plan.walls.some((w) => w.id === id));
    if (kept.length !== ui.selectedWallIds.length) ui.setSelection(kept);
  } else if (ui.selectedOpeningIds.length) {
    const kept = ui.selectedOpeningIds.filter((id) => plan.openings.some((o) => o.id === id));
    if (kept.length !== ui.selectedOpeningIds.length) ui.setOpeningSelection(kept);
  } else if (ui.selectedFurnitureIds.length) {
    const kept = ui.selectedFurnitureIds.filter((id) => plan.furniture.some((f) => f.id === id));
    if (kept.length !== ui.selectedFurnitureIds.length) ui.setFurnitureSelection(kept);
  } else if (ui.selectedRoomKey) {
    if (!detectRooms(plan.walls).some((r) => r.key === ui.selectedRoomKey)) ui.setRoomSelection(null);
  }
}

/** Commit an applied result to the store as one undo step. Returns what to tell the user. */
export function commitEdit(result: ApplyResult, summary: string): EditOutcome {
  const dropped = result.dropped.length;
  if (result.applied === 0) {
    if (result.cannot.length) {
      return { status: 'cannot', message: sentence(result.cannot[0]), applied: 0, dropped };
    }
    if (dropped) {
      return {
        status: 'nothing',
        message: sentence(`Couldn't do that — ${result.dropped[0].reason}`),
        applied: 0,
        dropped,
      };
    }
    return { status: 'nothing', message: sentence(summary) || 'Nothing to change.', applied: 0, dropped: 0 };
  }

  const checked = normalizePlan(result.plan);
  if (!checked.ok) {
    return { status: 'nothing', message: "Couldn't do that — the result was not a valid plan.", applied: 0, dropped };
  }
  transact(() => applyPlanData(checked.plan, 'push'));
  pruneSelection(checked.plan);

  let message = sentence(summary) || 'Done.';
  if (dropped) message += ` ${dropped} step${dropped === 1 ? '' : 's'} skipped.`;
  if (result.cannot.length) message += ` ${sentence(result.cannot[0])}`;
  toast(message, { action: { label: 'Undo', run: () => void (!useUiStore.getState().readOnly && undo()) } });
  return { status: 'done', message, applied: result.applied, dropped };
}

/**
 * Ask Claude to carry out `request` on the current plan.
 * Throws AiError (see client.ts) if the call fails or is aborted.
 */
export async function askEdit(request: string, signal?: AbortSignal): Promise<EditOutcome> {
  if (useUiStore.getState().readOnly) {
    return { status: 'nothing', message: 'This plan is view-only.', applied: 0, dropped: 0 };
  }
  const plan = getPlanData();
  const desc = describePlan(plan, currentSelection());

  const reply = await askJson<EditReply>({
    tag: 'edit',
    system: SYSTEM,
    prompt: `${desc.text}\n\n${OPS_GUIDE}\n\nREQUEST: ${request.trim()}`,
    schema: editSchema(desc.kinds),
    maxTokens: 16000,
    effort: 'medium',
    signal,
  });

  // Stopped while the reply was on its way: it must not land.
  if (signal?.aborted) throw new AiError('aborted', 'Cancelled.');
  // The canvas is not locked while Claude thinks: never apply to a plan it did not see.
  if (useUiStore.getState().readOnly || !samePlan(plan, getPlanData())) {
    return {
      status: 'nothing',
      message: 'The plan changed while Gaudí was working — ask again.',
      applied: 0,
      dropped: 0,
    };
  }

  const ops = reply && typeof reply === 'object' ? (reply as Partial<EditReply>).operations : null;
  const summary = reply && typeof reply === 'object' && typeof reply.summary === 'string' ? reply.summary : '';
  return commitEdit(applyOps(plan, ops, desc.refs), summary);
}
