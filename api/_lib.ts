/**
 * Shared-plan storage + helpers for the API functions.
 *
 * Storage is append-only under `share/{id}/…`:
 *   meta.json            {ownerHash, createdAt}          written once
 *   rev/{ts}.json        {plan, by}                      latest = current plan
 *   comment/{key}.json   {author, text, at}
 *   proposal/{pid}.json  {author, note, plan, at}
 *   status/{pid}.json    {status, at}                    accepted | dismissed
 *
 * Backend: Vercel Blob when BLOB_READ_WRITE_TOKEN is set, otherwise a local
 * directory (.share-dev-store) so the whole flow runs offline in dev.
 */
import { createHash, randomBytes } from 'node:crypto';
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

/** Light structural check; full validation happens client-side on import. */
export function validPlan(plan: unknown): boolean {
  if (typeof plan !== 'object' || plan === null) return false;
  const p = plan as Record<string, unknown>;
  if (!Array.isArray(p.walls) || !Array.isArray(p.furniture)) return false;
  try {
    return JSON.stringify(plan).length < 400_000;
  } catch {
    return false;
  }
}

// ---------- shared doc assembly ----------

export interface Meta {
  ownerHash: string;
  createdAt: string;
}

export async function readMeta(id: string): Promise<Meta | null> {
  const refs = await listPaths(`share/${id}/meta.json`);
  if (refs.length === 0) return null;
  return getJson<Meta>(refs[0]);
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
