/**
 * Shared-plan storage + helpers for the API functions.
 *
 * Storage under `share/{id}/…`:
 *   meta.json            {ownerHash, editorHash?, createdAt}   written once
 *   editor.json          {editorHash, at}                      owner (re)sets the edit key
 *   view.json            {viewId}                              the id of the view-only link
 *   rev/{ts}.json        {plan, by}                            latest = current plan; only the newest few are kept
 *   comment/{key}.json   {author, text, at}
 *   proposal/{pid}.json  {author, note, plan, at}              removed once accepted or dismissed
 *   summary/{pid}.json   {author, note, at, items}             the proposal without its plan
 *   status/{pid}.json    {status, note?, at}                   accepted | dismissed | changes
 * and beside it:
 *   view/{viewId}.json   {id}                                  a view-only link's id → the share it shows
 *   rate/{who}/{hour}-…  {}                                    one per link made, for the hourly limit
 *
 * Keys are capabilities: the owner key and the edit key are secrets made in
 * the browser; only their SHA-256 is ever stored here. The share id lets its
 * holder read everything, comment and propose; the view id only reads the plan.
 *
 * Backend: Vercel Blob when BLOB_READ_WRITE_TOKEN is set, otherwise a local
 * directory (.share-dev-store) so the whole flow runs offline in dev.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const hasBlobToken = () => !!process.env.BLOB_READ_WRITE_TOKEN;

export async function putJson(pathname: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data);
  if (hasBlobToken()) {
    const { put } = await import('@vercel/blob');
    await put(pathname, body, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } else {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const p = join(process.cwd(), '.share-dev-store', pathname);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
}

export interface BlobRef {
  pathname: string;
  url?: string;
}

export async function deletePaths(refs: BlobRef[]): Promise<void> {
  if (refs.length === 0) return;
  if (hasBlobToken()) {
    const { del } = await import('@vercel/blob');
    // by URL when the listing gave one; a pathname works too
    await del(refs.map((r) => r.url ?? r.pathname));
  } else {
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await Promise.all(refs.map((r) => rm(join(process.cwd(), '.share-dev-store', r.pathname), { force: true })));
  }
}

export async function listPaths(prefix: string): Promise<BlobRef[]> {
  if (hasBlobToken()) {
    const { list } = await import('@vercel/blob');
    const out: BlobRef[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, cursor });
      out.push(...r.blobs.map((b) => ({ pathname: b.pathname, url: b.url })));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
  }
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = join(process.cwd(), '.share-dev-store');
  const acc: BlobRef[] = [];
  async function walk(rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childRel);
      else acc.push({ pathname: childRel });
    }
  }
  await walk('');
  return acc
    .filter((b) => b.pathname.startsWith(prefix))
    .sort((a, b) => a.pathname.localeCompare(b.pathname));
}

export async function getJson<T>(ref: BlobRef): Promise<T | null> {
  try {
    if (hasBlobToken()) {
      if (!ref.url) return null;
      const r = await fetch(`${ref.url}?ts=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()) as T;
    }
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(process.cwd(), '.share-dev-store', ref.pathname), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------- request/response helpers ----------

export function applyCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/** Standard preamble: CORS + OPTIONS + method check. Returns false if handled. */
export function preflight(
  req: VercelRequest,
  res: VercelResponse,
  method: 'GET' | 'POST',
): boolean {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return false;
  }
  if (req.method !== method) {
    res.status(405).json({ error: 'method not allowed' });
    return false;
  }
  return true;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Does `token` hash to `hash`? Constant-time. */
export function tokenMatches(token: string, hash: string | null | undefined): boolean {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const newId = (len = 10): string =>
  randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, len);

export const tsKey = (): string => String(Date.now()).padStart(14, '0');

// ---------- validation ----------

const ID_RE = /^[A-Za-z0-9]{6,20}$/;

export function validId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

