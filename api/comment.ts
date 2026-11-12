/**
 * POST /api/comment
 *   { id, author, text }              anyone with the link can comment
 *   { id, ownerToken, clear: true }   the owner removes every comment
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  cleanText,
  deletePaths,
  findShare,
  isOwner,
  listPaths,
  MAX_COMMENTS,
  newId,
  preflight,
  putJson,
  tsKey,
  validId,
} from './_lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, author, text, ownerToken, clear } = (req.body ?? {}) as Record<string, unknown>;
  if (!validId(id)) return res.status(400).json({ error: 'bad id' });

  if (clear === true) {
    const share = await findShare(id);
    if (!share || share.viewOnly) return res.status(404).json({ error: 'not found' });
    if (!isOwner(ownerToken, share.meta)) return res.status(403).json({ error: 'not the owner' });
    const refs = await listPaths(`share/${id}/comment/`);
    await deletePaths(refs);
    return res.status(200).json({ ok: true, cleared: refs.length });
  }

  const a = cleanText(author, 40);
  const t = cleanText(text, 1000);
  if (!a || !t) return res.status(400).json({ error: 'author and text required' });

  const share = await findShare(id);
  if (!share) return res.status(404).json({ error: 'not found' });
  if (share.viewOnly) return res.status(403).json({ error: 'view only' });
  if ((await listPaths(`share/${id}/comment/`)).length >= MAX_COMMENTS) {
    return res.status(429).json({ error: 'too many' });
  }

  await putJson(`share/${id}/comment/${tsKey()}-${newId(4)}.json`, {
    author: a,
    text: t,
    at: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true });
}
