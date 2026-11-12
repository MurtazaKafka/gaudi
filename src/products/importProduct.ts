/**
 * Product link → custom furniture item in the plan.
 *
 * The road, in order: read the page through /api/product → if the shop will
 * not show it (the usual case for Amazon), look the product up on the web
 * from what the link itself says → have Claude build a small model of it from
 * primitives → normalise it to true size → store it in the plan. When none of
 * that can identify the product, a short details form opens instead; the
 * same modelling call builds from what is typed there, from a photo, or from
 * a plain description.
 *
 * Everything read from a page or the web is description, never instruction:
 * it reaches the modeller fenced as data, the reply is schema-bound, and the
 * result is validated before it touches the plan.
 */
import { create } from 'zustand';
import {
  AiError,
  aiErrorMessage,
  askJson,
  askWithWebSearch,
  ensureApiKey,
  isAbort,
  type AiContent,
} from '../ai/client';
import { customId, customKind, isCustomKind, type FurnitureDef } from '../catalog';
import { newCustomId } from '../customItems';
import { transact } from '../history';
import { documentToken, isSameDocument, type DocumentToken } from '../projects/lib';
import { planIsEphemeral } from '../session';
import { usePlanStore } from '../store';
import { toast, toastError } from '../toast';
import type { CustomItem, Furniture } from '../types';
import { useUiStore } from '../uiStore';
import { firstUrl, parseAmazonUrl, type ProductFacts } from './extract';
import {
  buildResearchPrompt,
  classifyInput,
  coerceFacts,
  dimsFromDetails,
  factsFromDescription,
  factsFromDetails,
  factsFromResearch,
  hintIsUsable,
  linkHint,
  parseResearch,
  sizeTargetOf,
  sourceOf,
  type Details,
} from './facts';
import {
  buildProductModelPrompt,
  normalizeProductModel,
  placeholderModel,
  PRODUCT_MODEL_SCHEMA,
  resizeDef,
  retryNoteFor,
  shortLabel,
  type NormalizedModel,
  type PromptFacts,
  type SizeTarget,
} from './model';
import { photoFromBlob, photoFromUrl, photosFromUrls, type Photo } from './photos';
import {
  buildSearchPrompt,
  factsFromSearchResult,
  mergeFacts,
  parseSearchReply,
  sameProduct,
  searchResultIsEnough,
  SEARCH_SYSTEM,
  type SearchResult,
} from './search';

