/** POST /api/comment — anyone with the link can comment. */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cleanText, newId, preflight, putJson, readMeta, tsKey, validId } from './_lib.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, author, text } = (req.body ?? {}) as Record<string, unknown>;
  if (!validId(id)) return res.status(400).json({ error: 'bad id' });

  const a = cleanText(author, 40);
  const t = cleanText(text, 1000);
  if (!a || !t) return res.status(400).json({ error: 'author and text required' });

  if (!(await readMeta(id))) return res.status(404).json({ error: 'not found' });

  await putJson(`share/${id}/comment/${tsKey()}-${newId(4)}.json`, {
    author: a,
    text: t,
    at: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true });
}
