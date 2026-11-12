/**
 * GET /api/shared?id= — the shared doc: current plan, comments, proposal list.
 * Asked for by a view-only link's id: the plan and nothing else.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findShare, getJson, latestRevision, listPaths, pidOf, preflight, validId, type BlobRef } from './_lib.js';

interface StoredComment {
  author: string;
  text: string;
  at: string;
}
interface StoredSummary {
  author: string;
  note: string;
  at: string;
  items?: number;
  /** Only on proposals stored before summaries existed. */
  plan?: { furniture?: unknown[] };
}
interface StoredStatus {
  status: string;
  note?: string;
}

const STATUSES = new Set(['accepted', 'dismissed', 'changes']);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'GET')) return;
  if (!validId(req.query.id)) return res.status(400).json({ error: 'bad id' });

  const share = await findShare(req.query.id);
  if (!share) return res.status(404).json({ error: 'not found' });
  const { id } = share;

  const rev = await latestRevision(id);
  if (!rev) return res.status(404).json({ error: 'not found' });

  if (share.viewOnly) {
    return res.status(200).json({ plan: rev.plan, updatedAt: rev.at, comments: [], proposals: [], view: true });
  }

  const commentRefs = await listPaths(`share/${id}/comment/`);
  const comments = (
    await Promise.all(commentRefs.map((r) => getJson<StoredComment>(r)))
  ).filter((c): c is StoredComment => c !== null);

  const statusRefs = await listPaths(`share/${id}/status/`);
  const statuses = new Map<string, StoredStatus>();
  await Promise.all(
    statusRefs.map(async (ref) => {
      const s = await getJson<StoredStatus>(ref);
      if (s && STATUSES.has(s.status)) statuses.set(pidOf(ref.pathname), s);
    }),
  );

  // Proposals carry whole plans; the list is built from their small summaries — which also
  // outlive the plan of a proposal that has been accepted or dismissed.
  const sources = new Map<string, BlobRef>();
  for (const r of await listPaths(`share/${id}/proposal/`)) sources.set(pidOf(r.pathname), r);
  for (const r of await listPaths(`share/${id}/summary/`)) sources.set(pidOf(r.pathname), r);
  const proposals = (
    await Promise.all(
      [...sources].sort(([a], [b]) => a.localeCompare(b)).map(async ([pid, ref]) => {
        const p = await getJson<StoredSummary>(ref);
        if (!p) return null;
        const st = statuses.get(pid);
        return {
          pid,
          author: p.author,
          note: p.note,
          at: p.at,
          items:
            typeof p.items === 'number'
              ? p.items
              : Array.isArray(p.plan?.furniture)
                ? p.plan.furniture.length
                : 0,
          status: st?.status ?? 'open',
          ...(st?.status === 'changes' && st.note ? { reviewNote: st.note } : {}),
        };
      }),
    )
  ).filter((p) => p !== null);

  return res.status(200).json({ plan: rev.plan, updatedAt: rev.at, comments, proposals });
}