const API_BASE =
  (import.meta.env.VITE_SHARE_API_BASE as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:5177' : '');

// ---------------------------------------------------------------- progress

export type ImportStep = 'reading' | 'researching' | 'modelling';

export const STEP_TEXT: Record<ImportStep, string> = {
  reading: 'Reading the page',
  researching: 'Looking it up',
  modelling: 'Building the model',
};

export interface ImportJob {
  id: string;
  /** what is being built, as far as it is known yet */ label: string;
  step: ImportStep;
  /** the item being re-modelled, for a refine */ refines?: string;
  /** the search result this builds, as `search:{result.id}` */ key?: string;
}

/** The details form's contents. Lengths in meters; null = left blank. */
export interface DetailsDraft extends Details {
  photo: Blob | null;
  /** one line above the form saying why it opened, if it opened by itself */ reason: string | null;
  /** changes every time the form is opened afresh */ seq: number;
}

interface ImportState {
  jobs: ImportJob[];
  draft: DetailsDraft | null;
}

export const useImportStore = create<ImportState>(() => ({ jobs: [], draft: null }));

const controllers = new Map<string, AbortController>();

/** Stop a running import. */
export function cancelImport(jobId: string): void {
  controllers.get(jobId)?.abort();
}

/** Open the "add the details" form (in the furniture palette), optionally pre-filled. */
let draftSeq = 0;

export function openDetails(seed: Partial<Omit<DetailsDraft, 'seq'>> = {}): void {
  const ui = useUiStore.getState();
  if (ui.readOnly) return;
  useImportStore.setState({
    draft: { name: '', w: null, d: null, h: null, note: '', url: null, asin: null, photo: null, reason: null, ...seed, seq: ++draftSeq },
  });
  if (ui.mode !== 'plan') ui.setMode('plan');
  ui.setPaletteOpen(true);
}

export function closeDetails(): void {
  useImportStore.setState({ draft: null });
}

export type ImportErrorKind = 'need-details' | 'no-key' | 'failed';

/** A failed import with a line fit to show. (A cancelled one throws AiError 'aborted', like every AI call.) */
export class ImportError extends Error {
  kind: ImportErrorKind;
  constructor(kind: ImportErrorKind, message: string) {
    super(message);
    this.name = 'ImportError';
    this.kind = kind;
  }
}

interface Job {
  signal: AbortSignal;
  /** throw if the job was cancelled */ check: () => void;
  step: (step: ImportStep, label?: string | null) => void;
}

async function runJob<T>(
  label: string,
  step: ImportStep,
  outer: AbortSignal | undefined,
  refines: string | undefined,
  fn: (job: Job) => Promise<T>,
  key?: string,
): Promise<T> {
  const id = newCustomId();
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (outer?.aborted) ac.abort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  controllers.set(id, ac);
  useImportStore.setState((s) => ({ jobs: [...s.jobs, { id, label: label.slice(0, 60), step, refines, key }] }));
  const patch = (p: Partial<ImportJob>): void =>
    useImportStore.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));
  const job: Job = {
    signal: ac.signal,
    check: () => {
      if (ac.signal.aborted) throw new AiError('aborted', 'Cancelled.');
    },
    step: (next, nextLabel) => patch(nextLabel ? { step: next, label: nextLabel.slice(0, 60) } : { step: next }),
  };
  try {
    job.check();
    return await fn(job);
  } catch (e) {
    // however the cancellation surfaced (fetch AbortError, SDK abort), report it one way
    if (ac.signal.aborted && !isAbort(e)) throw new AiError('aborted', 'Cancelled.');
    throw e;
  } finally {
    outer?.removeEventListener('abort', onAbort);
    controllers.delete(id);
    useImportStore.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  }
}

// ---------------------------------------------------------------- the plan side

/**
 * Which document an import belongs to; it must still be on the canvas when the model arrives.
 * Not the project id: a new plan has none until its first autosave, and is the same document after.
 */
const planToken = (): DocumentToken => documentToken();

/** True while the document `token` was taken on is the user's own, editable plan on the canvas. */
const samePlan = (token: DocumentToken): boolean =>
  !useUiStore.getState().readOnly && !planIsEphemeral() && isSameDocument(token);

function assertSamePlan(token: DocumentToken): void {
  if (!samePlan(token)) {
    throw new ImportError('failed', 'The plan changed while this was being built, so it was not added.');
  }
}

function commit(def: FurnitureDef, facts: ProductFacts | null, url: string | null | undefined, token: DocumentToken): CustomItem {
  assertSamePlan(token);
  const item: CustomItem = { ...def, id: newCustomId(), createdAt: Date.now() };
  const source = facts ? sourceOf(facts, url) : undefined;
  if (source) item.source = source;
  transact(() => usePlanStore.getState().putCustomItem(item));
  return item;
}

/** Pick the item up so the next click on the canvas drops it. */
export function placeItem(id: string): void {
  const ui = useUiStore.getState();
  if (ui.readOnly || !Object.hasOwn(usePlanStore.getState().customItems, id)) return;
  if (ui.mode !== 'plan') ui.setMode('plan');
  ui.startPlacing(customKind(id));
}

// If the item being placed disappears (deleted, undone, another plan loaded), stop placing it.
usePlanStore.subscribe((s, prev) => {
  if (s.customItems === prev.customItems) return;
  const ui = useUiStore.getState();
  const kind = ui.placingKind;
  if (ui.tool === 'furniture' && kind && isCustomKind(kind) && !Object.hasOwn(s.customItems, customId(kind))) {
    ui.setTool('select');
  }
});

