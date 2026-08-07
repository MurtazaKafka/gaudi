/** POST /api/propose — submit a modified plan as a draft ("pull request"). */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cleanText, newId, preflight, putJson, readMeta, validId, validPlan } from './_lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, author, note, plan } = (req.body ?? {}) as Record<string, unknown>;
  if (!validId(id)) return res.status(400).json({ error: 'bad id' });

  const a = cleanText(author, 40);
  const n = cleanText(note, 500) ?? '';
  if (!a) return res.status(400).json({ error: 'author required' });
  if (!validPlan(plan)) return res.status(400).json({ error: 'invalid plan' });

  if (!(await readMeta(id))) return res.status(404).json({ error: 'not found' });

  const pid = `${Date.now()}-${newId(6)}`;
  await putJson(`share/${id}/proposal/${pid}.json`, {
    author: a,
    note: n,
    plan,
    at: new Date().toISOString(),
  });
  return res.status(200).json({ pid });
}