/** Most a stored plan may weigh, as JSON. Custom furniture models are the bulk of a big plan. */
export const MAX_PLAN_CHARS = 400_000;

/** How many of each a stored plan may hold — the same ceilings the app opens (PLAN_LIMITS in src/plan.ts). */
export const PLAN_LIMITS = { walls: 2000, openings: 2000, furniture: 2000 } as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The fields of a plan (PlanData in src/types.ts). Nothing else a request carries is stored. */
const PLAN_KEYS = ['name', 'walls', 'openings', 'furniture', 'roomNames', 'settings', 'customItems', 'look'] as const;

/** The plan to store: a copy holding only the plan's own fields. Check it with `validPlan`. */
export function pickPlan(plan: unknown): unknown {
  if (!isRecord(plan)) return plan;
  const out: Record<string, unknown> = {};
  for (const key of PLAN_KEYS) if (Object.hasOwn(plan, key) && plan[key] !== undefined) out[key] = plan[key];
  return out;
}

/**
 * Light structural check; full validation happens client-side on import
 * (normalizePlan). Everything beyond walls and furniture is optional, so
 * older clients' plans and newer fields (name, customItems, look,
 * settings.units) all pass — but a field that is present must have its shape.
 */
export function validPlan(plan: unknown): boolean {
  if (!isRecord(plan)) return false;
  if (!Array.isArray(plan.walls) || !Array.isArray(plan.furniture)) return false;
  if (plan.openings !== undefined && !Array.isArray(plan.openings)) return false;
  if (plan.walls.length > PLAN_LIMITS.walls || plan.furniture.length > PLAN_LIMITS.furniture) return false;
  if (Array.isArray(plan.openings) && plan.openings.length > PLAN_LIMITS.openings) return false;
  if (plan.name !== undefined && typeof plan.name !== 'string') return false;
  for (const key of ['roomNames', 'settings', 'customItems', 'look']) {
    if (plan[key] !== undefined && !isRecord(plan[key])) return false;
  }
  try {
    return JSON.stringify(plan).length < MAX_PLAN_CHARS;
  } catch {
    return false;
  }
}

export const PID_RE = /^[A-Za-z0-9-]{6,40}$/;

/**
 * Bounds on what anyone holding a link can pile onto it. Neither is for good: the owner can
 * clear the comments, and a proposal stops counting once the owner has answered it.
 */
export const MAX_COMMENTS = 500;
/** Proposals waiting for the owner's first answer. */
export const MAX_PROPOSALS = 60;
/** Revisions kept per share; the newest is the plan, the rest are only a short safety net. */
export const KEEP_REVISIONS = 5;
/** New links one network may make per hour. */
export const MAX_CREATES_PER_HOUR = 60;

export const pidOf = (pathname: string): string => pathname.split('/').pop()!.replace('.json', '');

/** The owner's key from a request body, checked against the share. */
export function isOwner(ownerToken: unknown, meta: Meta): boolean {
  const token = cleanText(ownerToken, 200);
  return !!token && tokenMatches(token, meta.ownerHash);
}

// ---------- create limit ----------