// ---------------------------------------------------------------- reading the page

type PageRead =
  | { ok: true; facts: ProductFacts }
  | { ok: false; asin: string | null; slug: string | null; url: string | null };

/** Dev/test stand-in for the endpoint: return its JSON for a URL, or undefined to use the network. */
let factsMock: ((url: string) => unknown) | null = null;

async function readPage(url: string, signal: AbortSignal): Promise<PageRead> {
  let body: unknown = undefined;
  if (import.meta.env.DEV && factsMock) body = await factsMock(url);
  if (body === undefined) {
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(), 15_000);
    const onAbort = (): void => own.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await fetch(`${API_BASE}/api/product?url=${encodeURIComponent(url)}`, { signal: own.signal });
      body = await r.json();
    } catch {
      body = null; // offline, endpoint missing, timed out: the same as "could not read it"
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  const facts = coerceFacts(body);
  if (facts) return { ok: true, facts };
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 600) : null);
  const safeUrl = str(b.url);
  return { ok: false, asin: str(b.asin)?.slice(0, 20) ?? null, slug: str(b.slug)?.slice(0, 160) ?? null, url: safeUrl && /^https:\/\//i.test(safeUrl) ? safeUrl : null };
}

// ---------------------------------------------------------------- modelling

interface BuildInput {
  facts: ProductFacts;
  /** untrusted free text for the modeller: the web lookup, or the person's own note */ notes?: string | null;
  photos: Photo[];
  refine?: { previous: FurnitureDef; feedback: string };
  /** hold the model to this size; null lets the modeller estimate */ target: SizeTarget | null;
}

type Built = { def: FurnitureDef; block: boolean };

async function askForModel(input: BuildInput, signal: AbortSignal, retryNote?: string): Promise<NormalizedModel> {
  const promptFacts: PromptFacts = { ...input.facts, notes: input.notes ?? null };
  const text = buildProductModelPrompt(promptFacts, {
    wallHeight: usePlanStore.getState().settings.wallHeight,
    hasImages: input.photos.length > 0,
    refine: input.refine,
    retryNote,
  });
  // photos first, then the brief
  const blocks: Exclude<AiContent, string> = [
    ...input.photos.map((p) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: p.mediaType, data: p.data },
    })),
    { type: 'text' as const, text },
  ];
  const raw = await askJson<unknown>({
    tag: 'product-model',
    prompt: input.photos.length ? blocks : text,
    schema: PRODUCT_MODEL_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 16000,
    effort: retryNote ? 'high' : 'medium',
    signal,
  });
  return normalizeProductModel(raw, input.target);
}

/**
 * One modelling call, a second only when the proportions contradict a
 * trustworthy listing, and a plain block at true size when modelling fails
 * but the size is known.
 */
async function buildModel(input: BuildInput, job: Job): Promise<Built> {
  const block = (): Built | null =>
    input.target && !input.refine ? { def: placeholderModel(input.facts), block: true } : null;
  let first: NormalizedModel;
  try {
    first = await askForModel(input, job.signal);
  } catch (e) {
    if (isAbort(e) || job.signal.aborted) throw e;
    const b = block();
    if (b) return b;
    throw new ImportError('failed', aiErrorMessage(e));
  }
  job.check();
  if (!first.ok) {
    const b = block();
    if (b) return b;
    throw new ImportError('failed', 'The model came back empty — try again, or describe it differently.');
  }
  let best = first;
  if (first.meta.retry && first.meta.fit && input.target) {
    try {
      const second = await askForModel(input, job.signal, retryNoteFor(first.meta.fit, input.target));
      if (second.ok && (second.meta.fit?.worst ?? Infinity) < first.meta.fit.worst) best = second;
    } catch (e) {
      if (isAbort(e) || job.signal.aborted) throw e;
      // keep the first attempt
    }
    job.check();
  }
  return { def: best.def, block: false };
}

