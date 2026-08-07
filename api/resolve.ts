/** POST /api/resolve — owner accepts or dismisses a proposal. Accept = new revision. */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  cleanText,
  getJson,
  listPaths,
  preflight,
  putJson,
  readMeta,
  sha256,
  tsKey,
  validId,
} from './_lib.js';

const PID_RE = /^[A-Za-z0-9-]{6,40}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, pid, action, ownerToken } = (req.body ?? {}) as Record<string, unknown>;
  if (!validId(id) || typeof pid !== 'string' || !PID_RE.test(pid)) {
    return res.status(400).json({ error: 'bad id' });
  }
  if (action !== 'accept' && action !== 'dismiss') {
    return res.status(400).json({ error: 'bad action' });
  }
  const token = cleanText(ownerToken, 200);
  if (!token) return res.status(400).json({ error: 'missing ownerToken' });

  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (meta.ownerHash !== sha256(token)) return res.status(403).json({ error: 'not the owner' });

  if (action === 'accept') {
    const refs = await listPaths(`share/${id}/proposal/${pid}.json`);
    const proposal = refs.length ? await getJson<{ plan: unknown }>(refs[0]) : null;
    if (!proposal) return res.status(404).json({ error: 'proposal not found' });
    await putJson(`share/${id}/rev/${tsKey()}.json`, { plan: proposal.plan, by: pid });
  }
  await putJson(`share/${id}/status/${pid}.json`, {
    status: action === 'accept' ? 'accepted' : 'dismissed',
    at: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true });
}
