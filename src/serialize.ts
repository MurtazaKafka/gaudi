import { applyPlanData, getPlanData, normalizePlan } from './plan';
import type { PlanData } from './types';

/** On-disk / on-the-wire shape. Version 1 files (no name, customItems, look) still load. */
export interface PlanFile extends PlanData {
  app: 'gaudi';
  version: 2;
}

export function planToFile(plan: PlanData): PlanFile {
  return { app: 'gaudi', version: 2, ...plan };
}

export function exportPlanJSON(): string {
  return JSON.stringify(planToFile(getPlanData()), null, 2);
}

export function downloadBlob(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse + validate a plan file. Touches nothing. */
export function parsePlanJSON(text: string): { ok: true; plan: PlanData } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  return normalizePlan(raw);
}

/**
 * Parse + validate a plan file; replaces the plan on the canvas on success —
 * the current project's content. To open a file as a document of its own,
 * use `openPlanFile` (projects/projectStore.ts).
 * `history`: 'push' makes the import undoable (default), 'reset' starts a
 * fresh history (a different document), 'skip' records nothing.
 */
export function importPlanJSON(
  text: string,
  history: 'push' | 'reset' | 'skip' = 'push',
): { ok: true } | { ok: false; error: string } {
  const result = parsePlanJSON(text);
  if (!result.ok) return result;
  applyPlanData(result.plan, history);
  return { ok: true };
}
