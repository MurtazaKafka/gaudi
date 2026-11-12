/**
 * The project library: named copies of plans kept in localStorage.
 *
 * Pure — no store, no DOM. Everything goes through an injected `StorageLike`
 * so it can be tested with a fake (and survive a browser that refuses writes).
 *
 * Layout:
 *   gaudi-projects-v1        { version, projects: ProjectMeta[] }   the list
 *   gaudi-project-{id}       { v, meta, plan }                      one per project
 *   gaudi-project-current    id of the project a tab last made current. A hint only: the working
 *                            plan (gaudi-plan-v1) names its own project, see lib.ts
 *
 * Each record carries its own copy of the meta, so a lost or corrupt index is
 * rebuilt from the records. Every read validates; a broken entry is skipped,
 * never thrown. Every write reports failure (quota) instead of throwing.
 */
import { detectRooms } from '../rooms';
import type { PlanData } from '../types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export const INDEX_KEY = 'gaudi-projects-v1';
export const RECORD_PREFIX = 'gaudi-project-';
export const CURRENT_KEY = 'gaudi-project-current';
/** Before projects existed there was one share id per browser. */
export const LEGACY_SHARE_KEY = 'gaudi-share-id';
export const BLANK_NAME = 'Untitled plan';

export interface ProjectMeta {
  id: string;
  name: string;
  /** epoch ms */ createdAt: number;
  /** epoch ms */ updatedAt: number;
  /** m², sum of detected rooms */ area: number;
  rooms: number;
  /** This project's own share link, if it has one. */
  shareId?: string;
  /** Share id this project was remixed from. */
  remixedFrom?: string;
  /** Name of the plan it was remixed from, for the card. */
  remixedName?: string;
  /** Starter template it was made from. */
  template?: string;
}

export interface ProjectRecord {
  meta: ProjectMeta;
  plan: PlanData;
}

export type NormalizeFn = (raw: unknown) => { ok: true; plan: PlanData } | { ok: false; error: string };

export interface LibraryDeps {
  /** Validates anything plan-shaped (plan.ts normalizePlan). */
  normalize: NormalizeFn;
  now?: () => number;
  newId?: () => string;
}

export type SaveResult =
  | { ok: true; meta: ProjectMeta }
  | { ok: false; reason: 'quota' | 'missing' };

/** Fields a caller may set when creating or patching a project. */
export type MetaPatch = Partial<
  Pick<ProjectMeta, 'id' | 'createdAt' | 'shareId' | 'remixedFrom' | 'remixedName' | 'template'>
>;

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const SHARE_ID_RE = /^[A-Za-z0-9]{6,20}$/;

export const isProjectId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

export const isShareId = (v: unknown): v is string => typeof v === 'string' && SHARE_ID_RE.test(v);

/** Nothing drawn and never named — not worth keeping. */
export function isBlankPlan(plan: PlanData): boolean {
  return (
    plan.walls.length === 0 &&
    plan.openings.length === 0 &&
    plan.furniture.length === 0 &&
    Object.keys(plan.customItems).length === 0 &&
    plan.name === BLANK_NAME
  );
}

export function measurePlan(plan: Pick<PlanData, 'walls'>): { area: number; rooms: number } {
  const rooms = detectRooms(plan.walls);
  const area = rooms.reduce((s, r) => s + r.area, 0);
  return { area: Math.round(area * 100) / 100, rooms: rooms.length };
}

/** Newest first; ties broken by creation time, then id, so the order is stable. */
export function sortProjects(list: ProjectMeta[]): ProjectMeta[] {
  return list
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** "Kitchen", "Kitchen 2", "Kitchen 3" — the first that is not taken. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const clean = base.trim().slice(0, 76) || BLANK_NAME;
  if (!used.has(clean.toLowerCase())) return clean;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${clean} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return clean;
}

