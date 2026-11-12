/**
 * Share links are capabilities: what a link can do is written in the link.
 *
 *   #/p/{id}                 review — view, comment, propose
 *   #/p/{viewId}/view        view only — same plan, nothing to type into
 *   #/p/{id}/edit/{secret}   edit — may publish revisions directly
 *
 * The view-only link carries an id of its own, which the server answers with the
 * plan and nothing else: taking "/view" off it does not turn it into a review
 * link. (View links made before that carry the share's id, and still open.)
 *
 * Pure (no DOM), so it can be tested on its own.
 */
export type ShareRole = 'view' | 'review' | 'edit';

export interface ShareLink {
  id: string;
  role: ShareRole;
  /** Present on edit links only. */
  editorToken?: string;
}

const LINK_RE = /^#\/p\/([A-Za-z0-9]{6,20})(?:\/(?:(view)|edit\/([A-Za-z0-9-]{16,80})))?\/?$/;

export function parseShareHash(hash: string): ShareLink | null {
  const m = LINK_RE.exec(hash);
  if (!m) return null;
  if (m[3]) return { id: m[1], role: 'edit', editorToken: m[3] };
  return { id: m[1], role: m[2] ? 'view' : 'review' };
}

export function shareHash(link: ShareLink): string {
  if (link.role === 'view') return `#/p/${link.id}/view`;
  if (link.role === 'edit' && link.editorToken) return `#/p/${link.id}/edit/${link.editorToken}`;
  return `#/p/${link.id}`;
}
