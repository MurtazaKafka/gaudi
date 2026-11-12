/**
 * GET /api/product?url=… — read one product page and return what a modeller
 * needs to know about it (name, brand, price, photos, dimensions).
 *
 * This fetches a URL a user pasted, so it is deliberately narrow:
 *   · one honest request per link — it says it is Gaudí's link preview, never
 *     a browser; no retry with other headers, no proxy, no captcha handling.
 *     Shops that refuse it (Amazon usually does) are reported as `blocked`
 *     and the app falls back to looking the product up or asking for details.
 *   · https only, public hosts only. Every hop is checked before it is
 *     requested and again when the socket resolves the name, redirects are
 *     followed by hand (at most 3), the whole thing has a 10 s deadline,
 *     and only the first 3 MB of an HTML reply is read.
 *
 * Replies are always JSON: the facts (`ok: true`), or
 * `{ ok: false, blocked | reason, asin?, slug?, url }`.
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { preflight } from './_lib.js';
import {
  classifyAmazonResponse,
  extractAmazonProduct,
  extractGenericProduct,
  firstUrl,
  looksLikeBotWall,
  parseAmazonUrl,
  slugFromUrl,
} from '../src/products/extract.js';
import { checkFetchUrl, isPublicAddress } from '../src/products/netGuard.js';

export const USER_AGENT =
  'GaudiLinkPreview/1.0 (floor-plan app; reads one product page when a person pastes its link)';
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.8',
  'Accept-Encoding': 'gzip, br',
};

export const MAX_REDIRECTS = 3;
/**
 * How much of a page is read and handed to the extractor. Amazon pages run 1–3 MB with the
 * spec tables anywhere in them; on the other shops sampled (pages of 0.1–5.7 MB) every fact
 * sat in the first 0.7 MB. The extractor reads a page in one pass — the slowest 3 MB page
 * found by fuzzing takes about 0.35 s — so this bounds the work, not just the download.
 */
export const MAX_BYTES = 3 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;

export interface PageReply {
  status: number;
  /** the Location header of a redirect */ location: string | null;
  contentType: string;
  /** decoded HTML; empty for redirects and anything that is not HTML */ body: string;
}

/** Resolve a hostname to every address it has. */
export type Resolve = (hostname: string) => Promise<string[]>;
/** Make one GET request. Must not follow redirects. */
export type GetPage = (url: URL, signal: AbortSignal) => Promise<PageReply>;

export interface Deps {
  resolve: Resolve;
  getPage: GetPage;
}

const isHtml = (contentType: string): boolean => /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim());

const defaultResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

/**
 * DNS lookup for the socket itself: the name is resolved once, here, and the
 * connection is refused unless every address is public — so a name cannot
 * pass the pre-check and then resolve somewhere private (DNS rebinding).
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      const blocked: NodeJS.ErrnoException = new Error('address not allowed');
      blocked.code = 'EBLOCKED';
      return callback(blocked, '', 0);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

function decodeBody(chunks: Buffer[], contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  const bytes = Buffer.concat(chunks);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const defaultGetPage: GetPage = (url, signal) =>
  new Promise<PageReply>((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', headers: REQUEST_HEADERS, lookup: guardedLookup, signal, agent: false },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '');
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const done = (body: string): void => {
          res.destroy();
          resolve({ status, location, contentType, body });
        };
        if ((status >= 300 && status < 400) || !isHtml(contentType)) return done('');

        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const unpack =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? createGunzip()
            : encoding === 'br'
              ? createBrotliDecompress()
              : encoding === 'deflate'
                ? createInflate()
                : null;
        if (!unpack && encoding && encoding !== 'identity') return done('');
        const stream = unpack ? res.pipe(unpack) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          done(decodeBody(chunks, contentType));
        };
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = MAX_BYTES - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (size >= MAX_BYTES) {
            finish(); // enough: keep what we have, stop reading
            stream.destroy();
          }
        });
        stream.on('end', finish);
        // a truncated or corrupt stream still leaves whatever arrived
        stream.on('error', () => (chunks.length ? finish() : reject(new Error('read failed'))));
        res.on('error', () => (chunks.length ? finish() : reject(new Error('read failed'))));
      },
    );
    req.on('error', reject);
    req.end();
  });

type Failure = { ok: false; url: string | null; asin?: string | null; slug?: string | null } & (
  | { blocked: string }
  | { reason: string }
);

/** Check a hop (URL shape, then every address the name resolves to), or say why not. */
async function allowed(url: URL, deps: Deps): Promise<string | null> {
  const check = checkFetchUrl(url);
  if (!check.ok) return check.reason;
  let addresses: string[];
  try {
    addresses = await deps.resolve(url.hostname);
  } catch {
    return 'unreachable';
  }
  if (addresses.length === 0) return 'unreachable';
  return addresses.every(isPublicAddress) ? null : 'unsafe-host';
}