/** Make sure a key is there. If the person declines and the size is known, offer the plain block. */
async function requireKey(facts: ProductFacts, url: string | null, token: DocumentToken, job: Job): Promise<void> {
  const ok = await ensureApiKey();
  job.check();
  if (ok) return;
  if (sizeTargetOf(facts)) {
    toast('No API key, so no model. Use a plain block at true size?', {
      ms: 12000,
      action: {
        label: 'Use block',
        run: () => {
          try {
            const item = commit(placeholderModel(facts), facts, url, token);
            placeItem(item.id);
          } catch (e) {
            toastError(aiErrorMessage(e));
          }
        },
      },
    });
  }
  throw new ImportError('no-key', 'Add an API key to build a model of this.');
}

const linkLabel = (url: string): string => {
  const hint = linkHint(url);
  if (hint.slug) return hint.slug;
  return hint.shop ? `From ${hint.shop.replace(/\s*\(.*\)$/, '')}` : 'Product';
};

// ---------------------------------------------------------------- public: import

/**
 * Read a product page (Amazon etc.), have Claude model it from primitives,
 * store it in the plan's customItems and return it. Throws with a readable
 * message on failure. When the product cannot be identified from the link at
 * all, the details form opens (pre-filled) and this throws ImportError
 * 'need-details'.
 */
export async function importProductFromUrl(url: string, signal?: AbortSignal): Promise<CustomItem> {
  const req = classifyInput(url);
  const link = req.kind === 'link' ? req.url : url.trim();
  return runJob(linkLabel(link), 'reading', signal, undefined, async (job) => {
    const token = planToken();
    const read = await readPage(link, job.signal);
    job.check();

    let facts: ProductFacts;
    let notes: string | null = null;
    let guessed = false;
    if (read.ok) {
      facts = read.facts;
      facts.url ||= link;
    } else {
      const hint = linkHint(link, read);
      const askForDetails = (reason: string): never => {
        openDetails({ name: hint.slug ?? '', url: hint.url, asin: hint.asin, reason });
        throw new ImportError('need-details', "Couldn't read that page — add what you know about it in Furniture.");
      };
      if (!hintIsUsable(hint)) askForDetails("Couldn't read that page. Add what you know.");
      if (!(await ensureApiKey())) {
        job.check();
        askForDetails('No API key to look this up. Add its size for a plain block.');
      }
      job.check();
      job.step('researching');
      let reply: string;
      try {
        reply = await askWithWebSearch({
          tag: 'product-research',
          prompt: buildResearchPrompt(hint),
          maxSearches: 4,
          maxTokens: 4000,
          signal: job.signal,
        });
      } catch (e) {
        if (isAbort(e) || job.signal.aborted) throw e;
        return askForDetails("Couldn't look this one up. Add what you know.");
      }
      job.check();
      const research = parseResearch(reply);
      if (research.unknown) askForDetails("Couldn't find this product. Add what you know.");
      facts = factsFromResearch(hint, research);
      notes = research.notes;
      guessed = research.lowConfidence || !sizeTargetOf(facts);
    }

    await requireKey(facts, link, token, job);
    job.step('modelling', shortLabel(facts.title));
    const photos = await photosFromUrls(facts.images.map((i) => i.url), job.signal, 4);
    job.check();
    const built = await buildModel({ facts, notes, photos, target: sizeTargetOf(facts) }, job);
    const item = commit(built.def, facts, link, token);
    if (built.block) toast("Couldn't model this one — it's a plain block at true size. Refine it to try again.");
    else if (guessed) toast('The size is a best guess. Use Resize if it looks off.');
    return item;
  });
}

/** Build an item from a plain description ("a round walnut dining table for six"). */
export async function importFromDescription(text: string, signal?: AbortSignal): Promise<CustomItem> {
  const t = text.trim().slice(0, 2000);
  if (!t) throw new ImportError('failed', 'Describe the item first.');
  return runJob(t, 'modelling', signal, undefined, async (job) => {
    const token = planToken();
    const facts = factsFromDescription(t);
    await requireKey(facts, null, token, job);
    const built = await buildModel({ facts, notes: t.length > 120 ? t : null, photos: [], target: sizeTargetOf(facts) }, job);
    const item = commit(built.def, null, null, token);
    if (built.block) toast("Couldn't model this one — it's a plain block at true size. Refine it to try again.");
    return item;
  });
}

