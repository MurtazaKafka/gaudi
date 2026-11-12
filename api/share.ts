/**
 * POST /api/share
 *   { ownerToken, editorToken?, plan }       create a share → { id, viewId }
 *   { id, ownerToken, plan }                 publish a revision as owner
 *   { id, editorToken, plan }                publish a revision as editor
 *   { id, ownerToken, editorToken }          owner sets (or resets) the edit key
 *   { id, ownerToken, view: true }           owner asks for the view-only link's id → { id, viewId }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  cleanText,
  clientKey,
  ensureViewId,
  newId,
  pickPlan,
  preflight,
  pruneRevisions,
  putJson,
  readEditorHash,
  readMeta,
  sha256,
  takeCreateSlot,
  tokenMatches,
  tsKey,
  validId,
  validPlan,
} from './_lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, ownerToken, editorToken, view, plan: sent } = (req.body ?? {}) as Record<string, unknown>;

  const owner = cleanText(ownerToken, 200);
  const editor = cleanText(editorToken, 200);
  // Only the plan's own fields are ever stored, whatever else the request carried.
  const plan = pickPlan(sent);

  if (id !== undefined) {
    if (!validId(id)) return res.status(400).json({ error: 'bad id' });
    if (!owner && !editor) return res.status(400).json({ error: 'missing ownerToken' });
    const meta = await readMeta(id);
    if (!meta) return res.status(404).json({ error: 'not found' });

    if (owner) {
      if (!tokenMatches(owner, meta.ownerHash)) return res.status(403).json({ error: 'not the owner' });
      // Owner, no plan: the view-only link (links made before it existed get theirs here).
      if (sent === undefined && view === true) {
        return res.status(200).json({ id, viewId: await ensureViewId(id) });
      }
      // Owner + edit key, no plan: (re)set who may edit.
      if (sent === undefined && editor) {
        if (editor === owner) return res.status(400).json({ error: 'bad editorToken' });
        await putJson(`share/${id}/editor.json`, {
          editorHash: sha256(editor),
          at: new Date().toISOString(),
        });
        return res.status(200).json({ id, editor: true });
      }
      if (!validPlan(plan)) return res.status(400).json({ error: 'invalid plan' });
      await putJson(`share/${id}/rev/${tsKey()}.json`, { plan, by: 'owner' });
      await pruneRevisions(id);
      return res.status(200).json({ id });
    }

    // Editor: may publish, nothing else.
    if (!tokenMatches(editor!, await readEditorHash(id, meta))) {
      return res.status(403).json({ error: 'not an editor' });
    }
    if (!validPlan(plan)) return res.status(400).json({ error: 'invalid plan' });
    await putJson(`share/${id}/rev/${tsKey()}.json`, { plan, by: 'editor' });
    await pruneRevisions(id);
    return res.status(200).json({ id });
  }

  // Create a new share
  if (!owner) return res.status(400).json({ error: 'missing ownerToken' });
  if (!validPlan(plan)) return res.status(400).json({ error: 'invalid plan' });
  if (!(await takeCreateSlot(clientKey(req)))) return res.status(429).json({ error: 'slow down' });
  const shareId = newId();
  await putJson(`share/${shareId}/meta.json`, {
    ownerHash: sha256(owner),
    ...(editor && editor !== owner ? { editorHash: sha256(editor) } : {}),
    createdAt: new Date().toISOString(),
  });
  await putJson(`share/${shareId}/rev/${tsKey()}.json`, { plan, by: 'owner' });
  return res.status(200).json({ id: shareId, viewId: await ensureViewId(shareId) });
}