/** The whole lookup, independent of the HTTP framing — also what the tests drive. */
export async function readProduct(input: string, deps: Deps, signal: AbortSignal): Promise<{ status: number; body: object }> {
  const text = input.trim().slice(0, 2000);
  const amazon = parseAmazonUrl(text);
  const pasted = firstUrl(text) ?? (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(text) ? `https://${text}` : null);
  const fail = (status: number, f: Failure): { status: number; body: object } => ({ status, body: f });

  let asin = amazon?.asin ?? null;
  const slug = amazon ? (amazon.slug ?? null) : pasted ? slugFromUrl(pasted) : null;
  let isAmazon = !!amazon;
  let start: string | null;
  if (amazon) {
    // Never the raw link: the rebuilt product URL, or the short link that redirects to it.
    start = amazon.canonicalUrl ?? (amazon.isShortLink ? pasted : null);
    if (!start) return fail(200, { ok: false, reason: 'not-a-product', url: pasted, slug });
  } else {
    start = pasted;
    if (!start) return fail(400, { ok: false, reason: 'bad-url', url: null });
  }

  let url: URL;
  try {
    url = new URL(start);
  } catch {
    return fail(400, { ok: false, reason: 'bad-url', url: null });
  }

  let reply: PageReply | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const refusal = await allowed(url, deps);
    if (refusal) return fail(refusal === 'bad-url' ? 400 : 200, { ok: false, reason: refusal, url: url.href, asin, slug });
    let r: PageReply;
    try {
      r = await deps.getPage(url, signal);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      const reason = signal.aborted ? 'timeout' : code === 'EBLOCKED' ? 'unsafe-host' : 'unreachable';
      return fail(200, { ok: false, reason, url: url.href, asin, slug });
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      let next: URL;
      try {
        next = new URL(r.location, url);
      } catch {
        return fail(200, { ok: false, reason: 'bad-redirect', url: url.href, asin, slug });
      }
      // A redirect that lands on Amazon is rebuilt to the plain product URL too.
      const hit = parseAmazonUrl(next.href);
      if (hit) {
        isAmazon = true;
        asin = hit.asin ?? asin;
        if (!hit.asin && !hit.isShortLink) {
          return fail(200, { ok: false, reason: 'not-a-product', url: next.href, asin, slug });
        }
        if (hit.canonicalUrl && hit.canonicalUrl !== url.href) next = new URL(hit.canonicalUrl);
      }
      url = next;
      continue;
    }
    reply = r;
    break;
  }
  if (!reply) return fail(200, { ok: false, reason: 'too-many-redirects', url: url.href, asin, slug });

  // Capped here as well as in the reader, so the bound holds whatever fetched the page.
  const html = reply.body.length > MAX_BYTES ? reply.body.slice(0, MAX_BYTES) : reply.body;
  if (isAmazon) {
    const kind = classifyAmazonResponse(reply.status, html);
    if (kind === 'product') {
      const facts = extractAmazonProduct(html, url.href);
      if (facts.ok) return { status: 200, body: { ...facts, site: 'amazon' } };
    }
    return fail(200, { ok: false, blocked: kind === 'product' ? 'unknown' : kind, url: url.href, asin, slug });
  }

  if (!isHtml(reply.contentType)) return fail(200, { ok: false, reason: 'not-html', url: url.href, slug });
  if (looksLikeBotWall(reply.status, html)) return fail(200, { ok: false, blocked: 'bot-wall', url: url.href, slug });
  if (reply.status === 404 || reply.status === 410) return fail(200, { ok: false, reason: 'not-found', url: url.href, slug });
  const facts = extractGenericProduct(html, url.href);
  if (!facts.ok) return fail(200, { ok: false, reason: 'no-product-data', url: url.href, slug });
  return { status: 200, body: { ...facts, site: url.hostname.replace(/^www\./, '') } };
}

const realDeps: Deps = { resolve: defaultResolve, getPage: defaultGetPage };

export function createHandler(deps: Deps = realDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    if (!preflight(req, res, 'GET')) return;
    const q = req.query?.url;
    const input = typeof q === 'string' ? q : Array.isArray(q) && typeof q[0] === 'string' ? q[0] : '';
    if (!input.trim()) return res.status(400).json({ ok: false, reason: 'bad-url', url: null });

    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const timedOut = new Promise<never>((_, reject) => {
        deadline.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
      const out = await Promise.race([readProduct(input, deps, deadline), timedOut]);
      const good = (out.body as { ok?: boolean }).ok === true;
      // A good read is worth keeping for a day; a refusal only briefly, so we never hammer a shop.
      res.setHeader('Cache-Control', good ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'public, s-maxage=300');
      return res.status(out.status).json(out.body);
    } catch {
      return res.status(200).json({ ok: false, reason: deadline.aborted ? 'timeout' : 'failed', url: null });
    }
  };
}

export default createHandler();