/** Build an item from the details form: a name, any known dimensions, an optional photo and note. */
export async function importFromDetails(details: Details, photo?: Blob | null, signal?: AbortSignal): Promise<CustomItem> {
  const facts = factsFromDetails(details);
  return runJob(facts.title ?? 'Item', 'modelling', signal, undefined, async (job) => {
    const token = planToken();
    const url = details.url ?? null;
    await requireKey(facts, url, token, job);
    const shot = photo ? await photoFromBlob(photo) : null;
    job.check();
    const note = details.note.trim().slice(0, 1800) || null;
    const built = await buildModel({ facts, notes: note, photos: shot ? [shot] : [], target: sizeTargetOf(facts) }, job);
    const item = commit(built.def, facts, url, token);
    if (built.block) toast("Couldn't model this one — it's a plain block at true size. Refine it to try again.");
    return item;
  });
}

/** A plain block from the details form — no key, no model. Needs all three dimensions. */
export function addBlockFromDetails(details: Details): CustomItem {
  const facts = factsFromDetails(details);
  if (!sizeTargetOf(facts)) throw new ImportError('failed', 'A block needs width, depth and height.');
  return commit(placeholderModel(facts), facts, details.url ?? null, planToken());
}

// ---------------------------------------------------------------- public: search

/**
 * Look for real products matching a few words ("grey sectional sofa"), through
 * Anthropic-hosted web search — nothing is fetched from this browser or from
 * our server. Returns validated results, possibly none.
 */
export async function searchProducts(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) throw new ImportError('failed', 'Type what to look for first.');
  if (!(await ensureApiKey())) throw new ImportError('no-key', 'Search needs an Anthropic API key.');
  if (signal?.aborted) throw new AiError('aborted', 'Cancelled.');
  const reply = await askWithWebSearch({
    tag: 'product-search',
    prompt: buildSearchPrompt(q),
    system: SEARCH_SYSTEM,
    maxSearches: 4,
    maxTokens: 4000,
    signal,
  });
  if (signal?.aborted) throw new AiError('aborted', 'Cancelled.');
  const parsed = parseSearchReply(reply);
  if (!parsed.readable) throw new ImportError('failed', "Couldn't read the search results. Try again.");
  return parsed.results;
}

interface SearchState {
  /** the words the results below are for */ query: string;
  status: 'idle' | 'searching' | 'done' | 'error';
  results: SearchResult[];
  /** one quiet line under the field */ message: string | null;
}

const NO_SEARCH: SearchState = { query: '', status: 'idle', results: [], message: null };

/** The palette's search, kept outside the component so results outlive closing and reopening it. */
export const useSearchStore = create<SearchState>(() => NO_SEARCH);

let searchRun: AbortController | null = null;

/** Run a search and show it. A newer search replaces a running one. Never rejects. */
export async function runSearch(query: string): Promise<void> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q || useUiStore.getState().readOnly) return;
  searchRun?.abort();
  const run = new AbortController();
  searchRun = run;
  useSearchStore.setState({ query: q, status: 'searching', results: [], message: null });
  try {
    const results = await searchProducts(q, run.signal);
    if (searchRun !== run) return;
    useSearchStore.setState({
      status: 'done',
      results,
      message: results.length ? null : 'Nothing found for that. Try other words.',
    });
  } catch (e) {
    if (searchRun !== run) return;
    if (isAbort(e) || run.signal.aborted) useSearchStore.setState(NO_SEARCH);
    else useSearchStore.setState({ status: 'error', results: [], message: aiErrorMessage(e) });
  } finally {
    if (searchRun === run) searchRun = null;
  }
}

/** Stop a running search and put the results away. */
export function clearSearch(): void {
  searchRun?.abort();
  searchRun = null;
  useSearchStore.setState(NO_SEARCH);
}

