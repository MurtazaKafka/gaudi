/** POST /api/share — create a share (no id) or publish an update (id + ownerToken). */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  newId,
  preflight,
  putJson,
  readMeta,
  sha256,
  tsKey,
  validId,
  validPlan,
  cleanText,
} from './_lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, ownerToken, plan } = (req.body ?? {}) as Record<string, unknown>;

  const token = cleanText(ownerToken, 200);
  if (!token) return res.status(400).json({ error: 'missing ownerToken' });
  if (!validPlan(plan)) return res.status(400).json({ error: 'invalid plan' });

  // Publish an update to an existing share
  if (id !== undefined) {
    if (!validId(id)) return res.status(400).json({ error: 'bad id' });
    const meta = await readMeta(id);
    if (!meta) return res.status(404).json({ error: 'not found' });
    if (meta.ownerHash !== sha256(token)) {
      return res.status(403).json({ error: 'not the owner' });
    }
    await putJson(`share/${id}/rev/${tsKey()}.json`, { plan, by: 'owner' });
    return res.status(200).json({ id });
  }

  // Create a new share
  const shareId = newId();
  await putJson(`share/${shareId}/meta.json`, {
    ownerHash: sha256(token),
    createdAt: new Date().toISOString(),
  });
  await putJson(`share/${shareId}/rev/${tsKey()}.json`, { plan, by: 'owner' });
  return res.status(200).json({ id: shareId });
}
