/** Client for the share API. Owner and editor keys live only in this browser. */
import { getPlanData } from '../plan';
import { planToFile } from '../serialize';
import { attachShareToCurrent, currentShareId } from '../projects/lib';
import { shareHash, type ShareRole } from './links';

const API_BASE =
  (import.meta.env.VITE_SHARE_API_BASE as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:5177' : '');

export interface SharedComment {
  author: string;
  text: string;
  at: string;
}

/** 'changes' = the owner asked for changes (see `reviewNote`). */
export type ProposalStatus = 'open' | 'accepted' | 'dismissed' | 'changes';

export interface ProposalMeta {
  pid: string;
  author: string;
  note: string;
  at: string;
  items: number;
  status: ProposalStatus;
  /** The owner's note when status is 'changes'. */
  reviewNote?: string;
}

export interface SharedDoc {
  plan: unknown;
  updatedAt: string;
  comments: SharedComment[];
  proposals: ProposalMeta[];
  /** The server's word that this link only views: it was asked by a view-only id. */
  view?: boolean;
}

/** A refusal from the sharing service; `code` is the service's own word for it. */
class ShareError extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined, status: number) {
    super(friendly(code, status));
    this.code = code;
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(API_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the sharing service.');
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ShareError(j.error, r.status);
  return j as T;
}

function friendly(error: string | undefined, status: number): string {
  switch (error) {
    case 'not found':
      return 'This link does not exist.';
    case 'not the owner':
      return 'This browser does not hold the key for this link.';
    case 'not an editor':
      return 'This edit link no longer works. Ask the owner for a new one.';
    case 'invalid plan':
      return 'This plan is too large to share.';
    case 'too many':
      return 'This link is full. Ask the owner to clear it.';
    case 'view only':
      return 'This link is view-only.';
    case 'slow down':
      return 'Too many links were made from this network in the last hour. Try again later.';
    default:
      return error ? `Sharing failed: ${error}.` : `Sharing failed (${status}).`;
  }
}

/** The current plan as a plain object (same shape as the JSON export). */
export function currentPlanObject(): unknown {
  return JSON.parse(JSON.stringify(planToFile(getPlanData())));
}

// ---- keys (localStorage only) ----

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or disabled: the key lives for this tab only */
  }
}

/** The link of the project on the canvas — every project has its own. */
export const myShareId = (): string | null => currentShareId();

export const ownerTokenFor = (id: string): string | null => read(`gaudi-share-owner-${id}`);

/** Owner's copy of a link's edit secret, kept so the edit link can be copied again. */
export const editKeyFor = (id: string): string | null => read(`gaudi-share-editkey-${id}`);

/** The id of a link's view-only twin, as the owner's browser was told it. */
export const viewIdFor = (id: string): string | null => read(`gaudi-share-view-${id}`);

/** An edit secret this browser received in an edit link (a visitor's key, never the owner's copy). */
export const editorTokenFor = (id: string): string | null => read(`gaudi-share-editor-${id}`);

/**
 * Edit secrets that arrived in a link while this browser already held a different one for
 * the same share. Anyone can write a link, so the newcomer is unproven: it is tried first
 * on the next publish and kept only if the service accepts it.
 */
const arrivedEditorTokens = new Map<string, string>();

export function rememberEditorToken(id: string, token: string): void {
  const held = editorTokenFor(id);
  if (held && held !== token) arrivedEditorTokens.set(id, token);
  else write(`gaudi-share-editor-${id}`, token);
}

/** The link for a role. For view-only links use `viewUrl`: they are built from a different id. */
export function shareUrl(id: string, role: ShareRole = 'review'): string {
  const editorToken = role === 'edit' ? editKeyFor(id) ?? undefined : undefined;
  return `${location.origin}${location.pathname}${location.search}${shareHash({ id, role, editorToken })}`;
}

/** The view-only link: built from the share's view id, never from the id that can comment. */
export function viewUrl(id: string): string | null {
  const viewId = viewIdFor(id);
  return viewId ? shareUrl(viewId, 'view') : null;
}

const newSecret = (): string => crypto.randomUUID();