/** The item already built from this result, if it is in the plan. */
export function itemForResult(result: SearchResult): CustomItem | null {
  for (const item of Object.values(usePlanStore.getState().customItems)) {
    if (sameProduct(result, item.source)) return item;
  }
  return null;
}

const researchNotes = (result: SearchResult, extra?: string | null): string =>
  [`Shop: ${result.retailer}`, result.looks && `Looks like: ${result.looks}`, extra].filter(Boolean).join('\n').slice(0, 1800);

/**
 * Build a search result into an item. When the search already said what it
 * looks like and how big it is, that goes straight to the modeller; otherwise
 * the product page is read (one request, like any pasted link) and, failing
 * that, its size is looked up — and if nothing turns up, the size is estimated.
 */
export async function importFromSearchResult(result: SearchResult, signal?: AbortSignal): Promise<CustomItem> {
  const base = factsFromSearchResult(result);
  const enough = searchResultIsEnough(result);
  return runJob(
    shortLabel(result.title),
    enough ? 'modelling' : 'researching',
    signal,
    undefined,
    async (job) => {
      const token = planToken();
      await requireKey(base, result.url, token, job);
      let facts = base;
      let notes = researchNotes(result);
      let lowConfidence = false;
      if (!enough) {
        const read = await readPage(result.url, job.signal);
        job.check();
        if (read.ok) {
          facts = mergeFacts(read.facts, base);
        } else if (!sizeTargetOf(base)) {
          const hint = linkHint(result.url, { asin: result.asin ?? read.asin, slug: result.title, url: result.url });
          try {
            const reply = await askWithWebSearch({
              tag: 'product-research',
              prompt: buildResearchPrompt(hint),
              maxSearches: 3,
              maxTokens: 4000,
              signal: job.signal,
            });
            const research = parseResearch(reply);
            if (!research.unknown) {
              facts = mergeFacts(base, factsFromResearch(hint, research));
              notes = researchNotes(result, research.notes);
              lowConfidence = research.lowConfidence;
            }
          } catch (e) {
            if (isAbort(e) || job.signal.aborted) throw e;
            // no luck looking it up: model it from what the search said
          }
          job.check();
        }
      }
      const target = sizeTargetOf(facts);
      job.step('modelling');
      const photos = await photosFromUrls(facts.images.map((i) => i.url), job.signal, 4);
      job.check();
      const built = await buildModel({ facts, notes, photos, target }, job);
      const item = commit(built.def, facts, result.url, token);
      if (built.block) toast("Couldn't model this one — it's a plain block at true size. Refine it to try again.");
      else if (!target || lowConfidence) toast('The size is a best guess. Use Resize if it looks off.');
      return item;
    },
    `search:${result.id}`,
  );
}

/** The result row's one action: build it (or find the one already built) and pick it up. Never rejects. */
export async function addSearchResult(result: SearchResult): Promise<CustomItem | null> {
  if (useUiStore.getState().readOnly) return null;
  const have = itemForResult(result);
  if (have) {
    placeItem(have.id);
    return have;
  }
  if (useImportStore.getState().jobs.some((j) => j.key === `search:${result.id}`)) return null;
  try {
    const item = await importFromSearchResult(result);
    placeItem(item.id);
    return item;
  } catch (e) {
    if (e instanceof ImportError && e.kind === 'no-key') useSearchStore.setState({ message: e.message });
    reportImportError(e);
    return null;
  }
}

/**
 * The details form's Build: model it, close the form, pick the item up.
 * Resolves to a line to show in the form when it did not work, else null.
 */
export async function submitDetails(details: Details, photo: Blob | null, seq: number): Promise<string | null> {
  if (useUiStore.getState().readOnly) return 'This plan is view only.';
  try {
    const item = await importFromDetails(details, photo);
    if (useImportStore.getState().draft?.seq === seq) closeDetails();
    placeItem(item.id);
    return null;
  } catch (e) {
    if (isAbort(e)) return null;
    return aiErrorMessage(e);
  }
}

