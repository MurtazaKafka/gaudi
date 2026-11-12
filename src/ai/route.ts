/**
 * What a line typed into the command bar means. Pure — no store, no network.
 *
 *   a command      →  ranked by `scoreCommand`
 *   a link         →  import a product
 *   a brief        →  "3 bed 2 bath L-shaped house" goes to Generate
 *   anything else  →  an edit of the current plan
 */

export type RequestKind = 'url' | 'brief' | 'edit';

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** The first link in the text, if any. */
export function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
}

const EDIT_VERB =
  /^(please\s+)?(add|move|remove|delete|make|change|rename|rotate|widen|narrow|shrink|enlarge|extend|resize|put|place|swap|turn|clear|set|furnish|refurnish|raise|lower|shift|push|pull|open|close|merge|split|knock|replace|center|centre|flip|name|call)\b/i;
const DWELLING =
  /\b(house|home|apartment|flat|studio|cottage|cabin|bungalow|villa|duplex|townhouse|condo|loft|adu|granny flat|floor ?plan|layout)\b/i;
const THIS_PLAN = /\b(this|current|existing|my|the)\s+(house|home|plan|layout|apartment|flat|room|wall|door|window)\b/i;
const PROGRAM = /\b\d+\s*[- ]?\s*(bed(room)?s?|br|bath(room)?s?|ba|storey|story|stories|car)\b/i;
const MAKE_NEW = /^(please\s+)?(generate|design|create|draw|make|build|give me|i want|i need|plan|sketch|lay ?out)\b/i;
const AREA = /\b\d{2,5}\s*(m2|m²|sq\.?\s*m|sqm|square met(er|re)s?|sq\.?\s*ft|sqft|ft2|ft²|square feet)\b/i;

/**
 * Is this a brief for a whole new house rather than a change to this one?
 * `empty` — the canvas has nothing on it yet, so nearly anything is a brief.
 */
export function looksLikeBrief(text: string, empty: boolean): boolean {
  const t = text.trim();
  if (!t) return false;
  if (THIS_PLAN.test(t)) return false;
  const editVerb = EDIT_VERB.test(t);
  const dwelling = DWELLING.test(t);
  if (MAKE_NEW.test(t) && dwelling) return true;
  if (editVerb) return false;
  if (PROGRAM.test(t)) return true;
  if (dwelling && (AREA.test(t) || t.split(/\s+/).length <= 8)) return true;
  return empty;
}

export function classifyRequest(text: string, opts: { empty: boolean }): RequestKind {
  if (extractUrl(text)) return 'url';
  return looksLikeBrief(text, opts.empty) ? 'brief' : 'edit';
}

/**
 * How well a query matches a command label (+ extra keywords).
 *   ≥ 100  strong: every typed word starts a word of the command
 *   1…99   weak: the letters appear in order (fuzzy)
 *   0      no match
 */
export function scoreCommand(query: string, label: string, keywords = ''): number {
  const q = query.trim().toLowerCase();
  if (!q) return 100;
  const hay = `${label} ${keywords}`.toLowerCase();
  const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  if (tokens.every((t) => words.some((w) => w.startsWith(t)))) {
    let score = 100;
    const lab = label.toLowerCase();
    if (lab.startsWith(q)) score += 50;
    else if (lab.includes(q)) score += 20;
    // Earlier words matter more.
    const first = words.findIndex((w) => w.startsWith(tokens[0]));
    return score + Math.max(0, 10 - first);
  }

  // Subsequence match over the label only, favouring compact runs.
  const lab = label.toLowerCase();
  const needle = q.replace(/\s+/g, '');
  if (needle.length < 2) return 0;
  let i = 0;
  let start = -1;
  let last = -1;
  for (let k = 0; k < lab.length && i < needle.length; k++) {
    if (lab[k] === needle[i]) {
      if (start < 0) start = k;
      last = k;
      i++;
    }
  }
  if (i < needle.length) return 0;
  const span = last - start + 1;
  // A sentence that merely happens to be spellable from the label is not a match.
  if (span > needle.length * 2) return 0;
  return Math.max(1, Math.min(99, Math.round((needle.length / span) * 90)));
}
