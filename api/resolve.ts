/**
 * POST /api/resolve — the owner settles a proposal.
 *   accept   → the proposal becomes the new revision
 *   changes  → sent back with a short note the proposer sees on the link
 *   dismiss  → closed
 * Once accepted or dismissed, a proposal's plan is removed; its summary and outcome stay.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  cleanText,
  deletePaths,
  getJson,
  listPaths,
  pickPlan,
  PID_RE,
  preflight,
  pruneRevisions,
  putJson,
  readMeta,
  tokenMatches,
  tsKey,
  validId,
  validPlan,
} from './_lib.js';

const STATUS = { accept: 'accepted', dismiss: 'dismissed', changes: 'changes' } as const;

interface StoredProposal {
  author?: unknown;
  note?: unknown;
  at?: unknown;
  plan?: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!preflight(req, res, 'POST')) return;
  const { id, pid, action, ownerToken, note } = (req.body ?? {}) as Record<string, unknown>;
  if (!validId(id) || typeof pid !== 'string' || !PID_RE.test(pid)) {
    return res.status(400).json({ error: 'bad id' });
  }
  if (action !== 'accept' && action !== 'dismiss' && action !== 'changes') {
    return res.status(400).json({ error: 'bad action' });
  }
  const token = cleanText(ownerToken, 200);
  if (!token) return res.status(400).json({ error: 'missing ownerToken' });

  const meta = await readMeta(id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (!tokenMatches(token, meta.ownerHash)) return res.status(403).json({ error: 'not the owner' });

  const refs = await listPaths(`share/${id}/proposal/${pid}.json`);
  if (refs.length === 0) return res.status(404).json({ error: 'proposal not found' });

  if (action !== 'changes') {
    // Its plan is about to go: make sure the line in the list survives it (proposals older
    // than summaries have none), and for an accept, publish the plan first.
    const hasSummary = (await listPaths(`share/${id}/summary/${pid}.json`)).length > 0;
    const proposal = action === 'accept' || !hasSummary ? await getJson<StoredProposal>(refs[0]) : null;
    if (action === 'accept') {
      if (!proposal) return res.status(404).json({ error: 'proposal not found' });
      const plan = pickPlan(proposal.plan);
      if (!validPlan(plan)) return res.status(400).json({ error: 'invalid plan' });
      await putJson(`share/${id}/rev/${tsKey()}.json`, { plan, by: pid });
      await pruneRevisions(id);
    }
    if (!hasSummary && proposal) {
      const furniture = (proposal.plan as { furniture?: unknown } | undefined)?.furniture;
      await putJson(`share/${id}/summary/${pid}.json`, {
        author: proposal.author,
        note: proposal.note,
        at: proposal.at,
        items: Array.isArray(furniture) ? furniture.length : 0,
      });
    }
  }
  const reviewNote = action === 'changes' ? cleanText(note, 300) : null;
  await putJson(`share/${id}/status/${pid}.json`, {
    status: STATUS[action],
    ...(reviewNote ? { note: reviewNote } : {}),
    at: new Date().toISOString(),
  });
  // Settled for good: the plan no longer needs keeping (a failure here only leaves it behind).
  if (action !== 'changes') await deletePaths(refs).catch(() => {});
  return res.status(200).json({ ok: true });
}