// ---------------------------------------------------------------- public: edit

function itemOrThrow(id: string): CustomItem {
  const items = usePlanStore.getState().customItems;
  if (!Object.hasOwn(items, id)) throw new ImportError('failed', 'That item is no longer in the plan.');
  return items[id];
}

/** Re-model an item from one line of feedback ("thinner legs, darker fabric"). Replaces it in place. */
export async function refineItem(id: string, feedback: string, signal?: AbortSignal): Promise<CustomItem> {
  const note = feedback.trim().slice(0, 400);
  if (!note) throw new ImportError('failed', 'Say what to change first.');
  const before = itemOrThrow(id);
  if (useUiStore.getState().readOnly) throw new ImportError('failed', 'This plan is view only.');
  return runJob(before.label, 'modelling', signal, id, async (job) => {
    const token = planToken();
    if (!(await ensureApiKey())) throw new ImportError('no-key', 'Add an API key to refine a model.');
    job.check();
    const facts = factsFromDetails({ name: before.source?.title ?? before.label, w: null, d: null, h: null, note: '' });
    facts.brand = before.source?.brand ?? null;
    facts.dimensions = dimsFromDetails(before);
    if (facts.dimensions) facts.dimensions.label = 'current model';
    const shot = before.source?.image ? await photoFromUrl(before.source.image, job.signal) : null;
    job.check();
    // No size target: the change may be about size. A wild jump in scale is treated as a unit slip.
    const input: BuildInput = { facts, photos: shot ? [shot] : [], refine: { previous: before, feedback: note }, target: null };
    const built = await buildModel(input, job);
    let def = built.def;
    const was = Math.max(before.w, before.d, before.h);
    const now = Math.max(def.w, def.d, def.h);
    if (now > was * 3 || now < was / 3) def = resizeDef(def, { w: (def.w * was) / now, d: (def.d * was) / now, h: (def.h * was) / now });

    assertSamePlan(token);
    const current = itemOrThrow(id); // it may have been resized or deleted meanwhile
    const next: CustomItem = { ...current, ...def, label: current.label };
    transact(() => usePlanStore.getState().putCustomItem(next));
    return next;
  });
}

/** Set an item's overall size (meters). Every placed copy follows. */
export function resizeItem(id: string, size: { w: number; d: number; h: number }): CustomItem | null {
  if (useUiStore.getState().readOnly) return null;
  const items = usePlanStore.getState().customItems;
  if (!Object.hasOwn(items, id)) return null;
  if (![size.w, size.d, size.h].every((v) => Number.isFinite(v) && v > 0)) return null;
  const item = items[id];
  const next: CustomItem = { ...item, ...resizeDef(item, size), label: item.label };
  transact(() => usePlanStore.getState().putCustomItem(next));
  return next;
}

/** Rename an item. */
export function renameItem(id: string, label: string): void {
  if (useUiStore.getState().readOnly) return;
  const items = usePlanStore.getState().customItems;
  const clean = label.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!Object.hasOwn(items, id) || !clean || clean === items[id].label) return;
  transact(() => usePlanStore.getState().putCustomItem({ ...items[id], label: clean }));
}

/** Delete an item and every placed copy. No confirmation: the toast puts it all back. */
export function deleteItem(id: string): void {
  if (useUiStore.getState().readOnly) return;
  const state = usePlanStore.getState();
  if (!Object.hasOwn(state.customItems, id)) return;
  const item = state.customItems[id];
  const kind = customKind(id);
  const placed: Furniture[] = state.furniture.filter((f) => f.kind === kind);
  const token = planToken();
  for (const j of useImportStore.getState().jobs) if (j.refines === id) cancelImport(j.id);
  transact(() => usePlanStore.getState().removeCustomItem(id));
  const n = placed.length;
  toast(`Deleted ${item.label}${n ? ` and ${n} placed ${n === 1 ? 'copy' : 'copies'}` : ''}.`, {
    action: {
      label: 'Undo',
      run: () => {
        // put back exactly this item, even if other edits happened since
        if (!samePlan(token)) return;
        const plan = usePlanStore.getState();
        if (Object.hasOwn(plan.customItems, id)) return;
        transact(() => {
          plan.putCustomItem(item);
          if (placed.length) plan.addFurnitureBatch(placed.map((f) => ({ kind: f.kind, x: f.x, y: f.y, rotation: f.rotation, ...(f.label ? { label: f.label } : {}) })));
        });
      },
    },
  });
}

