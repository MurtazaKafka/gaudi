/** Client for the share API. Owner credentials live only in this browser. */
import { exportPlanJSON } from '../serialize';

const API_BASE =
  (import.meta.env.VITE_SHARE_API_BASE as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:5177' : '');

export interface SharedComment {
  author: string;
  text: string;
  at: string;
}

export interface ProposalMeta {
  pid: string;
  author: string;
  note: string;
  at: string;
  items: number;
  status: 'open' | 'accepted' | 'dismissed';
}

export interface SharedDoc {
  plan: unknown;
  updatedAt: string;
  comments: SharedComment[];
  proposals: ProposalMeta[];
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API_BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

/** The current plan as a plain object (same shape as the JSON export). */
export function currentPlanObject(): unknown {
  return JSON.parse(exportPlanJSON());
}

// ---- owner bookkeeping (localStorage only) ----

export const myShareId = (): string | null => localStorage.getItem('gaudi-share-id');
export const ownerTokenFor = (id: string): string | null =>
  localStorage.getItem(`gaudi-share-owner-${id}`);

export function shareUrl(id: string): string {
  return `${location.origin}${location.pathname}#/p/${id}`;
}

// ---- calls ----

export async function createShare(): Promise<string> {
  const ownerToken = crypto.randomUUID();
  const { id } = await call<{ id: string }>('/api/share', {
    ownerToken,
    plan: currentPlanObject(),
  });
  localStorage.setItem('gaudi-share-id', id);
  localStorage.setItem(`gaudi-share-owner-${id}`, ownerToken);
  return id;
}

export async function publishUpdate(id: string): Promise<void> {
  const ownerToken = ownerTokenFor(id);
  if (!ownerToken) throw new Error('No owner key for this share in this browser.');
  await call('/api/share', { id, ownerToken, plan: currentPlanObject() });
}

export const fetchShared = (id: string): Promise<SharedDoc> =>
  call<SharedDoc>(`/api/shared?id=${encodeURIComponent(id)}`);

export const postComment = (id: string, author: string, text: string): Promise<unknown> =>
  call('/api/comment', { id, author, text });

export const submitProposalApi = (
  id: string,
  author: string,
  note: string,
): Promise<{ pid: string }> =>
  call<{ pid: string }>('/api/propose', { id, author, note, plan: currentPlanObject() });

export const fetchProposal = (id: string, pid: string): Promise<{ plan: unknown; author: string }> =>
  call(`/api/proposal?id=${encodeURIComponent(id)}&pid=${encodeURIComponent(pid)}`);

export async function resolveProposal(
  id: string,
  pid: string,
  action: 'accept' | 'dismiss',
): Promise<void> {
  const ownerToken = ownerTokenFor(id);
  if (!ownerToken) throw new Error('No owner key for this share in this browser.');
  await call('/api/resolve', { id, pid, action, ownerToken });
}