/** Who is asking, as far as the platform says: one IPv4 address, or one IPv6 /64. */
export function clientKey(req: VercelRequest): string {
  const header = (name: string): string => {
    const v = req.headers?.[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };
  // Vercel sets both headers itself (a client cannot forge them there); a bare node server has only the socket.
  let ip = header('x-real-ip').trim() || header('x-forwarded-for').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (ip.includes('.')) ip = ip.slice(ip.lastIndexOf(':') + 1); // ::ffff:1.2.3.4
  else if (ip.includes(':')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    ip = groups.slice(0, 4).join(':').toLowerCase();
  }
  return sha256(ip).slice(0, 20);
}

/**
 * Count one more link for `who` this hour; false when the hour's allowance is used up.
 * A count and then a write, not a lock: requests arriving in the same instant can each
 * slip in, so a burst may overshoot by its own width. It stops one address looping; it
 * does nothing against many addresses.
 */
export async function takeCreateSlot(who: string, now = Date.now()): Promise<boolean> {
  const hour = Math.floor(now / 3_600_000);
  const prefix = `rate/${who}/`;
  const refs = await listPaths(prefix);
  const current = refs.filter((r) => r.pathname.startsWith(`${prefix}${hour}-`));
  const stale = refs.filter((r) => !r.pathname.startsWith(`${prefix}${hour}-`));
  if (stale.length) await deletePaths(stale).catch(() => {});
  if (current.length >= MAX_CREATES_PER_HOUR) return false;
  await putJson(`${prefix}${hour}-${tsKey()}-${newId(6)}.json`, {});
  return true;
}

// ---------- shared doc assembly ----------

export interface Meta {
  ownerHash: string;
  /** Hash of the edit key the share was created with, if any. */
  editorHash?: string;
  createdAt: string;
}

/** The current edit key's hash: the owner's latest reset, else the one from creation. */
export async function readEditorHash(id: string, meta: Meta): Promise<string | null> {
  const refs = await listPaths(`share/${id}/editor.json`);
  if (refs.length === 0) return meta.editorHash ?? null;
  // The key has been reset, so the one from creation is revoked. If the reset cannot be
  // read right now, nobody is an editor for this request — never the revoked key again.
  const reset = await getJson<{ editorHash?: unknown }>(refs[0]);
  return typeof reset?.editorHash === 'string' ? reset.editorHash : null;
}

export async function readMeta(id: string): Promise<Meta | null> {
  const refs = await listPaths(`share/${id}/meta.json`);
  if (refs.length === 0) return null;
  return getJson<Meta>(refs[0]);
}

/** A share, found by its own id or by the id of its view-only link. */
export interface FoundShare {
  /** Always the share's own id — never hand this to a `viewOnly` caller. */
  id: string;
  meta: Meta;
  /** Addressed by the view id: may read the plan and nothing else. */
  viewOnly: boolean;
}

export async function findShare(id: string): Promise<FoundShare | null> {
  const meta = await readMeta(id);
  if (meta) return { id, meta, viewOnly: false };
  const refs = await listPaths(`view/${id}.json`);
  const pointer = refs.length ? await getJson<{ id?: unknown }>(refs[0]) : null;
  if (!pointer || !validId(pointer.id)) return null;
  const shown = await readMeta(pointer.id);
  return shown ? { id: pointer.id, meta: shown, viewOnly: true } : null;
}

/** The id of a share's view-only link, minted the first time it is asked for. Owner only — callers check. */
export async function ensureViewId(id: string): Promise<string> {
  const refs = await listPaths(`share/${id}/view.json`);
  const held = refs.length ? await getJson<{ viewId?: unknown }>(refs[0]) : null;
  if (held && validId(held.viewId)) return held.viewId;
  const viewId = newId();
  // pointer first: a view id is never handed out before it resolves
  await putJson(`view/${viewId}.json`, { id });
  await putJson(`share/${id}/view.json`, { viewId });
  return viewId;
}

/** Drop all but the newest revisions. Never fails the request that called it. */
export async function pruneRevisions(id: string): Promise<void> {
  try {
    const refs = await listPaths(`share/${id}/rev/`);
    await deletePaths(refs.slice(0, Math.max(0, refs.length - KEEP_REVISIONS)));
  } catch {
    /* the next publish tries again */
  }
}

export async function latestRevision(
  id: string,
): Promise<{ plan: unknown; at: string } | null> {
  const refs = await listPaths(`share/${id}/rev/`);
  if (refs.length === 0) return null;
  const last = refs[refs.length - 1];
  const rev = await getJson<{ plan: unknown }>(last);
  if (!rev) return null;
  const ts = Number(last.pathname.split('/').pop()!.replace('.json', ''));
  return { plan: rev.plan, at: new Date(ts).toISOString() };
}