// ---------------------------------------------------------------- public: the palette's one gesture

/**
 * What the palette's field does on Enter: a link is imported, anything else
 * is modelled from the description; the finished item is picked up for
 * placing. Never rejects — every outcome is shown, not thrown.
 */
export async function startImport(text: string): Promise<void> {
  const req = classifyInput(text);
  if (req.kind === 'empty' || useUiStore.getState().readOnly) return;
  try {
    const item = req.kind === 'link' ? await importProductFromUrl(req.url) : await importFromDescription(req.text);
    placeItem(item.id);
  } catch (e) {
    reportImportError(e);
  }
}

/** Show a failed import the quiet way: cancelled and "needs details / a key" say nothing more. */
export function reportImportError(e: unknown): void {
  if (isAbort(e)) return;
  if (e instanceof ImportError && e.kind !== 'failed') return;
  toastError(aiErrorMessage(e));
}

/** True when `text` looks like a product URL this feature can handle. */
export function looksLikeProductUrl(text: string): boolean {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return true;
  if (/\s/.test(t) || firstUrl(t)) return false;
  const amazon = parseAmazonUrl(t);
  return !!amazon && (!!amazon.asin || amazon.isShortLink) && /[./]/.test(t);
}

// ---------------------------------------------------------------- dev handle

if (import.meta.env.DEV) {
  const w = window as unknown as { __gaudi?: Record<string, unknown> };
  w.__gaudi = {
    ...(w.__gaudi ?? {}),
    products: {
      /** run a search and show it in the palette; resolves to the search state */
      search: async (query: string) => {
        await runSearch(query);
        return useSearchStore.getState();
      },
      /** add the nth shown result (or pass a result): builds it and picks it up for placing */
      add: (which: number | SearchResult = 0) => {
        const r = typeof which === 'number' ? useSearchStore.getState().results[which] : which;
        return r ? addSearchResult(r) : Promise.resolve(null);
      },
      /** where everything stands: the search, running imports, the details form, the plan's items */
      state: () => ({
        search: useSearchStore.getState(),
        jobs: useImportStore.getState().jobs.map((j) => ({ ...j, text: STEP_TEXT[j.step] })),
        draft: useImportStore.getState().draft,
        items: Object.values(usePlanStore.getState().customItems).map((i) => ({
          id: i.id,
          label: i.label,
          w: i.w,
          d: i.d,
          h: i.h,
          parts: i.parts.length,
          source: i.source ?? null,
          placed: usePlanStore.getState().furniture.filter((f) => f.kind === customKind(i.id)).length,
        })),
        placing: useUiStore.getState().tool === 'furniture' ? useUiStore.getState().placingKind : null,
      }),
      searchProducts,
      importFromSearchResult,
      addSearchResult,
      runSearch,
      clearSearch,
      searchStore: useSearchStore,
      buildSearchPrompt,
      parseSearchReply,
      submitDetails,
      importProductFromUrl,
      importFromDescription,
      importFromDetails,
      addBlockFromDetails,
      startImport,
      refineItem,
      resizeItem,
      renameItem,
      deleteItem,
      placeItem,
      cancelImport,
      openDetails,
      closeDetails,
      store: useImportStore,
      /** stand in for /api/product: fn(url) → the endpoint's JSON, or undefined to use the network */
      mockFacts: (fn: ((url: string) => unknown) | null) => {
        factsMock = fn;
      },
      schema: PRODUCT_MODEL_SCHEMA,
      normalizeProductModel,
      buildProductModelPrompt,
      buildResearchPrompt,
      parseResearch,
    },
  };
}
