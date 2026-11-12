/**
 * Product-page reading: link parsing, block-page detection, a dimensions
 * parser, and two extractors (Amazon's page layout; any shop's schema.org /
 * OpenGraph tags). Pure functions over strings — no network, no DOM, no
 * imports — so the same file runs in the /api/product function and in the
 * browser (where it parses pasted listing text).
 */

// ---------------------------------------------------------------- types

export type DimConfidence = 'high' | 'medium' | 'low';

export interface DimMeters {
  /** across, left-right when facing the item */ w: number | null;
  /** front to back */ d: number | null;
  /** floor to top */ h: number | null;
}

export interface DimTerm {
  axis: string | null;
  value: number;
  unit: string;
}

export interface ParsedDimensions {
  raw: string;
  terms: DimTerm[];
  unit: string;
  /** every number came with its axis (W/D/H letters, or a header order) */
  labeled: boolean;
  /** high: W, D and H all known · medium: L/W/H, two axes, diameter · low: order guessed */
  confidence: DimConfidence;
  meters: DimMeters;
  /** the same numbers, largest first — for when the axes are a guess */
  sortedMeters: number[];
}

export interface DimensionCandidate extends ParsedDimensions {
  /** the row or place it was read from, e.g. "Product Dimensions" */ label: string;
  source: string;
}

export interface ProductImage {
  id: string;
  /** about 1000 px on the long edge when the host supports sizing */ url: string;
  thumb: string;
}

export interface ProductPrice {
  amount: number;
  currency: string | null;
  display: string;
}

/** Everything a modeller needs to know about one product. */
export interface ProductFacts {
  ok: boolean;
  asin: string | null;
  url: string | null;
  title: string | null;
  subtitle: string | null;
  brand: string | null;
  price: ProductPrice | null;
  color: string | null;
  material: string | null;
  materials: Record<string, string>;
  category: string[];
  productType: string | null;
  bullets: string[];
  description: string | null;
  dimensions: DimensionCandidate | null;
  dimensionCandidates: Pick<DimensionCandidate, 'raw' | 'meters' | 'confidence' | 'label' | 'source'>[];
  /** seat height, arm height, leg length … in meters */
  measures: Record<string, number>;
  weightKg: number | null;
  images: ProductImage[];
  specs: Record<string, string>;
  warnings: string[];
}

export function emptyFacts(): ProductFacts {
  return {
    ok: false,
    asin: null,
    url: null,
    title: null,
    subtitle: null,
    brand: null,
    price: null,
    color: null,
    material: null,
    materials: {},
    category: [],
    productType: null,
    bullets: [],
    description: null,
    dimensions: null,
    dimensionCandidates: [],
    measures: {},
    weightKg: null,
    images: [],
    specs: {},
    warnings: [],
  };
}

// ---------------------------------------------------------------- URL / ASIN

const SHORT_HOSTS = /^(a\.co|amzn\.to|amzn\.com|amzn\.eu|amzn\.asia|amzn\.in)$/i;
const AMAZON_HOST =
  /(^|\.)amazon\.(com|ca|co\.uk|de|fr|it|es|nl|se|pl|com\.be|com\.mx|com\.br|co\.jp|in|com\.au|sg|ae|sa|eg|com\.tr)$/i;
