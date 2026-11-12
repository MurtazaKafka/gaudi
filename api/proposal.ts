/** GET /api/proposal?id=&pid= — one proposal, including its full plan. */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getJson, listPaths, PID_RE, preflight, validId } from './_lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'GET')) return;
  const { id, pid } = req.query;
  if (!validId(id) || typeof pid !== 'string' || !PID_RE.test(pid)) {
    return res.status(400).json({ error: 'bad id' });
  }
  const refs = await listPaths(`share/${id}/proposal/${pid}.json`);
  if (refs.length === 0) return res.status(404).json({ error: 'not found' });
  const p = await getJson<Record<string, unknown>>(refs[0]);
  if (!p) return res.status(404).json({ error: 'not found' });
  return res.status(200).json(p);
}