export function cleanName(name: unknown): string {
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : BLANK_NAME;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now" · "5 min ago" · "3 h ago" · "yesterday" · "4 d ago" · "12 Mar" · "12 Mar 2024" */
export function relativeTime(then: number, now: number): string {
  const s = Math.max(0, now - then) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  const d = new Date(then);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

type Raw = Record<string, unknown>;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate one index/record meta. Returns null when it cannot be trusted. */
export function cleanMeta(raw: unknown): ProjectMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Raw;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return null;
  const updatedAt = finite(m.updatedAt) && m.updatedAt > 0 ? m.updatedAt : 0;
  const createdAt = finite(m.createdAt) && m.createdAt > 0 ? m.createdAt : updatedAt;
  const meta: ProjectMeta = {
    id: m.id,
    name: cleanName(m.name),
    createdAt,
    updatedAt,
    area: finite(m.area) && m.area >= 0 ? m.area : 0,
    rooms: finite(m.rooms) && m.rooms >= 0 ? Math.floor(m.rooms) : 0,
  };
  if (isShareId(m.shareId)) meta.shareId = m.shareId;
  if (isShareId(m.remixedFrom)) meta.remixedFrom = m.remixedFrom;
  if (typeof m.remixedName === 'string' && m.remixedName.trim()) meta.remixedName = cleanName(m.remixedName);
  if (typeof m.template === 'string' && m.template) meta.template = m.template.slice(0, 40);
  return meta;
}

function parse(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface Library {
  /** Every readable project, newest first. */
  list(): ProjectMeta[];
  meta(id: string): ProjectMeta | null;
  /** The project with its plan, validated. Null if missing or unreadable. */
  record(id: string): ProjectRecord | null;
  /** Add a project. `extra.id` reuses an id (restoring a project that was dropped). */
  create(plan: PlanData, extra?: MetaPatch): SaveResult;
  /** Write a new version of a project's plan (creates it if it is gone). */
  save(id: string, plan: PlanData): SaveResult;
  /** Change bookkeeping fields without touching the plan. `undefined` clears a field. */
  patch(id: string, patch: MetaPatch): SaveResult;
  rename(id: string, name: string): SaveResult;
  duplicate(id: string): SaveResult;
  /** Delete. Returns what was removed so it can be put back. */
  remove(id: string): ProjectRecord | null;
  /** Put a removed project back exactly as it was. */
  restore(record: ProjectRecord): SaveResult;
  /** Which project the working plan belongs to. */
  current(): string | null;
  setCurrent(id: string | null): void;
  /** Drop list entries whose record is missing or unreadable. Returns the dropped ids. */
  prune(): string[];
  /** Move the old one-per-browser share id onto `projectId`. Returns the id that moved. */
  adoptLegacyShare(projectId: string): string | null;
  dropLegacyShare(): void;
}

export function createLibrary(storage: StorageLike, deps: LibraryDeps): Library {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const recordKey = (id: string) => RECORD_PREFIX + id;

  const get = (key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const put = (key: string, value: string): boolean => {
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      return false; // quota, private mode, storage disabled
    }
  };
  const del = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  };

  function readRecord(id: string): ProjectRecord | null {
    const raw = parse(get(recordKey(id)));
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Raw;
    const result = deps.normalize(r.plan);
    if (!result.ok) return null;
    const meta = cleanMeta({ ...(r.meta as Raw | undefined), id }) ?? {
      id,
      name: result.plan.name,
      createdAt: 0,
      updatedAt: 0,
      area: 0,
      rooms: 0,
    };
    // The plan is the truth for anything derived from it.
    return { meta: { ...meta, name: result.plan.name, ...measurePlan(result.plan) }, plan: result.plan };
  }

  /** The list was lost or mangled: recover it from the records themselves. */
  function rebuild(): ProjectMeta[] {
    const out: ProjectMeta[] = [];
    let n: number;
    try {
      n = storage.length ?? 0;
    } catch {
      n = 0;
    }
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      let key: string | null;
      try {
        key = storage.key?.(i) ?? null;
      } catch {
        key = null;
      }
      if (!key || !key.startsWith(RECORD_PREFIX) || key === CURRENT_KEY) continue;
      const id = key.slice(RECORD_PREFIX.length);
      if (ID_RE.test(id)) ids.push(id);
    }
    for (const id of ids) {
      const rec = readRecord(id);
      if (rec) out.push(rec.meta);
    }
    return out;
  }

  function readIndex(): ProjectMeta[] {
    const raw = parse(get(INDEX_KEY));
    const listRaw =
      typeof raw === 'object' && raw !== null && Array.isArray((raw as Raw).projects)
        ? ((raw as Raw).projects as unknown[])
        : null;
    if (!listRaw) {
      const recovered = rebuild();
      if (recovered.length) writeIndex(recovered);
      return sortProjects(recovered);
    }
    const seen = new Set<string>();
    const out: ProjectMeta[] = [];
    for (const item of listRaw) {
      const meta = cleanMeta(item);
      if (!meta || seen.has(meta.id)) continue;
      seen.add(meta.id);
      out.push(meta);
    }
    return sortProjects(out);
  }

  function writeIndex(projects: ProjectMeta[]): boolean {
    return put(INDEX_KEY, JSON.stringify({ version: 1, projects: sortProjects(projects) }));
  }

  /** Record first, list second: a failed write never leaves the list pointing at nothing. */
  function write(meta: ProjectMeta, plan: PlanData, isNew: boolean): SaveResult {
    const full: ProjectMeta = { ...meta, name: cleanName(plan.name), ...measurePlan(plan) };
    if (!put(recordKey(full.id), JSON.stringify({ v: 1, meta: full, plan }))) {
      return { ok: false, reason: 'quota' };
    }
    const projects = readIndex().filter((p) => p.id !== full.id);
    projects.push(full);
    if (!writeIndex(projects)) {
      if (isNew) del(recordKey(full.id));
      return { ok: false, reason: 'quota' };
    }
    return { ok: true, meta: full };
  }

  const lib: Library = {
    list: readIndex,

    meta(id) {
      return readIndex().find((p) => p.id === id) ?? null;
    },

    record(id) {
      if (!ID_RE.test(id)) return null;
      const rec = readRecord(id);
      if (!rec) return null;
      // Bookkeeping lives in the list; the record's copy is the fallback.
      const listed = readIndex().find((p) => p.id === id);
      return listed ? { meta: { ...listed, name: rec.meta.name }, plan: rec.plan } : rec;
    },

    create(plan, extra = {}) {
      const t = now();
      const id = extra.id && ID_RE.test(extra.id) ? extra.id : newId();
      const meta: ProjectMeta = {
        id,
        name: cleanName(plan.name),
        createdAt: extra.createdAt ?? t,
        updatedAt: t,
        area: 0,
        rooms: 0,
      };
      if (isShareId(extra.shareId)) meta.shareId = extra.shareId;
      if (isShareId(extra.remixedFrom)) meta.remixedFrom = extra.remixedFrom;
      if (extra.remixedName) meta.remixedName = cleanName(extra.remixedName);
      if (extra.template) meta.template = extra.template;
      return write(meta, plan, true);
    },

    save(id, plan) {
      if (!ID_RE.test(id)) return { ok: false, reason: 'missing' };
      const existing = readIndex().find((p) => p.id === id) ?? readRecord(id)?.meta;
      const t = now();
      const meta: ProjectMeta = existing
        ? { ...existing, updatedAt: t }
        : { id, name: cleanName(plan.name), createdAt: t, updatedAt: t, area: 0, rooms: 0 };
      return write(meta, plan, !existing);
    },

    patch(id, patch) {
      const rec = lib.record(id);
      if (!rec) return { ok: false, reason: 'missing' };
      const meta: ProjectMeta = { ...rec.meta };
      for (const key of ['shareId', 'remixedFrom', 'remixedName', 'template'] as const) {
        if (!(key in patch)) continue;
        const v = patch[key];
        if (v === undefined) delete meta[key];
        else meta[key] = v;
      }
      const checked = cleanMeta(meta);
      if (!checked) return { ok: false, reason: 'missing' };
      return write(checked, rec.plan, false);
    },

    rename(id, name) {
      const rec = lib.record(id);
      if (!rec) return { ok: false, reason: 'missing' };
      const next = cleanName(name);
      if (next === rec.plan.name) return { ok: true, meta: rec.meta };
      // A new name is not new work: the project keeps its place in the list.
      return write(rec.meta, { ...rec.plan, name: next }, false);
    },

    duplicate(id) {
      const rec = lib.record(id);
      if (!rec) return { ok: false, reason: 'missing' };
      const name = uniqueName(`${rec.plan.name} copy`, readIndex().map((p) => p.name));
      // A copy is its own project: no share link, no lineage.
      return lib.create({ ...rec.plan, name });
    },

    remove(id) {
      if (!ID_RE.test(id)) return null;
      const rec = lib.record(id);
      const projects = readIndex();
      if (projects.some((p) => p.id === id)) writeIndex(projects.filter((p) => p.id !== id));
      del(recordKey(id));
      if (lib.current() === id) lib.setCurrent(null);
      return rec;
    },

    restore(record) {
      const meta = cleanMeta(record.meta);
      if (!meta) return { ok: false, reason: 'missing' };
      return write(meta, record.plan, true);
    },

    current() {
      const id = get(CURRENT_KEY);
      return id && ID_RE.test(id) ? id : null;
    },

    setCurrent(id) {
      if (id) put(CURRENT_KEY, id);
      else del(CURRENT_KEY);
    },

    prune() {
      const projects = readIndex();
      const dropped: string[] = [];
      const kept: ProjectMeta[] = [];
      for (const p of projects) {
        if (readRecord(p.id)) kept.push(p);
        else dropped.push(p.id);
      }
      if (dropped.length) writeIndex(kept);
      return dropped;
    },

    adoptLegacyShare(projectId) {
      const legacy = get(LEGACY_SHARE_KEY);
      if (legacy === null) return null;
      if (!isShareId(legacy)) {
        del(LEGACY_SHARE_KEY);
        return null;
      }
      const meta = lib.meta(projectId);
      if (!meta) return null; // keep it for the next attempt
      if (meta.shareId) {
        del(LEGACY_SHARE_KEY);
        return null;
      }
      const res = lib.patch(projectId, { shareId: legacy });
      if (!res.ok) return null;
      del(LEGACY_SHARE_KEY);
      return legacy;
    },

    dropLegacyShare() {
      del(LEGACY_SHARE_KEY);
    },
  };

  return lib;
}