const ASIN_PATH =
  /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing|product-reviews|exec\/obidos\/(?:ASIN|tg\/detail\/-)|o\/ASIN|dp\/product|d)\/([A-Z0-9]{10})(?=[/?#]|$)/i;
// last resort, only tried on amazon hosts and only if it looks like an ASIN
const ASIN_LOOSE = /\/([A-Z0-9]{10})(?=[/?#]|$)/;

export interface AmazonLink {
  asin: string | null;
  host: string;
  /** a.co / amzn.to: the product id is only known after following the redirect */
  isShortLink: boolean;
  canonicalUrl: string | null;
  /** the readable name in the URL path, when there is one */
  slug?: string | null;
}

/** The first http(s) URL in a pasted string ("Check this out! https://a.co/d/abc"), or null. */
export function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text);
  return m ? m[0].replace(/[),.;!]+$/, '') : null;
}

/** Recognise an Amazon product link in any of its forms. Null when it is not Amazon at all. */
export function parseAmazonUrl(input: unknown): AmazonLink | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (/^[A-Z0-9]{10}$/.test(s) && /^(B0|\d{9}[\dX]$)/.test(s)) {
    return { asin: s, host: 'www.amazon.com', isShortLink: false, canonicalUrl: `https://www.amazon.com/dp/${s}`, slug: null };
  }
  const m = /https?:\/\/[^\s<>"']+/i.exec(s);
  if (m) s = m[0];
  else if (/^(www\.)?(amazon\.|a\.co\/|amzn\.)/i.test(s)) s = 'https://' + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (SHORT_HOSTS.test(host)) {
    // amzn.com/dp/ASIN carries the id; a.co/d/xxxx and amzn.to/xxxx only redirect to it
    const direct = host === 'amzn.com' ? /^\/(?:dp\/)?(B0[A-Z0-9]{8})(?=[/?#]|$)/.exec(u.pathname) : null;
    if (direct) {
      return { asin: direct[1], host, isShortLink: false, canonicalUrl: `https://www.amazon.com/dp/${direct[1]}`, slug: null };
    }
    return { asin: null, host, isShortLink: true, canonicalUrl: null };
  }
  if (!AMAZON_HOST.test(host)) return null;
  let asin: string | null = null;
  let path = u.pathname;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    /* keep the raw path */
  }
  const m1 = ASIN_PATH.exec(path);
  if (m1) asin = m1[1].toUpperCase();
  if (!asin) {
    const q = u.searchParams.get('asin') || u.searchParams.get('ASIN') || u.searchParams.get('pd_rd_i');
    if (q && /^[A-Z0-9]{10}$/i.test(q)) asin = q.toUpperCase();
  }
  if (!asin) {
    const m2 = ASIN_LOOSE.exec(path);
    if (m2 && /^B0[A-Z0-9]{8}$/.test(m2[1])) asin = m2[1];
  }
  if (!asin) return { asin: null, host, isShortLink: false, canonicalUrl: null };
  const site = host.replace(/^(smile|m|www)\./, '');
  const sm = /^\/(?:-\/[a-z]{2}\/)?([^/]{6,})\/dp\//i.exec(path);
  const slug = sm && !/^(gp|dp|exec|product-reviews)$/i.test(sm[1]) ? sm[1].replace(/-/g, ' ').trim() : null;
  return { asin, host, isShortLink: false, canonicalUrl: `https://www.${site}/dp/${asin}`, slug };
}

/**
 * A readable product name guessed from any shop URL's path
 * ("/us/en/p/kivik-sofa-s59484727/" → "kivik sofa"). Null when nothing word-like is there.
 */
export function slugFromUrl(url: string): string | null {
  const amazon = parseAmazonUrl(url);
  if (amazon) return amazon.slug ?? null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path */
  }
  const segs = path.split('/').filter(Boolean).map((s) => s.replace(/\.(html?|php|aspx?)$/i, ''));
  let best: string | null = null;
  for (const seg of segs) {
    const words = seg
      .split(/[-_+\s]+/)
      .filter((w) => /^[a-z][a-z']{1,}$/i.test(w) || /^\d{1,3}$/.test(w));
    const letters = words.filter((w) => /[a-z]/i.test(w));
    if (letters.length < 2) continue;
    const name = words.join(' ').trim();
    if (!best || name.length > best.length) best = name;
  }
  return best ? best.slice(0, 120) : null;
}

// ---------------------------------------------------------------- block detection

export type AmazonPageKind = 'product' | 'captcha' | 'interstitial' | 'gate' | 'not-found' | 'unknown';

/** What Amazon sent back. Detect on content, never on status: block pages arrive as HTTP 200. */
export function classifyAmazonResponse(status: number, html: string): AmazonPageKind {
  const h = html || '';
  if (/api-services-support@amazon\.com|Enter the characters you see below|Type the characters you see in this image|\/errors\/validateCaptcha/i.test(h)) {
    return 'captcha';
  }
  if (/bm-verify=|_sec\/verify\?provider=interstitial/.test(h)) return 'interstitial';
  if (/Click the button below to continue shopping/i.test(h)) return 'gate';
  if (/id=["']productTitle["']/.test(h)) return 'product';
  if (status === 404 || /<title>\s*Page Not Found|Looking for something\?/i.test(h)) return 'not-found';
  return 'unknown';
}

/** Generic "this is a bot wall, not the page" check for any shop. */
export function looksLikeBotWall(status: number, html: string): boolean {
  const h = (html || '').slice(0, 60_000);
  if (/bm-verify=|_sec\/verify\?provider=interstitial|\/errors\/validateCaptcha/.test(h)) return true;
  if (/<title>\s*(Just a moment|Attention Required|Access Denied|Robot Check|Are you a robot|Pardon Our Interruption|Security Check)/i.test(h)) return true;
  if (/cf-challenge|cf_chl_opt|px-captcha|captcha-delivery\.com|datadome/i.test(h) && !/application\/ld\+json/i.test(h)) return true;
  return status === 403 || status === 429 || status === 503;
}

// ---------------------------------------------------------------- tiny HTML helpers

const NAMED: Record<string, string> = {
  quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ', rlm: '', lrm: '', times: '×',
  Prime: '″', prime: '′', rdquo: '”', ldquo: '“', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—',
  deg: '°', frac12: '½', frac14: '¼', frac34: '¾',
};

function codePoint(n: number, all: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
}

export function decodeEntities(s: string): string {
  let out = s;
  // twice: shops double-encode some attributes (&amp;amp;, &amp;quot;)
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&#x([0-9a-f]+);/gi, (all, x: string) => codePoint(parseInt(x, 16), all))
      .replace(/&#(\d+);/g, (all, d: string) => codePoint(Number(d), all))
      .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (all, n: string) => (Object.hasOwn(NAMED, n) ? NAMED[n] : all));
  }
  return out;
}

/*
 * Pages arrive from anywhere, so nothing here may cost more than one pass over the page.
 * Two shapes do: `<tag[^>]*…>` rescans to the end of the page from every `<tag` that never
 * closes, and a lazy `open[\s\S]*?close` does the same from every opener with no closer.
 * So a tag is read as `<tag[^<>]*>` (it ends at its own `>`), an attribute is looked for only
 * after `(?=[^<>]*>)` has seen that `>`, and open…close pairs are walked forward (`seeker`,
 * `spans`, `pairs`) instead of matched lazily.
 */

/**
 * First match of `re` (a /g pattern) at or after `from`. Positions must not go backwards
 * between calls: the last answer is kept, so a whole run of calls reads the text once.
 */
function seeker(s: string, re: RegExp): (from: number) => RegExpExecArray | null {
  let hit: RegExpExecArray | null = null;
  let none = false;
  return (from) => {
    if (none) return null;
    if (!hit || hit.index < from) {
      re.lastIndex = from;
      hit = re.exec(s);
      none = !hit;
    }
    return hit;
  };
}

/** What lies between each `open` match and the first `close` after it (both /g patterns), in order. */
function spans(s: string, open: RegExp, close: RegExp, limit = Infinity): string[] {
  const out: string[] = [];
  let o: RegExpExecArray | null;
  while (out.length < limit && (o = open.exec(s))) {
    const start = o.index + o[0].length;
    close.lastIndex = start;
    const c = close.exec(s);
    if (!c) break; // no closer from here on, so none for any later opener either
    out.push(s.slice(start, c.index));
    open.lastIndex = c.index + c[0].length;
  }
  return out;
}

/** `s` without its <script>, <style> and <noscript> elements (each becomes a space). */
function dropBlocks(s: string): string {
  const open = /<(script|style|noscript)\b/gi;
  const closers = new Map<string, (from: number) => RegExpExecArray | null>();
  let out = '';
  let last = 0;
  let o: RegExpExecArray | null;
  while ((o = open.exec(s))) {
    const name = o[1].toLowerCase();
    let closer = closers.get(name);
    if (!closer) closers.set(name, (closer = seeker(s, new RegExp(`</${name}>`, 'gi'))));
    const c = closer(open.lastIndex);
    if (!c) continue; // never closed: left as it is
    out += s.slice(last, o.index) + ' ';
    last = open.lastIndex = c.index + c[0].length;
  }
  return last ? out + s.slice(last) : s;
}

/** Visible text of an HTML fragment, whitespace collapsed. */
export function text(fragment: string | null | undefined): string {
  let s = dropBlocks(fragment || '');
  // Comments, then tags. Past the last closer nothing can match, and before it every
  // opener finds one, so each pattern only ever reads forward.
  const lastComment = s.lastIndexOf('-->') + 3;
  if (lastComment >= 3) s = s.slice(0, lastComment).replace(/<!--[\s\S]*?-->/g, ' ') + s.slice(lastComment);
  const lastTag = s.lastIndexOf('>') + 1;
  if (lastTag) s = s.slice(0, lastTag).replace(/<[^>]+>/g, ' ') + s.slice(lastTag);
  return decodeEntities(s)
    .replace(/[\u200e\u200f\u202a-\u202e\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Inner HTML of the first element whose id matches, found by balancing same-name tags. */
export function elementById(html: string, id: string): string | null {
  const open = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)\\b(?=[^<>]*>)[^<>]*\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^<>]*>`,
    'i',
  );
  const m = open.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length;
  if (/\/>$/.test(m[0]) || /^(img|input|meta|link|br|hr)$/.test(tag)) return '';
  const re = new RegExp(`<(/?)${tag}\\b[^<>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = re.exec(html))) {
    if (t[1]) depth--;
    else if (!/\/>$/.test(t[0])) depth++;
    if (depth === 0) return html.slice(start, t.index);
    if (t.index - start > 600_000) break; // runaway guard
  }
  return html.slice(start, start + 200_000);
}

function attr(tagHtml: string | null | undefined, name: string): string | null {
  const m = new RegExp(`\\b${name}=("([^"]*)"|'([^']*)')`, 'i').exec(tagHtml || '');
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
}

function firstTag(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[0] : null;
}

/**
 * What `value` (a sticky pattern with one group) reads right after the tag that holds
 * `marker`: the first `marker … > value` on the page. Each tag end is tried once.
 */
function afterTag(s: string, marker: RegExp, value: RegExp): string | null {
  let gt = -1;
  for (const m of s.matchAll(marker)) {
    const from = m.index + m[0].length;
    if (gt >= from) continue; // same tag end as the marker before, which had no value
    gt = s.indexOf('>', from);
    if (gt < 0) return null;
    value.lastIndex = gt + 1;
    const v = value.exec(s);
    if (v) return v[1];
  }
  return null;
}

/**
 * Where the first `then` ends that starts within `reach` characters of an `open`, or null.
 * (`open[\s\S]{0,reach}?then`, without reading the reach again for every opener.) /g patterns.
 */
function within(s: string, open: RegExp, then: RegExp, reach: number): number | null {
  const next = seeker(s, then);
  for (const o of s.matchAll(open)) {
    const from = o.index + o[0].length;
    const t = next(from);
    if (!t) return null;
    if (t.index - from <= reach) return t.index + t[0].length;
  }
  return null;
}

/**
 * `open … > inner close`, where `close` starts within `reach` characters of that `>`: the
 * inner text of the first such place, or null. (`open[^>]*>([\s\S]{0,reach}?)close`, without
 * reading to the tag end and across the reach again for every opener.) All /g patterns.
 */
function innerAfter(s: string, open: RegExp, close: RegExp, reach: number): string | null {
  const tagEnd = seeker(s, />/g);
  const closer = seeker(s, close);
  for (const o of s.matchAll(open)) {
    const gt = tagEnd(o.index + o[0].length);
    const c = gt && closer(gt.index + 1);
    if (!c) return null;
    if (c.index - gt.index - 1 <= reach) return s.slice(gt.index + 1, c.index);
  }
  return null;
}

// ---------------------------------------------------------------- dimensions

const UNIT_M: Record<string, number> = { in: 0.0254, cm: 0.01, mm: 0.001, m: 1, ft: 0.3048 };

function unitOf(s: string | null | undefined): string | null {
  if (!s) return null;
  const u = s.toLowerCase().replace(/\./g, '').trim();
  if (/^("|”|″|''|’’|inch(es)?|in)$/.test(u)) return 'in';
  if (/^(cm|centimeters?|centimetres?)$/.test(u)) return 'cm';
  if (/^(mm|millimeters?|millimetres?)$/.test(u)) return 'mm';
  if (/^(m|meters?|metres?)$/.test(u)) return 'm';
  if (/^('|’|′|ft|feet|foot)$/.test(u)) return 'ft';
  return null;
}

function axisOf(s: string | null | undefined): string | null {
  if (!s) return null;
  const a = s.toLowerCase().replace(/[().:]/g, '').trim();
  if (/^(w|width|wide)$/.test(a)) return 'W';
  if (/^(d|depth|deep)$/.test(a)) return 'D';
  if (/^(h|height|high|tall)$/.test(a)) return 'H';
  if (/^(l|length|long)$/.test(a)) return 'L';
  if (/^(dia|diam|diameter|ø)$/.test(a)) return 'DIA';
  return null;
}

// (?<!\d): a number is read from its first digit only, so a long run of digits is read once, not once per digit
const NUM = String.raw`((?<!\d)\d+(?:[.,]\d+)?(?:\s+\d\/\d)?)`;
const UNIT = String.raw`("|”|″|''|’’|'|’|′|inch(?:es)?\b|in\b\.?|cm\b|centimeters?\b|centimetres?\b|mm\b|millimeters?\b|millimetres?\b|m\b|meters?\b|metres?\b|ft\b\.?|feet\b|foot\b)`;
const AXIS = String.raw`(\(?(?<![a-zA-Z])(?:width|depth|height|length|diameter|diam|dia|wide|deep|high|tall|long|[wdhl])(?![a-zA-Z])\.?\)?)`;
// one term: [axis] number [unit] [axis]   e.g.  31.5"D   D 31.5 in   9.3(D)   19" D   W40
const TERM = new RegExp(String.raw`(?:${AXIS}\s*[:=]?\s*)?${NUM}\s*${UNIT}?\s*${AXIS}?`, 'i');
const SEP = /\s*(?:x|×|✕|\*|by)\s*/i;

function toNumber(s: string): number {
  const frac = /^(\d+(?:[.,]\d+)?)\s+(\d)\/(\d)$/.exec(s);
  if (frac) return parseFloat(frac[1].replace(',', '.')) + Number(frac[2]) / Number(frac[3]);
  return parseFloat(s.replace(',', '.'));
}

/** Order hint from a label such as "Item Dimensions D x W x H" or "Product Dimensions (LxWxH)". */
export function orderHintFromLabel(label: string | null | undefined): string[] | null {
  const m = /\b([LWDH])\s*[x×]\s*([LWDH])(?:\s*[x×]\s*([LWDH]))?\b/i.exec(label || '');
  return m ? [m[1], m[2], m[3]].filter(Boolean).map((c) => c.toUpperCase()) : null;
}

/**
 * Parse one dimensions string into plan-frame meters: w across, d front-to-back,
 * h floor-to-top. Null when the text is not a set of dimensions.
 */
export function parseDimensions(raw: unknown, orderHint: string[] | null = null): ParsedDimensions | null {
  if (!raw) return null;
  let s = decodeEntities(String(raw)).replace(/[\u200e\u200f]/g, '').trim();
  s = s.split(/;|\|/)[0]; // "10 x 10 x 60 inches; 7 Pounds"
  const parts = s.split(SEP).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) {
    // single labeled values strung together: 24"D 48"W
    const multi = [...s.matchAll(new RegExp(TERM.source, 'gi'))].filter((m) => m[1] || m[4]);
    if (multi.length < 2 || multi.length > 3) return null;
    parts.length = 0;
    for (const m of multi) parts.push(m[0]);
  }
  interface Term {
    value: number;
    unit: string | null;
    axis: string | null;
  }
  const terms: Term[] = [];
  for (const p of parts) {
    const m = TERM.exec(p);
    if (!m) return null;
    const value = toNumber(m[2]);
    if (!Number.isFinite(value) || value <= 0) return null;
    terms.push({ value, unit: unitOf(m[3]), axis: axisOf(m[1]) || axisOf(m[4]) });
  }
  // a trailing unit applies to every term ("23.6 x 11.3 x 31.5 inches")
  const lastUnit = [...terms].reverse().find((t) => t.unit)?.unit ?? null;
  const tail = /(inch(?:es)?|\bin\b|cm|centimeters?|centimetres?|mm|millimeters?|feet|ft|meters?|metres?)\s*$/i.exec(s);
  const fallbackUnit = lastUnit || unitOf(tail?.[1]) || null;
  for (const t of terms) t.unit ||= fallbackUnit;
  for (const t of terms) t.unit ||= 'in'; // amazon.com default; lowers confidence below
  const unitGuessed = !fallbackUnit;

  const labeled = terms.every((t) => t.axis);
  if (!labeled && orderHint && orderHint.length >= terms.length) {
    terms.forEach((t, i) => {
      t.axis ||= orderHint[i];
    });
  }
  const hinted = !labeled && terms.every((t) => t.axis);

  const mOf = (t: Term): number => +(t.value * UNIT_M[t.unit ?? 'in']).toFixed(4);
  let w: number | null = null;
  let d: number | null = null;
  let h: number | null = null;
  let confidence: DimConfidence = 'low';
  if (terms.every((t) => t.axis)) {
    const by: Record<string, number> = {};
    for (const t of terms) by[t.axis as string] = mOf(t);
    h = by.H ?? null;
    if (by.DIA != null) w = d = by.DIA;
    if (by.W != null) w = by.W;
    if (by.D != null) d = by.D;
    if (by.L != null) {
      // "L" is whichever horizontal axis is still free. With L+W the long side is usually
      // "across" (sofas, desks) but head-to-foot for beds: medium, so the modeller decides.
      if (w == null && d != null) w = by.L;
      else if (d == null && w != null) d = by.L;
      else if (w == null && d == null) w = by.L;
      if (by.W != null && by.D == null) {
        w = Math.max(by.L, by.W);
        d = Math.min(by.L, by.W);
      }
    }
    confidence = by.L != null || terms.length < 3 ? 'medium' : 'high';
  } else if (terms.length === 3) {
    [w, d, h] = terms.map(mOf);
  } else {
    [w, d] = terms.map(mOf);
  }
  if (unitGuessed && confidence === 'high') confidence = 'medium';
  return {
    raw: s.trim(),
    terms: terms.map((t) => ({ axis: t.axis, value: t.value, unit: t.unit ?? 'in' })),
    unit: terms[0].unit ?? 'in',
    labeled: labeled || hinted,
    confidence,
    meters: { w, d, h },
    sortedMeters: terms.map(mOf).sort((a, b) => b - a),
  };
}

/** Scan free text (a title, a bullet, a pasted spec block) for a dimensions phrase. */
export function findDimensionsInText(t: string | null | undefined): ParsedDimensions | null {
  if (!t) return null;
  const term = TERM.source;
  const re = new RegExp(String.raw`${term}(?:\s*(?:x|×|\*|by)\s*${term}){1,2}`, 'gi');
  let best: ParsedDimensions | null = null;
  let bestScore = -1;
  // single spaces: the patterns allow whitespace in several adjacent places, and a long run of it multiplies
  const src = decodeEntities(t).replace(/\s+/g, ' ');
  // A pasted spec row: "Item Dimensions D x W x H   31.5 x 61 x 28.35 inches" — the header names the order.
  const plain = String.raw`${NUM}\s*${UNIT}?`;
  const triple = new RegExp(String.raw`^${plain}(?:\s*(?:x|×|\*|by)\s*${plain}){2}`, 'i');
  for (const hm of src.matchAll(/(?<![a-zA-Z])([LWDH])\s*[x×]\s*([LWDH])\s*[x×]\s*([LWDH])(?![a-zA-Z])[\s:)\]–-]*/gi)) {
    const rest = src.slice((hm.index ?? 0) + hm[0].length, (hm.index ?? 0) + hm[0].length + 80);
    const tm = triple.exec(rest);
    const p = tm ? parseDimensions(tm[0], [hm[1], hm[2], hm[3]].map((c) => c.toUpperCase())) : null;
    if (p && p.labeled) {
      best = p;
      bestScore = 6; // beats anything the general scan can score
      break;
    }
  }
  for (const m of src.matchAll(re)) {
    const p = parseDimensions(m[0]);
    if (!p) continue;
    const explicitUnit = /"|”|″|''|inch|\bin\b|cm|mm|feet|ft\b/i.test(m[0]);
    if (!p.labeled && !explicitUnit) continue; // "2 x 4 pack" style noise
    const score = (p.labeled ? 2 : 0) + p.terms.length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------- spec tables

type Row = [string, string];

/**
 * Key/value markup laid out as `open K joint V end` (all /g patterns): K runs from an opener
 * to the first `joint` after it, V from there to the first `end`. One walk forward.
 */
function pairs(s: string, open: RegExp, joint: RegExp, end: RegExp): Row[] {
  const out: Row[] = [];
  let o: RegExpExecArray | null;
  while ((o = open.exec(s))) {
    joint.lastIndex = o.index + o[0].length;
    const j = joint.exec(s);
    if (!j) break; // nothing later can complete a pair either
    end.lastIndex = j.index + j[0].length;
    const e = end.exec(s);
    if (!e) break;
    out.push([s.slice(o.index + o[0].length, j.index), s.slice(j.index + j[0].length, e.index)]);
    open.lastIndex = e.index + e[0].length;
  }
  return out;
}

function rowsFromTables(sectionHtml: string | null): Row[] {
  const rows: Row[] = [];
  if (!sectionHtml) return rows;
  // <tr> <th|td>K</th|td> <td>V</td> </tr>
  for (const [rawK, rawV] of pairs(sectionHtml, /<tr\b[^<>]*>\s*<t[hd]\b[^<>]*>/gi, /<\/t[hd]>\s*<td\b[^<>]*>/gi, /<\/td>\s*<\/tr>/gi)) {
    const k = text(rawK).replace(/\s*:\s*$/, '');
    const v = text(rawV);
    if (k && v && k.length <= 70 && v.length <= 300) rows.push([k, v]);
  }
  return rows;
}

function rowsFromDetailBullets(sectionHtml: string | null): Row[] {
  const rows: Row[] = [];
  if (!sectionHtml) return rows;
  // <span class="a-text-bold">K</span> <span>V</span>
  for (const [rawK, rawV] of pairs(sectionHtml, /<span(?=[^<>]*>)[^<>]*class="[^"<>]*a-text-bold[^"<>]*"[^<>]*>/gi, /<\/span>\s*<span[^<>]*>/gi, /<\/span>/gi)) {
    const k = text(rawK).replace(/\s*:\s*$/, '').trim();
    const v = text(rawV);
    if (k && v && k.length <= 70 && v.length <= 300) rows.push([k, v]);
  }
  return rows;
}

const normKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const CONF_RANK: Record<DimConfidence, number> = { high: 30, medium: 20, low: 10 };
const SOURCE_RANK: Record<string, number> = { overview: 4, details: 3, techSpec: 3, jsonld: 4, detailBullets: 2, bullets: 1, description: 1, title: 0 };

function rankCandidate(c: DimensionCandidate): number {
  return CONF_RANK[c.confidence] + (c.terms.length === 3 ? 5 : 0) + (SOURCE_RANK[c.source] ?? 0) - (/^size$/i.test(c.label) ? 6 : 0);
}

function summarize(c: DimensionCandidate): ProductFacts['dimensionCandidates'][number] {
  return { raw: c.raw, meters: c.meters, confidence: c.confidence, label: c.label, source: c.source };
}

// ---------------------------------------------------------------- Amazon

const AMAZON_CURRENCY: Record<string, string> = {
  'co.uk': 'GBP', de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR', ca: 'CAD', 'com.au': 'AUD',
  'co.jp': 'JPY', in: 'INR', 'com.mx': 'MXN', 'com.br': 'BRL', com: 'USD',
};

/** Read an Amazon product page. `ok` is false when there is no product on it (a block page). */
export function extractAmazonProduct(html: string, url = ''): ProductFacts {
  const parsedUrl = parseAmazonUrl(url);
  const warnings: string[] = [];

  // --- title
  let title: string | null = text(elementById(html, 'productTitle') ?? '') || null;
  if (!title) {
    const mt = firstTag(html, /<meta(?=[^<>]*>)[^<>]+name=["']title["'][^<>]*>/i);
    title = (attr(mt, 'content') || '').replace(/^Amazon\.[a-z.]+\s*:\s*/i, '').replace(/\s*:\s*[^:]+$/, '') || null;
  }
  if (!title) {
    const [t] = spans(html, /<title[^<>]*>/gi, /<\/title>/gi, 1);
    const tt = t !== undefined ? text(t).replace(/^Amazon\.[a-z.]+\s*:\s*/i, '') : '';
    if (tt && !/^Amazon\.[a-z.]+$/i.test(tt)) title = tt;
  }

  // Amazon splits long titles: #productTitle holds the name, .dp-title-differentiators the rest.
  const sub = innerAfter(html, /class=["'][^"']*dp-title-differentiators[^"']*["']/gi, /<\/div>/gi, 1500);
  const subtitle = sub !== null ? text(sub) || null : null;

  // --- asin
  const canonical = attr(firstTag(html, /<link(?=[^<>]*>)[^<>]+rel=["']canonical["'][^<>]*>/i), 'href');
  const asin =
    attr(firstTag(html, /<input(?=[^<>]*>)[^<>]+id=["']ASIN["'][^<>]*>/i), 'value') ||
    parseAmazonUrl(canonical || '')?.asin ||
    parsedUrl?.asin ||
    (/data-csa-c-asin="([A-Z0-9]{10})"/.exec(html) || [])[1] ||
    null;

  // --- spec rows, in trust order. First occurrence of a key wins; comparison tables are never
  // read because only these scoped containers are scanned.
  const sections: [string, Row[]][] = [
    ['overview', rowsFromTables(elementById(html, 'productOverview_feature_div'))],
    ['details', rowsFromTables(elementById(html, 'prodDetails') ?? elementById(html, 'productDetails_feature_div'))],
    ['techSpec', rowsFromTables(elementById(html, 'technicalSpecifications_feature_div') ?? elementById(html, 'productDetails_techSpec_section_1'))],
    ['detailBullets', rowsFromDetailBullets(elementById(html, 'detailBullets_feature_div'))],
    ['facts', rowsFromDetailBullets(elementById(html, 'productFactsDesktopExpander'))],
  ];
  const specs: Record<string, string> = {};
  const specRows: { key: string; value: string; source: string }[] = [];
  for (const [source, rows] of sections) {
    for (const [k, v] of rows) {
      const nk = normKey(k);
      if (/customer reviews|best sellers rank|date first available|asin|warranty|feedback/.test(nk)) continue;
      specRows.push({ key: k, value: v, source });
      if (!Object.hasOwn(specs, nk)) specs[nk] = v;
    }
  }
  const spec = (...keys: string[]): string | null => {
    for (const k of keys) if (Object.hasOwn(specs, k) && specs[k]) return specs[k];
    return null;
  };

  // --- bullets ("About this item")
  const fb = elementById(html, 'feature-bullets') ?? elementById(html, 'featurebullets_feature_div') ?? '';
  const bullets = spans(fb, /<li\b[^<>]*>/gi, /<\/li>/gi)
    .map((li) => text(li))
    .filter((b) => b && !/^(›|see more product details|make sure this fits)/i.test(b))
    .slice(0, 12);

  // --- brand
  const byline = text(elementById(html, 'bylineInfo') ?? '');
  let brand = spec('brand', 'brand name') || null;
  if (!brand && byline) {
    brand = byline.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '').trim() || null;
  }
  brand ||= spec('manufacturer');

  // --- price
  let amount: number | null = null;
  const pv =
    attr(firstTag(html, /<input(?=[^<>]*>)[^<>]+id=["']twister-plus-price-data-price["'][^<>]*>/i), 'value') ??
    attr(firstTag(html, /<input(?=[^<>]*>)[^<>]+name=["']priceValue["'][^<>]*>/i), 'value');
  if (pv && Number(pv) > 0) amount = Number(pv);
  const core =
    elementById(html, 'corePriceDisplay_desktop_feature_div') ??
    elementById(html, 'corePrice_feature_div') ??
    elementById(html, 'corePrice_desktop') ??
    '';
  let priceRaw: string | null = null;
  for (const m of core.matchAll(/<span(?=[^<>]*>)[^<>]*class="[^"<>]*(?:a-offscreen|aok-offscreen)[^"<>]*"[^<>]*>([^<]*)<\/span>/gi)) {
    const pm = /([$£€¥₹]|CA\$|A\$|S\$|R\$|MX\$)\s?(\d[\d.,]*)/.exec(text(m[1]));
    if (pm) {
      priceRaw = pm[0];
      break;
    }
  }
  if (!priceRaw) {
    const whole = afterTag(core, /a-price-whole/g, /\s*([\d.,]+)/y);
    const frac = afterTag(core, /a-price-fraction/g, /\s*(\d+)/y);
    const sym = afterTag(core, /a-price-symbol/g, /\s*([^<\s]+)/y);
    if (whole) priceRaw = `${sym ?? ''}${whole.replace(/[.,]$/, '')}${frac ? '.' + frac : ''}`;
  }
  if (amount == null && priceRaw) {
    const n = priceRaw.replace(/[^\d.,]/g, '');
    amount = Number(/,\d{2}$/.test(n) ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, ''));
    if (!Number.isFinite(amount)) amount = null;
  }
  let currency: string | null =
    attr(firstTag(html, /<input(?=[^<>]*>)[^<>]+id=["']attach-currency-of-preference["'][^<>]*>/i), 'value') ||
    (/currencyCode(?:&quot;|")\s*:\s*(?:&quot;|")([A-Z]{3})/.exec(html) || [])[1] ||
    null;
  if (!currency && priceRaw) {
    let host = parsedUrl?.host ?? 'www.amazon.com';
    if (!parsedUrl && canonical) {
      try {
        host = new URL(canonical, 'https://www.amazon.com').hostname;
      } catch {
        /* keep the default */
      }
    }
    currency = AMAZON_CURRENCY[(/amazon\.(.+)$/.exec(host) || [])[1] ?? ''] ?? null;
  }
  const price: ProductPrice | null = amount != null ? { amount, currency, display: priceRaw || `${amount}` } : null;

  // --- color / material / misc
  const twister = (name: string): string | null => {
    const m = afterTag(html, new RegExp(`id=["']inline-twister-expanded-dimension-text-${name}["']`, 'gi'), /([^<]*)/y);
    if (m && text(m)) return text(m);
    // id="variation_…" (at most 600 characters) class="selection" … > value
    const at = within(html, new RegExp(`id=["']variation_${name}["']`, 'gi'), /class=["']selection["']/gi, 600);
    const gt = at === null ? -1 : html.indexOf('>', at);
    if (gt < 0) return null;
    const lt = html.indexOf('<', gt + 1);
    return text(html.slice(gt + 1, lt < 0 ? html.length : lt)) || null;
  };
  const color = spec('color', 'colour', 'color name', 'upholstery color', 'finish color') || twister('color_name') || null;
  const materials: Record<string, string> = {};
  for (const [k, v] of Object.entries(specs)) {
    if (/material|fabric type|finish type/.test(k) && !/care|feature|included/.test(k)) materials[k] = v;
  }
  const material = spec('material', 'material type', 'upholstery fabric type', 'frame material type', 'top material type', 'base material') || null;
  const category = text(elementById(html, 'wayfinding-breadcrumbs_feature_div') ?? '').split(/\s*›\s*/).filter(Boolean);
  const productType =
    (/productType\s*=\s*'([A-Z_]+)'/.exec(html) || /"productType(?:Name)?"\s*:\s*"([A-Z_]+)"/.exec(html) || [])[1] || null;

  // --- dimensions: collect every candidate, keep the most trustworthy
  const candidates: DimensionCandidate[] = [];
  const DIM_KEY = /^(product|item|assembled|overall|package)?\s*dimensions?\b/i;
  for (const r of specRows) {
    if (!DIM_KEY.test(r.key) && !/^size$/i.test(r.key)) continue;
    if (/^package/i.test(r.key)) continue; // box size, not the item
    const p = parseDimensions(r.value, orderHintFromLabel(r.key));
    if (p) candidates.push({ ...p, label: r.key, source: r.source });
  }
  for (const b of bullets) {
    if (!/dimension|size|measur|inch|"\s*[wdhl]\b|\bcm\b/i.test(b)) continue;
    const p = findDimensionsInText(b);
    if (p) candidates.push({ ...p, label: 'bullet', source: 'bullets' });
  }
  const tp = findDimensionsInText(title || '');
  if (tp) candidates.push({ ...tp, label: 'title', source: 'title' });
  // per-axis rows ("Item Width", "Item Height"…) as a last resort
  const axisRow = (re: RegExp): number | null => {
    const r = specRows.find((x) => re.test(x.key));
    if (!r) return null;
    const m = new RegExp(`${NUM}\\s*${UNIT}`, 'i').exec(r.value);
    const u = m && unitOf(m[2]);
    return m && u ? +(toNumber(m[1]) * UNIT_M[u]).toFixed(4) : null;
  };
  const aw = axisRow(/^(item|product|overall)?\s*width$/i);
  const ad = axisRow(/^(item|product|overall)?\s*(depth|length)$/i);
  const ah = axisRow(/^(item|product|overall)?\s*height$/i);
  if (aw && ah && ad) {
    candidates.push({
      raw: 'per-axis rows', terms: [], unit: 'm', labeled: true, confidence: 'medium',
      meters: { w: aw, d: ad, h: ah }, sortedMeters: [aw, ad, ah].sort((a, b) => b - a),
      label: 'Item Width/Depth/Height', source: 'details',
    });
  }
  candidates.sort((a, b) => rankCandidate(b) - rankCandidate(a));
  const dimensions = candidates[0] ?? null;
  if (!dimensions) warnings.push('no-dimensions');
  else if (dimensions.confidence === 'low') warnings.push('dimension-axes-guessed');
  if (dimensions && Object.values(dimensions.meters).some((v) => v != null && (v < 0.01 || v > 6))) {
    warnings.push('dimension-out-of-range');
  }

  // secondary measurements that help the modeller place seats, arms, legs
  const measures: Record<string, number> = {};
  for (const r of specRows) {
    if (!/(seat|arm|leg|back|shade|base|table ?top|clearance|shelf|drawer|mattress|minimum|maximum)\b.*\b(height|depth|width|length|diameter|thickness)|^(minimum|maximum) height$/i.test(r.key)) continue;
    const m = new RegExp(`${NUM}\\s*${UNIT}`, 'i').exec(r.value);
    const u = m && unitOf(m[2]);
    const key = normKey(r.key);
    if (m && u && !Object.hasOwn(measures, key)) measures[key] = +(toNumber(m[1]) * UNIT_M[u]).toFixed(3);
  }
  const wm = /([\d.]+)\s*(pounds?|lbs?|kg|kilograms?|ounces?|oz|g|grams?)\b/i.exec(spec('item weight') || '');
  const weightKg = wm
    ? +(Number(wm[1]) * (/^(pound|lb)/i.test(wm[2]) ? 0.4536 : /^kg|^kilo/i.test(wm[2]) ? 1 : /^(ounce|oz)/i.test(wm[2]) ? 0.02835 : 0.001)).toFixed(2)
    : null;

  // --- images
  const found: { id: string; url: string }[] = [];
  const push = (u: string | null | undefined): void => {
    // eight are used; no real image address is anywhere near 2000 characters
    if (found.length >= 8 || !u || u.length > 2000) return;
    if (!/^https:\/\/[a-z0-9.-]*(media-amazon|ssl-images-amazon)\.com\/images\/I\//i.test(u)) return;
    const id = (/\/images\/I\/([^.]+)\./.exec(u) || [])[1];
    if (id && !found.some((x) => x.id === id)) found.push({ id, url: u });
  };
  const landing =
    firstTag(html, /<img\b(?=[^<>]*>)[^<>]*\bid=["']landingImage["'][^<>]*>/i) ??
    firstTag(html, /<img\b(?=[^<>]*>)[^<>]*\bid=["']imgBlkFront["'][^<>]*>/i);
  push(attr(landing, 'data-old-hires'));
  const dyn = attr(landing, 'data-a-dynamic-image');
  if (dyn) {
    try {
      const sizes = Object.entries(JSON.parse(dyn) as Record<string, [number, number]>);
      sizes.sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1]);
      push(sizes[0]?.[0]);
    } catch {
      /* malformed attribute */
    }
  }
  push(attr(landing, 'src'));
  // gallery: the ImageBlockATF script holds 'colorImages': { 'initial': [...] } for the selected variant
  const gi = html.indexOf("'colorImages'");
  if (gi >= 0) {
    const end = html.indexOf("'colorToAsin'", gi);
    const seg = html.slice(gi, end > gi ? end : gi + 120_000);
    const hi = [...seg.matchAll(/"hiRes":"([^"]+)"/g)].map((m) => m[1]);
    for (const u of hi.length ? hi : [...seg.matchAll(/"large":"([^"]+)"/g)].map((m) => m[1])) push(u);
  }
  push(attr(firstTag(html, /<meta(?=[^<>]*>)[^<>]+property=["']og:image["'][^<>]*>/i), 'content'));
  // the image CDN takes a size modifier; ask for a model-friendly long edge
  const sized = (u: string, px: number): string =>
    u.replace(/\._[^/]*_\.(jpg|jpeg|png|webp)$/i, '.$1').replace(/\.(jpg|jpeg|png|webp)$/i, `._AC_SL${px}_.$1`);
  const images = found.slice(0, 8).map((x) => ({ id: x.id, url: sized(x.url, 1000), thumb: sized(x.url, 300) }));

  if (!title) warnings.push('no-title');
  if (!images.length) warnings.push('no-image');

  return {
    ok: Boolean(title),
    asin,
    url: asin
      ? `https://${(parsedUrl?.host || 'www.amazon.com').replace(/^(m|smile)\./, 'www.')}/dp/${asin}`
      : canonical || url || null,
    title,
    subtitle,
    brand,
    price,
    color,
    material,
    materials,
    category,
    productType,
    bullets,
    description: null,
    dimensions,
    dimensionCandidates: candidates.slice(0, 6).map(summarize),
    measures,
    weightKg,
    images,
    specs,
    warnings,
  };
}

// ---------------------------------------------------------------- any other shop

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

const isObj = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const asList = (v: Json | undefined): Json[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: Json | undefined, max = 300): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = text(v);
  return t ? t.slice(0, max) : null;
};
const typeIs = (o: JsonObject, name: string): boolean => asList(o['@type']).some((t) => typeof t === 'string' && t.toLowerCase() === name);

/** Every schema.org Product object in the page's JSON-LD blocks (searching @graph and nesting). */
function jsonLdProducts(html: string): JsonObject[] {
  const out: JsonObject[] = [];
  const walk = (v: Json, depth: number): void => {
    if (depth > 6 || out.length >= 8) return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 60)) walk(x, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (typeIs(v, 'product') || typeIs(v, 'productgroup')) out.push(v);
    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'hasVariant', 'itemListElement', 'item']) {
      if (key in v) walk(v[key], depth + 1);
    }
  };
  for (const block of spans(html, /<script\b(?=[^<>]*>)[^<>]*type=["']application\/ld\+json["'][^<>]*>/gi, /<\/script>/gi)) {
    if (block.length > 400_000) continue;
    try {
      walk(JSON.parse(block.trim()) as Json, 0);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag =
    firstTag(html, new RegExp(`<meta\\b(?=[^<>]*>)[^<>]*\\b(?:property|name|itemprop)=["']${k}["'][^<>]*>`, 'i'));
  const v = attr(tag, 'content');
  return v ? text(v) || null : null;
}

const UNIT_CODES: Record<string, string> = { CMT: 'cm', MMT: 'mm', MTR: 'm', INH: 'in', FOT: 'ft' };

/** schema.org width/height/depth: a QuantitativeValue, a number, or text like "80 cm". Meters or null. */
function quantityMeters(v: Json | undefined): { m: number; raw: string } | null {
  if (v === undefined || v === null) return null;
  if (isObj(v)) {
    const value = typeof v.value === 'number' ? v.value : typeof v.value === 'string' ? parseFloat(v.value.replace(',', '.')) : NaN;
    const code = typeof v.unitCode === 'string' ? UNIT_CODES[v.unitCode.toUpperCase()] : undefined;
    const unit = code ?? unitOf(typeof v.unitText === 'string' ? v.unitText : null);
    if (Number.isFinite(value) && value > 0 && unit) return { m: +(value * UNIT_M[unit]).toFixed(4), raw: `${value} ${unit}` };
    if (typeof v.value === 'string') return quantityMeters(v.value);
    return null;
  }
  if (typeof v !== 'string') return null;
  const m = new RegExp(`^\\s*${NUM}\\s*${UNIT}\\s*$`, 'i').exec(decodeEntities(v));
  const unit = m && unitOf(m[2]);
  return m && unit ? { m: +(toNumber(m[1]) * UNIT_M[unit]).toFixed(4), raw: v.trim() } : null;
}

function absoluteHttps(u: string | null, base: string): string | null {
  if (!u) return null;
  try {
    const abs = new URL(u, base || undefined);
    if (abs.protocol === 'http:') abs.protocol = 'https:';
    return abs.protocol === 'https:' ? abs.href : null;
  } catch {
    return null;
  }
}

/**
 * Read any shop's product page from its schema.org Product JSON-LD, OpenGraph and
 * meta tags. `ok` is false when the page names no product.
 */
export function extractGenericProduct(html: string, url = ''): ProductFacts {
  const facts = emptyFacts();
  const products = jsonLdProducts(html);
  // prefer the entry that knows the most
  const score = (p: JsonObject): number => ['name', 'offers', 'image', 'brand', 'width', 'height', 'depth', 'description'].filter((k) => k in p).length;
  const ld: JsonObject | null = products.sort((a, b) => score(b) - score(a))[0] ?? null;

  const ogType = metaContent(html, 'og:type');
  const pageTitle = text(spans(html, /<title[^<>]*>/gi, /<\/title>/gi, 1)[0] ?? '') || null;
  const ogTitle = metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title');
  facts.title = (ld && str(ld.name)) || ogTitle || pageTitle;
  if (facts.title) facts.title = facts.title.slice(0, 300);

  // brand
  if (ld) {
    const b = ld.brand ?? ld.manufacturer;
    facts.brand = isObj(b) ? str(b.name, 80) : str(Array.isArray(b) ? (isObj(b[0]) ? b[0].name : b[0]) : b, 80);
  }
  facts.brand ||= metaContent(html, 'product:brand') ?? metaContent(html, 'og:brand');

  // price
  let amount: number | null = null;
  let currency: string | null = null;
  if (ld) {
    for (const o of asList(ld.offers)) {
      if (!isObj(o)) continue;
      const spec0 = asList(o.priceSpecification).find(isObj);
      const raw = o.price ?? o.lowPrice ?? (spec0 ? spec0.price : undefined);
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw.replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')) : NaN;
      if (Number.isFinite(n) && n > 0) {
        amount = n;
        currency = str(o.priceCurrency ?? (spec0 ? spec0.priceCurrency : undefined), 8);
        break;
      }
    }
  }
  if (amount == null) {
    const pa = metaContent(html, 'product:price:amount') ?? metaContent(html, 'og:price:amount');
    const n = pa ? parseFloat(pa.replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')) : NaN;
    if (Number.isFinite(n) && n > 0) {
      amount = n;
      currency = metaContent(html, 'product:price:currency') ?? metaContent(html, 'og:price:currency');
    }
  }
  if (amount != null) {
    const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', JPY: '¥', INR: '₹' };
    const cur = currency && /^[A-Z]{3}$/i.test(currency) ? currency.toUpperCase() : null;
    const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
    facts.price = { amount, currency: cur, display: cur ? (SYMBOL[cur] ? `${SYMBOL[cur]}${shown}` : `${shown} ${cur}`) : shown };
  }

  // color / material / description / category
  if (ld) {
    facts.color = str(ld.color, 80);
    facts.material = str(ld.material, 120);
    facts.description = str(ld.description, 1200);
    const cat = str(ld.category, 200);
    if (cat) facts.category = cat.split(/\s*(?:>|›|\/)\s*/).filter(Boolean).slice(0, 6);
    for (const p of asList(ld.additionalProperty).slice(0, 40)) {
      if (!isObj(p)) continue;
      const k = str(p.name, 70);
      const v = str(p.value, 300);
      if (!k || !v) continue;
      const nk = normKey(k);
      if (!Object.hasOwn(facts.specs, nk)) facts.specs[nk] = v;
      if (/material|fabric|finish/.test(nk)) facts.materials[nk] = v;
      if (/^colou?r$/.test(nk)) facts.color ||= v;
    }
  }
  facts.description ||= metaContent(html, 'og:description') ?? metaContent(html, 'description');
  if (facts.description) facts.description = facts.description.slice(0, 1200);
  facts.color ||= metaContent(html, 'product:color');
  facts.material ||= metaContent(html, 'product:material');
  if (facts.material && !Object.keys(facts.materials).length) facts.materials.material = facts.material;

  // dimensions
  const candidates: DimensionCandidate[] = [];
  if (ld) {
    const w = quantityMeters(ld.width);
    const h = quantityMeters(ld.height);
    const d = quantityMeters(ld.depth);
    if (w && h && d) {
      candidates.push({
        raw: `${w.raw} W x ${d.raw} D x ${h.raw} H`, terms: [], unit: 'm', labeled: true, confidence: 'high',
        meters: { w: w.m, d: d.m, h: h.m }, sortedMeters: [w.m, d.m, h.m].sort((a, b) => b - a),
        label: 'width / depth / height', source: 'jsonld',
      });
    }
    for (const [k, v] of Object.entries(facts.specs)) {
      if (!/dimension|size|measure/.test(k)) continue;
      if (/package|shipping|box/.test(k)) continue;
      const p = parseDimensions(v, orderHintFromLabel(k)) ?? findDimensionsInText(v);
      if (p) candidates.push({ ...p, label: k, source: 'details' });
    }
  }
  const dp = findDimensionsInText(facts.description);
  if (dp) candidates.push({ ...dp, label: 'description', source: 'description' });
  const tp = findDimensionsInText(facts.title);
  if (tp) candidates.push({ ...tp, label: 'title', source: 'title' });
  candidates.sort((a, b) => rankCandidate(b) - rankCandidate(a));
  facts.dimensions = candidates[0] ?? null;
  facts.dimensionCandidates = candidates.slice(0, 6).map(summarize);

  // images
  const urls: string[] = [];
  const pushImg = (v: Json | undefined): void => {
    for (const x of asList(v).slice(0, 12)) {
      const raw = isObj(x) ? str(x.url ?? x.contentUrl, 600) : typeof x === 'string' ? x.trim().slice(0, 600) : null;
      const abs = absoluteHttps(raw, url);
      if (abs && !urls.includes(abs)) urls.push(abs);
    }
  };
  if (ld) pushImg(ld.image);
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) pushImg(metaContent(html, key));
  facts.images = urls.slice(0, 6).map((u, i) => ({ id: `img${i}`, url: u, thumb: u }));

  const canonical = absoluteHttps(attr(firstTag(html, /<link(?=[^<>]*>)[^<>]+rel=["']canonical["'][^<>]*>/i), 'href') ?? metaContent(html, 'og:url'), url);
  facts.url = canonical ?? (url || null);
  // A page counts as a product when it says so (JSON-LD Product, og:type product) or prices something.
  const saysProduct = !!ld || /product/i.test(ogType ?? '') || facts.price != null;
  facts.ok = Boolean(facts.title) && saysProduct;
  if (!facts.title) facts.warnings.push('no-title');
  if (!saysProduct) facts.warnings.push('not-a-product-page');
  if (!facts.dimensions) facts.warnings.push('no-dimensions');
  else if (facts.dimensions.confidence === 'low') facts.warnings.push('dimension-axes-guessed');
  if (!facts.images.length) facts.warnings.push('no-image');
  return facts;
}
