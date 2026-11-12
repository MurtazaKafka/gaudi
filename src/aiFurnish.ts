/**
 * Furnish one room with Claude: ask → ghost preview → accept / retry / discard.
 *
 * One run at a time. Each run has its own AbortController and run id; a reply
 * that does not belong to the current run is ignored, and the whole state is
 * dropped when the plan under it changes hands (shared view, preview, import)
 * or the room goes away.
 */
import { aiErrorMessage, askJson, ensureApiKey, isAbort } from './ai/client';
import {
  FURNISH_SYSTEM,
  buildFurnishPrompt,
  furnishSchema,
  planKinds,
  validatePlacements,
  type FurnishContext,
  type FurnishResult,
  type RawPlacement,
} from './ai/furnishCore';
import { analyzeRooms, furnitureInRoom } from './ai/planGeom';
import { useAiStore } from './aiStore';
import { transact, undo } from './history';
import { getPlanData } from './plan';
import { detectRooms } from './rooms';
import { usePlanStore } from './store';
import { toast } from './toast';
import { useUiStore } from './uiStore';
import type { PlanData } from './types';

export type SuggestResult = FurnishResult;

/** One Claude call for one room. Throws AiError on failure / abort. */
export async function suggestFurniture(ctx: FurnishContext, signal?: AbortSignal): Promise<FurnishResult> {
  const reply = await askJson<{ items: RawPlacement[] }>({
    tag: 'furnish',
    system: FURNISH_SYSTEM,
    prompt: buildFurnishPrompt(ctx),
    schema: furnishSchema(planKinds(ctx.plan)),
    maxTokens: 16000,
    effort: 'medium',
    signal,
  });
  return validatePlacements(reply && typeof reply === 'object' ? reply.items : null, ctx);
}

/** Build the furnishing context for a room of `plan`, or null if the room is not there. */
export function furnishContext(
  plan: PlanData,
  roomKey: string,
  opts: { note?: string; replace?: boolean; nameHint?: string } = {},
): FurnishContext | null {
  const rooms = analyzeRooms(plan.walls, plan.roomNames);
  const room = rooms.find((r) => r.room.key === roomKey);
  return room ? { plan, rooms, room, ...opts } : null;
}

let controller: AbortController | null = null;

/** Stop whatever is running and forget any suggestion on screen. */
export function cancelFurnish(): void {
  controller?.abort();
  controller = null;
  if (useAiStore.getState().status !== 'idle') useAiStore.getState().clear();
}

/**
 * Suggest furniture for a room and show it as ghosts. `replace` furnishes the
 * room from scratch; accepting then swaps out what is there.
 */
export async function runFurnish(roomKey: string, opts: { replace?: boolean } = {}): Promise<void> {
  if (useUiStore.getState().readOnly) return;
  if (!(await ensureApiKey())) return;
  if (useUiStore.getState().readOnly) return;

  controller?.abort();
  const mine = new AbortController();
  controller = mine;

  const ai = useAiStore.getState();
  const ctx = furnishContext(getPlanData(), roomKey, { note: ai.note, replace: !!opts.replace });
  if (!ctx) {
    cancelFurnish();
    return;
  }
  const runId = ai.start(roomKey, !!opts.replace);
  try {
    const result = await suggestFurniture(ctx, mine.signal);
    if (mine.signal.aborted) return;
    if (result.items.length === 0) {
      useAiStore
        .getState()
        .fail(
          runId,
          result.dropped > 0
            ? 'Nothing proposed fits this room — try again.'
            : 'Nothing to add here.',
        );
    } else {
      useAiStore.getState().succeed(runId, result.items, result.dropped);
    }
  } catch (e) {
    if (isAbort(e) || mine.signal.aborted) return;
    useAiStore.getState().fail(runId, aiErrorMessage(e));
  } finally {
    if (controller === mine) controller = null;
  }
}

/** Put the previewed suggestion into the plan — one undo step, even when it replaces furniture. */
export function acceptFurnish(): void {
  const ai = useAiStore.getState();
  if (ai.status !== 'preview' || !ai.roomKey) return;
  if (useUiStore.getState().readOnly) {
    cancelFurnish();
    return;
  }
  const plan = getPlanData();
  const room = detectRooms(plan.walls).find((r) => r.key === ai.roomKey);
  const items = ai.items;
  const replace = ai.replace;
  cancelFurnish();
  if (!room || items.length === 0) return;

  transact(() => {
    const store = usePlanStore.getState();
    if (replace) {
      const old = furnitureInRoom(plan.furniture, room).map((f) => f.id);
      if (old.length) store.deleteFurniture(old);
    }
    store.addFurnitureBatch(items);
  });
  useUiStore.getState().setRoomSelection(null);
  toast(`${items.length} piece${items.length === 1 ? '' : 's'} added.`, { action: { label: 'Undo', run: () => void (!useUiStore.getState().readOnly && undo()) } });
}

// A suggestion only makes sense on the plan it was made for.
usePlanStore.subscribe((s, prev) => {
  const ai = useAiStore.getState();
  if (ai.status === 'idle') return;
  const swapped =
    s.walls !== prev.walls && s.openings !== prev.openings && s.furniture !== prev.furniture && s.settings !== prev.settings;
  if (swapped || (s.walls !== prev.walls && !detectRooms(s.walls).some((r) => r.key === ai.roomKey))) {
    cancelFurnish();
  }
});
useUiStore.subscribe((s, prev) => {
  // The room panel (accept / discard) only exists under the select tool: no orphan ghosts.
  if ((s.readOnly && !prev.readOnly) || (s.tool !== prev.tool && s.tool !== 'select')) cancelFurnish();
});
