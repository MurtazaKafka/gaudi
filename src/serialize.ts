import { defaultSettings, usePlanStore } from './store';
import { FURNITURE } from './catalog';
import type { Furniture, Opening, PlanSettings, Point, Wall } from './types';

interface PlanFile {
  app: 'gaudi';
  version: 1;
  walls: Wall[];
  openings: Opening[];
  furniture?: Furniture[];
  roomNames: Record<string, string>;
  settings: PlanSettings;
}

export function exportPlanJSON(): string {
  const { walls, openings, furniture, roomNames, settings } = usePlanStore.getState();
  const file: PlanFile = {
    app: 'gaudi',
    version: 1,
    walls,
    openings,
    furniture,
    roomNames,
    settings,
  };
  return JSON.stringify(file, null, 2);
}

export function downloadBlob(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function isPoint(p: unknown): p is Point {
  return (
    typeof p === 'object' &&
    p !== null &&
    Number.isFinite((p as Point).x) &&
    Number.isFinite((p as Point).y)
  );
}

/** Parse + validate a plan file; replaces the store on success. */
export function importPlanJSON(text: string): { ok: true } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Not a plan file.' };
  const f = raw as Partial<PlanFile>;
  if (!Array.isArray(f.walls)) return { ok: false, error: 'Missing walls array.' };

  const walls: Wall[] = [];
  for (const w of f.walls) {
    if (!isPoint(w?.a) || !isPoint(w?.b)) return { ok: false, error: 'Malformed wall.' };
    walls.push({
      id: typeof w.id === 'string' ? w.id : crypto.randomUUID(),
      a: { x: w.a.x, y: w.a.y },
      b: { x: w.b.x, y: w.b.y },
    });
  }

  const wallIds = new Set(walls.map((w) => w.id));
  const openings: Opening[] = [];
  for (const o of Array.isArray(f.openings) ? f.openings : []) {
    if (
      !wallIds.has(o?.wallId) ||
      (o.type !== 'door' && o.type !== 'window') ||
      !Number.isFinite(o.offset) ||
      !Number.isFinite(o.width)
    )
      continue; // drop bad openings rather than failing the import
    openings.push({
      id: typeof o.id === 'string' ? o.id : crypto.randomUUID(),
      wallId: o.wallId,
      type: o.type,
      offset: o.offset,
      width: o.width,
    });
  }

  const furniture: Furniture[] = [];
  for (const fu of Array.isArray(f.furniture) ? f.furniture : []) {
    if (
      !(fu?.kind in FURNITURE) ||
      !Number.isFinite(fu.x) ||
      !Number.isFinite(fu.y) ||
      !Number.isFinite(fu.rotation)
    )
      continue;
    furniture.push({
      id: typeof fu.id === 'string' ? fu.id : crypto.randomUUID(),
      kind: fu.kind,
      x: fu.x,
      y: fu.y,
      rotation: fu.rotation,
    });
  }

  const s = f.settings;
  const settings: PlanSettings = {
    wallHeight: Number.isFinite(s?.wallHeight) ? s!.wallHeight : defaultSettings.wallHeight,
    wallThickness: Number.isFinite(s?.wallThickness)
      ? s!.wallThickness
      : defaultSettings.wallThickness,
    gridSize: Number.isFinite(s?.gridSize) ? s!.gridSize : defaultSettings.gridSize,
  };

  const roomNames: Record<string, string> = {};
  if (typeof f.roomNames === 'object' && f.roomNames !== null) {
    for (const [k, v] of Object.entries(f.roomNames)) {
      if (typeof v === 'string') roomNames[k] = v;
    }
  }

  usePlanStore.setState({ walls, openings, furniture, roomNames, settings });
  return { ok: true };
}
