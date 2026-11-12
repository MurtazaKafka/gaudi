/**
 * Furnish every room of the current plan in one go.
 *
 * Rooms that already hold furniture are left alone. Unnamed rooms are named
 * first (one cheap call over the whole plan), then a few rooms are furnished
 * at a time. Everything — names and furniture — lands as ONE undo step, and
 * nothing lands at all if the run is aborted or the plan changes under it.
 */
import { AiError, askJson, ensureApiKey, isAbort } from './client';
import { ROOM_NAMES_SCHEMA, buildRoomNamesPrompt, readRoomNames, type Placement } from './furnishCore';
import { analyzeRooms, furnitureInRoom } from './planGeom';
import { suggestFurniture } from '../aiFurnish';
import { useAiStore } from '../aiStore';
import { transact } from '../history';
import { getPlanData } from '../plan';
import { PLAN_KEYS, usePlanStore } from '../store';
import { useUiStore } from '../uiStore';

export interface FurnishAllResult {
  /** pieces added across all rooms */
  placed: number;
  /** rooms that got at least one piece */
  rooms: number;
  /** rooms that failed or were skipped */
  failed: number;
}

/** Rooms smaller than this (m²) are shafts and wall pockets, not rooms. */
const MIN_AREA = 1.2;
const CONCURRENCY = 3;

export async function furnishWholePlan(
  signal?: AbortSignal,
  /** Called as rooms finish: (done, total). */
  onProgress?: (done: number, total: number) => void,
): Promise<FurnishAllResult> {
  if (useUiStore.getState().readOnly) throw new Error('This plan is view-only.');
  if (!(await ensureApiKey())) throw new AiError('no-key', 'Add your Anthropic API key to use AI features.');
  const aborted = () => new AiError('aborted', 'Cancelled.');
  if (signal?.aborted) throw aborted();

  const plan = getPlanData();
  const rooms = analyzeRooms(plan.walls, plan.roomNames);
  const todo = rooms.filter(
    (r) => r.room.area >= MIN_AREA && furnitureInRoom(plan.furniture, r.room).length === 0,
  );
  if (todo.length === 0) return { placed: 0, rooms: 0, failed: 0 };

  // 1 — what is each unnamed room?
  let names = new Map<number, string>();
  if (todo.some((r) => !r.name)) {
    try {
      const reply = await askJson<unknown>({
        tag: 'room-names',
        prompt: buildRoomNamesPrompt(plan, rooms),
        schema: ROOM_NAMES_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 4000,
        effort: 'low',
        signal,
      });
      names = readRoomNames(reply, rooms);
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw aborted();
      // Without names the unnamed rooms are skipped below; named ones still get furnished.
      if (todo.every((r) => !r.name)) throw e;
    }
  }

  // 2 — furnish, a few rooms at a time.
  const note = useAiStore.getState().note;
  const results = new Map<number, Placement[]>();
  let failed = 0;
  let done = 0;
  let firstError: unknown = null;
  const queue = [...todo];
  onProgress?.(0, todo.length);

  const worker = async (): Promise<void> => {
    for (;;) {
      const room = queue.shift();
      if (!room) return;
      if (signal?.aborted) throw aborted();
      const nameHint = room.name ?? names.get(room.index);
      if (!nameHint) {
        failed++;
      } else {
        try {
          const res = await suggestFurniture({ plan, rooms, room, nameHint, note }, signal);
          if (res.items.length) results.set(room.index, res.items);
        } catch (e) {
          if (isAbort(e) || signal?.aborted) throw aborted();
          firstError ??= e;
          failed++;
        }
      }
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  if (signal?.aborted) throw aborted();
  // Every call failed the same way (bad key, offline): say so instead of "0 rooms".
  if (results.size === 0 && firstError) throw firstError;

  // 3 — commit, but only onto the plan the suggestions were made for.
  const now = getPlanData();
  if (useUiStore.getState().readOnly || !PLAN_KEYS.every((k) => now[k] === plan[k])) {
    throw new Error('The plan changed while Gaudí was working — nothing was added.');
  }
  const items = [...results.values()].flat();
  const renames = [...names].filter(([i]) => !rooms[i].name);
  if (items.length === 0) return { placed: 0, rooms: 0, failed };

  transact(() => {
    const store = usePlanStore.getState();
    for (const [i, name] of renames) store.setRoomName(rooms[i].room.key, name);
    store.addFurnitureBatch(items);
  });
  return { placed: items.length, rooms: results.size, failed };
}
