/**
 * The brief: what the person asked for, in plain data, and the room program
 * (names, types, target sizes) it implies. Pure — no store, no DOM.
 */
import type { RoomType } from './layout';

export type ShapeId = 'any' | 'rect' | 'L' | 'U' | 'T' | 'C' | 'bar' | 'Z' | 'H' | 'plus' | 'step';

export const SHAPES: readonly { id: ShapeId; label: string }[] = [
  { id: 'any', label: 'Any shape' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'bar', label: 'Long bar' },
  { id: 'L', label: 'L shape' },
  { id: 'T', label: 'T shape' },
  { id: 'U', label: 'U shape' },
  { id: 'C', label: 'Courtyard (C)' },
  { id: 'Z', label: 'Offset (Z)' },
  { id: 'H', label: 'H shape' },
  { id: 'plus', label: 'Cross' },
  { id: 'step', label: 'Stepped' },
];

export type SpaceId =
  | 'kitchen'
  | 'living'
  | 'dining'
  | 'primary'
  | 'office'
  | 'entry'
  | 'laundry'
  | 'pantry'
  | 'garage';

export const SPACES: readonly { id: SpaceId; label: string; hint?: string }[] = [
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'living', label: 'Living' },
  { id: 'dining', label: 'Dining' },
  { id: 'primary', label: 'Primary suite', hint: 'One bedroom becomes a larger primary with its own bath' },
  { id: 'office', label: 'Office' },
  { id: 'entry', label: 'Entry' },
  { id: 'laundry', label: 'Laundry' },
  { id: 'pantry', label: 'Pantry' },
  { id: 'garage', label: 'Garage' },
];

export interface Brief {
  bedrooms: number;
  bathrooms: number;
  spaces: Record<SpaceId, boolean>;
  /** Target floor area in m²; null = any size. */
  area: number | null;
  shape: ShapeId;
  /** Buildable lot the house must fit inside (m): w along the street (x), d deep (y). */
  lot: { w: number; d: number } | null;
  /** Free-text wishes. */
  wishes: string;
}

export const MAX_BEDROOMS = 6;
export const MAX_BATHROOMS = 4;
export const MIN_AREA = 25;
export const MAX_AREA = 600;