/** Clipboard write that reports failure instead of throwing. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---- calls ----

/** Publish the current plan at a new link and make it this project's link. */
export async function createShare(): Promise<string> {
  const ownerToken = newSecret();
  const editorToken = newSecret();
  const { id, viewId } = await call<{ id: string; viewId?: string }>('/api/share', {
    ownerToken,
    editorToken,
    plan: currentPlanObject(),
  });
  write(`gaudi-share-owner-${id}`, ownerToken);
  write(`gaudi-share-editkey-${id}`, editorToken);
  if (viewId) write(`gaudi-share-view-${id}`, viewId);
  if (!attachShareToCurrent(id, getPlanData())) {
    throw new Error('The link was made, but this browser is out of storage and cannot remember it.');
  }
  return id;
}

/** Give a link a (new) edit secret. Any edit link handed out before stops working. */
export async function setEditorKey(id: string): Promise<void> {
  const ownerToken = ownerTokenFor(id);
  if (!ownerToken) throw new Error('This browser does not hold the key for this link.');
  const editorToken = newSecret();
  await call('/api/share', { id, ownerToken, editorToken });
  write(`gaudi-share-editkey-${id}`, editorToken);
}

/** Learn a link's view-only id (the service makes one for links older than view ids). Owner only. */
export async function ensureViewId(id: string): Promise<string> {
  const held = viewIdFor(id);
  if (held) return held;
  const ownerToken = ownerTokenFor(id);
  if (!ownerToken) throw new Error('This browser does not hold the key for this link.');
  const { viewId } = await call<{ viewId: string }>('/api/share', { id, ownerToken, view: true });
  write(`gaudi-share-view-${id}`, viewId);
  return viewId;
}

/** Publish the plan on the canvas as the link's new revision — as owner, else as editor. */
export async function publishUpdate(id: string): Promise<void> {
  const ownerToken = ownerTokenFor(id);
  const plan = currentPlanObject();
  if (ownerToken) {
    await call('/api/share', { id, ownerToken, plan });
    return;
  }
  const held = editorTokenFor(id);
  const arrived = arrivedEditorTokens.get(id);
  if (arrived) {
    try {
      await call('/api/share', { id, editorToken: arrived, plan });
      // Proven: this is the share's edit key now (the owner reset it and sent a new link).
      write(`gaudi-share-editor-${id}`, arrived);
      arrivedEditorTokens.delete(id);
      return;
    } catch (e) {
      if (!(e instanceof ShareError) || e.code !== 'not an editor') throw e;
      arrivedEditorTokens.delete(id); // not a key at all: fall back to the one held before
    }
  }
  if (held) await call('/api/share', { id, editorToken: held, plan });
  else throw new Error('This browser does not hold the key for this link.');
}

export const fetchShared = (id: string): Promise<SharedDoc> =>
  call<SharedDoc>(`/api/shared?id=${encodeURIComponent(id)}`);

export const postComment = (id: string, author: string, text: string): Promise<unknown> =>
  call('/api/comment', { id, author, text });

/** Remove every comment on a link. Owner only. */
export async function clearComments(id: string): Promise<void> {
  const ownerToken = ownerTokenFor(id);
  if (!ownerToken) throw new Error('This browser does not hold the key for this link.');
  await call('/api/comment', { id, ownerToken, clear: true });
}

export const submitProposalApi = (
  id: string,
  author: string,
  note: string,
): Promise<{ pid: string }> =>
  call<{ pid: string }>('/api/propose', { id, author, note, plan: currentPlanObject() });

export const fetchProposal = (
  id: string,
  pid: string,
): Promise<{ plan: unknown; author: string; note?: string }> =>
  call(`/api/proposal?id=${encodeURIComponent(id)}&pid=${encodeURIComponent(pid)}`);

export type ResolveAction = 'accept' | 'dismiss' | 'changes';

export async function resolveProposal(
  id: string,
  pid: string,
  action: ResolveAction,
  note = '',
): Promise<void> {
  const ownerToken = ownerTokenFor(id);
  if (!ownerToken) throw new Error('This browser does not hold the key for this link.');
  await call('/api/resolve', { id, pid, action, ownerToken, ...(note ? { note } : {}) });
}
