/** POST /api/propose — submit a modified plan as a draft ("pull request"). */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  cleanText,
  findShare,
  listPaths,
  MAX_PROPOSALS,
  newId,
  pickPlan,
  pidOf,
  preflight,
  putJson,
  validId,
  validPlan,
} from './_lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, author, note, plan: sent } = (req.body ?? {}) as Record<string, unknown>;
  if (!validId(id)) return res.status(400).json({ error: 'bad id' });

  const a = cleanText(author, 40);
  const n = cleanText(note, 500) ?? '';
  if (!a) return res.status(400).json({ error: 'author required' });
  // Only the plan's own fields are stored, whatever else the request carried.
  const plan = pickPlan(sent);
  if (!validPlan(plan)) return res.status(400).json({ error: 'invalid plan' });

  const share = await findShare(id);
  if (!share) return res.status(404).json({ error: 'not found' });
  if (share.viewOnly) return res.status(403).json({ error: 'view only' });

  // The cap is on proposals the owner has not answered yet: once one is accepted, dismissed
  // or sent back, it no longer takes a place.
  const answered = new Set((await listPaths(`share/${id}/status/`)).map((r) => pidOf(r.pathname)));
  const open = (await listPaths(`share/${id}/proposal/`)).filter((r) => !answered.has(pidOf(r.pathname)));
  if (open.length >= MAX_PROPOSALS) return res.status(429).json({ error: 'too many' });

  const pid = `${Date.now()}-${newId(6)}`;
  const at = new Date().toISOString();
  const furniture = (plan as { furniture: unknown[] }).furniture;
  await putJson(`share/${id}/proposal/${pid}.json`, { author: a, note: n, plan, at });
  // The list view reads this instead of every proposal's whole plan.
  await putJson(`share/${id}/summary/${pid}.json`, { author: a, note: n, at, items: furniture.length });
  return res.status(200).json({ pid });
}