export function defaultBrief(): Brief {
  return {
    bedrooms: 3,
    bathrooms: 2,
    spaces: {
      kitchen: true,
      living: true,
      dining: true,
      primary: false,
      office: false,
      entry: false,
      laundry: false,
      pantry: false,
      garage: false,
    },
    area: null,
    shape: 'any',
    lot: null,
    wishes: '',
  };
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

/** Validate anything brief-shaped (localStorage, a patch from text) into a clean Brief. */
export function sanitizeBrief(raw: unknown): Brief {
  const d = defaultBrief();
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const spaces = { ...d.spaces };
  if (typeof r.spaces === 'object' && r.spaces !== null) {
    for (const s of SPACES) {
      const v = (r.spaces as Record<string, unknown>)[s.id];
      if (typeof v === 'boolean') spaces[s.id] = v;
    }
  }
  // A house needs somewhere to walk into.
  if (!spaces.kitchen && !spaces.living && !spaces.dining) spaces.living = true;
  const area =
    typeof r.area === 'number' && Number.isFinite(r.area) && r.area > 0
      ? Math.min(MAX_AREA, Math.max(MIN_AREA, r.area))
      : null;
  let lot: Brief['lot'] = null;
  if (typeof r.lot === 'object' && r.lot !== null) {
    const l = r.lot as Record<string, unknown>;
    if (
      typeof l.w === 'number' && typeof l.d === 'number' &&
      Number.isFinite(l.w) && Number.isFinite(l.d) && l.w >= 3 && l.d >= 3
    ) {
      lot = { w: Math.min(200, l.w), d: Math.min(200, l.d) };
    }
  }
  return {
    bedrooms: clampInt(r.bedrooms, 0, MAX_BEDROOMS, d.bedrooms),
    bathrooms: clampInt(r.bathrooms, 1, MAX_BATHROOMS, d.bathrooms),
    spaces,
    area,
    shape: SHAPES.some((s) => s.id === r.shape) ? (r.shape as ShapeId) : 'any',
    lot,
    wishes: typeof r.wishes === 'string' ? r.wishes.slice(0, 300) : '',
  };
}

/* ------------------------------------------------------------------ */
/* Room program                                                        */
/* ------------------------------------------------------------------ */

export type Zone = 'public' | 'private';

export interface ProgramRoom {
  name: string;
  type: RoomType;
  /** m² — what the generator aims for (scaled to the target area). */
  area: number;
  /** m² — smallest and largest that still reads as this room. */
  min: number;
  max: number;
  zone: Zone;
  /** For a primary bath: the bedroom it belongs to. */
  ensuiteOf?: string;
}

/** True when the brief yields a primary bedroom with its own bath. */
export function hasEnsuite(brief: Brief): boolean {
  return brief.spaces.primary && brief.bedrooms >= 1 && brief.bathrooms >= 2;
}

/** The rooms a brief asks for, at their ideal sizes. Circulation is added by the generator. */
export function roomProgram(brief: Brief): ProgramRoom[] {
  const rooms: ProgramRoom[] = [];
  const beds = brief.bedrooms;
  const sp = brief.spaces;
  const add = (
    name: string, type: RoomType, area: number, min: number, max: number, zone: Zone, ensuiteOf?: string,
  ) => rooms.push({ name, type, area, min, max, zone, ...(ensuiteOf ? { ensuiteOf } : {}) });

  if (sp.entry) add('Entry', 'entry', 5, 3, 9, 'public');
  if (sp.living) add('Living', 'living', Math.min(34, 18 + 2.5 * beds), 12, 48, 'public');
  if (sp.dining) add('Dining', 'dining', Math.min(16, 8.5 + beds), 7, 22, 'public');
  if (sp.kitchen) add('Kitchen', 'kitchen', Math.min(16, 9.5 + beds), 7, 24, 'public');
  if (sp.pantry) add('Pantry', 'pantry', 3, 2, 5, 'public');
  if (sp.laundry) add('Laundry', 'laundry', 5, 3, 8, 'public');
  if (sp.office) add('Office', 'office', 9.5, 6, 16, 'public');
  if (sp.garage) add('Garage', 'garage', beds >= 4 ? 36 : 21, 18, 42, 'public');

  const ensuite = hasEnsuite(brief);
  let sharedBaths = brief.bathrooms;
  let plain = beds;
  if (sp.primary && beds >= 1) {
    add('Primary bedroom', 'primary_bedroom', 16.5, 12, 28, 'private');
    plain -= 1;
    if (ensuite) {
      add('Primary bath', 'primary_bath', 6, 4, 11, 'private', 'Primary bedroom');
      sharedBaths -= 1;
    }
  }
  for (let i = 1; i <= plain; i++) {
    add(plain === 1 && !sp.primary ? 'Bedroom' : `Bedroom ${sp.primary ? i + 1 : i}`, 'bedroom', 12, 8, 19, 'private');
  }
  for (let i = 1; i <= sharedBaths; i++) {
    add(sharedBaths === 1 ? 'Bathroom' : `Bathroom ${i}`, 'bathroom', 5, 3.5, 8.5, 'private');
  }
  return rooms;
}

/** Rough hall area a program needs (m²). */
export function hallAllowance(rooms: ProgramRoom[]): number {
  const priv = rooms.filter((r) => r.zone === 'private');
  if (priv.length < 3) return 0;
  const a = priv.reduce((s, r) => s + r.area, 0);
  return Math.max(4, Math.round(a / 7));
}

export interface AreaNeed {
  /** m² below which rooms get uncomfortably small */ min: number;
  /** m² at ideal room sizes */ ideal: number;
}

export function areaNeed(brief: Brief): AreaNeed {
  const rooms = roomProgram(brief);
  const hall = hallAllowance(rooms);
  return {
    min: Math.ceil(rooms.reduce((s, r) => s + r.min, 0) + hall * 0.8),
    ideal: Math.round(rooms.reduce((s, r) => s + r.area, 0) + hall),
  };
}

export type Fit = 'tight' | 'good' | 'roomy';

/** How the target area sits against what the rooms need. Null when the size is "any". */
export function fitOf(brief: Brief): Fit | null {
  if (brief.area === null) return null;
  const ratio = brief.area / areaNeed(brief).ideal;
  return ratio < 0.82 ? 'tight' : ratio > 1.28 ? 'roomy' : 'good';
}

export const FIT_LABEL: Record<Fit, string> = { tight: 'tight', good: 'good fit', roomy: 'roomy' };

/** The floor area a generator should aim for. */
export function targetArea(brief: Brief): number {
  return brief.area ?? areaNeed(brief).ideal;
}

/**
 * Scale the program so room areas plus `reserve` (halls) add up to `total`.
 * Small rooms stop growing at their max; the surplus goes to the others.
 */
export function scaleProgram(rooms: ProgramRoom[], total: number, reserve = 0): ProgramRoom[] {
  const out = rooms.map((r) => ({ ...r }));
  const budget = Math.max(total - reserve, 1);
  const fixed = new Set<number>();
  for (let pass = 0; pass < 4; pass++) {
    const fixedSum = out.reduce((s, r, i) => (fixed.has(i) ? s + r.area : s), 0);
    const freeIdeal = rooms.reduce((s, r, i) => (fixed.has(i) ? s : s + r.area), 0);
    if (freeIdeal <= 0) break;
    const k = (budget - fixedSum) / freeIdeal;
    let changed = false;
    out.forEach((r, i) => {
      if (fixed.has(i)) return;
      const want = rooms[i].area * k;
      if (want > r.max) {
        r.area = r.max;
        fixed.add(i);
        changed = true;
      } else if (want < r.min * 0.85) {
        r.area = r.min * 0.85;
        fixed.add(i);
        changed = true;
      } else r.area = want;
    });
    if (!changed) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading a brief out of a sentence                                   */
/* ------------------------------------------------------------------ */

const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, single: 1, double: 2,
};
const NUM = String.raw`(\d+(?:\.\d+)?|one|two|three|four|five|six|a|an|single|double)`;

function num(s: string): number {
  return s.toLowerCase() in WORD_NUM ? WORD_NUM[s.toLowerCase()] : parseFloat(s);
}

const M2_PER_FT2 = 0.09290304;
const M_PER_FT = 0.3048;

export interface ParsedText {
  /** Only the fields the text clearly states. */
  patch: Partial<Omit<Brief, 'spaces'>> & { spaces?: Partial<Record<SpaceId, boolean>> };
  /** The text asks for more than one floor (not supported). */
  multiStorey: boolean;
}

export function mentionsMultiStorey(text: string): boolean {
  return /\b(?:(?:two|three|2|3|multi|double|second|split)[\s-]*(?:stor(?:e?y|ies|eys)|floors?|levels?)|upstairs|duplex|first floor and)\b/i.test(
    text,
  );
}

/** Pull counts, size, shape, spaces and lot out of text like "3 bed 2 bath, 1,800 sq ft, L-shaped, with an office". */
export function parseBriefText(text: string): ParsedText {
  const patch: ParsedText['patch'] = {};
  const spaces: Partial<Record<SpaceId, boolean>> = {};
  const t = text.replace(/[’′]/g, "'");
  let m: RegExpMatchArray | null;

  if ((m = t.match(new RegExp(String.raw`\b${NUM}[\s-]*(?:bed(?:room)?s?|br|bd|bdrm)\b`, 'i')))) {
    patch.bedrooms = Math.min(MAX_BEDROOMS, Math.max(0, Math.round(num(m[1]))));
  } else if (/\bstudio\b/i.test(t)) {
    patch.bedrooms = 0;
  }
  if ((m = t.match(new RegExp(String.raw`\b${NUM}[\s-]*(?:bath(?:room)?s?|ba)\b`, 'i')))) {
    patch.bathrooms = Math.min(MAX_BATHROOMS, Math.max(1, Math.ceil(num(m[1]))));
  }

  let area: number | null = null;
  if ((m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*ft\.?|sqft|ft2|ft²|square\s*f(?:ee|oo)t|sf)(?![a-z])/i))) {
    area = parseFloat(m[1].replace(/,/g, '')) * M2_PER_FT2;
  } else if ((m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:m2|m²|sqm|sq\.?\s*m\.?|square\s*met(?:er|re)s?)(?![a-z])/i))) {
    area = parseFloat(m[1].replace(/,/g, ''));
  }
  if (area !== null && Number.isFinite(area) && area >= 10) {
    patch.area = Math.min(MAX_AREA, Math.max(MIN_AREA, area));
  }

  if (/\bL[\s-]?shaped?\b/.test(t)) patch.shape = 'L';
  else if (/\bU[\s-]?shaped?\b/.test(t)) patch.shape = 'U';
  else if (/\bT[\s-]?shaped?\b/.test(t)) patch.shape = 'T';
  else if (/\bH[\s-]?shaped?\b/.test(t)) patch.shape = 'H';
  else if (/\b[ZS][\s-]?shaped?\b|\boffset\s+(?:plan|bars?|wings?|house)\b/.test(t)) patch.shape = 'Z';
  else if (/\b(?:cross|plus|cruciform)[\s-]?(?:shaped?|plan)\b|\bcruciform\b/i.test(t)) patch.shape = 'plus';
  else if (/\bstepped\b|\bstaggered\b/i.test(t)) patch.shape = 'step';
  else if (/\bC[\s-]?shaped?\b|\bcourtyard\b/i.test(t)) patch.shape = 'C';
  else if (/\blong\s+(?:bar|and\s+narrow|house)\b|\bshotgun\b|\blonghouse\b/i.test(t)) patch.shape = 'bar';
  else if (/\brectang\w*|\bsquare\s+(?:plan|house|footprint)|\bsimple\s+box\b/i.test(t)) patch.shape = 'rect';

  if (/\b(?:home\s+)?office\b|\bstudy\b/i.test(t)) spaces.office = true;
  if (/\bgarage\b|\bcarport\b/i.test(t)) spaces.garage = true;
  if (/\blaundry\b|\butility\s+room\b/i.test(t)) spaces.laundry = true;
  if (/\bpantry\b/i.test(t)) spaces.pantry = true;
  if (/\b(?:entry|foyer|mud\s?room|vestibule)\b/i.test(t)) spaces.entry = true;
  if (/\b(?:primary|master|main)\s+(?:suite|bed(?:room)?|bath)|\ben[\s-]?suite\b/i.test(t)) spaces.primary = true;
  if (/\bno\s+dining\b/i.test(t)) spaces.dining = false;
  if (Object.keys(spaces).length) patch.spaces = spaces;

  // "12 x 30 m lot", "40' by 100' lot", "lot 15x25"
  const LOT = String.raw`(\d+(?:\.\d+)?)\s*(m|ft|')?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(m|ft|')?`;
  m = t.match(new RegExp(String.raw`${LOT}\s*(?:lot|plot|site|block)`, 'i')) ??
    t.match(new RegExp(String.raw`(?:lot|plot|site|block)\s*(?:of|is|:)?\s*${LOT}`, 'i'));
  if (m) {
    const unit = (m[4] ?? m[2] ?? 'm').toLowerCase();
    const k = unit === 'm' ? 1 : M_PER_FT;
    const w = parseFloat(m[1]) * k;
    const d = parseFloat(m[3]) * k;
    if (w >= 3 && d >= 3 && w <= 200 && d <= 200) patch.lot = { w, d };
  }

  return { patch, multiStorey: mentionsMultiStorey(t) };
}

/** Merge a parsed patch into a brief. */
export function applyPatch(brief: Brief, patch: ParsedText['patch']): Brief {
  return sanitizeBrief({ ...brief, ...patch, spaces: { ...brief.spaces, ...(patch.spaces ?? {}) } });
}

/** "3 bed · 2 bath" */
export function briefCounts(brief: Brief): string {
  const b = brief.bedrooms === 0 ? 'Studio' : `${brief.bedrooms} bed`;
  return `${b} · ${brief.bathrooms} bath`;
}
