/** GET /api/shared?id= — the shared doc: current plan, comments, proposal list. */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getJson, latestRevision, listPaths, preflight, readMeta, validId } from './_lib.js';

interface StoredComment {
  author: string;
  text: string;
  at: string;
}
interface StoredProposal {
  author: string;
  note: string;
  plan: { furniture?: unknown[] };
  at: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'GET')) return;
  const id = req.query.id;
  if (!validId(id)) return res.status(400).json({ error: 'bad id' });

  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: 'not found' });

  const rev = await latestRevision(id);
  if (!rev) return res.status(404).json({ error: 'not found' });

  const commentRefs = await listPaths(`share/${id}/comment/`);
  const comments = (
    await Promise.all(commentRefs.map((r) => getJson<StoredComment>(r)))
  ).filter((c): c is StoredComment => c !== null);

  const statusRefs = await listPaths(`share/${id}/status/`);
  const statuses = new Map<string, string>();
  for (const ref of statusRefs) {
    const pid = ref.pathname.split('/').pop()!.replace('.json', '');
    const s = await getJson<{ status: string }>(ref);
    if (s) statuses.set(pid, s.status);
  }

  const proposalRefs = await listPaths(`share/${id}/proposal/`);
  const proposals = (
    await Promise.all(
      proposalRefs.map(async (ref) => {
        const pid = ref.pathname.split('/').pop()!.replace('.json', '');
        const p = await getJson<StoredProposal>(ref);
        if (!p) return null;
        return {
          pid,
          author: p.author,
          note: p.note,
          at: p.at,
          items: Array.isArray(p.plan?.furniture) ? p.plan.furniture.length : 0,
          status: statuses.get(pid) ?? 'open',
        };
      }),
    )
  ).filter((p) => p !== null);

  return res.status(200).json({ plan: rev.plan, updatedAt: rev.at, comments, proposals });
}
