/**
 * The built-in drafter's front desk: one call that turns a brief into a set
 * of options, whichever way the footprint is decided —
 *
 *  - an outline the person drew: the rooms are fitted inside it, in place;
 *  - a preset the wing-recipe engine knows (rectangle, bar, L, T, U, C);
 *  - a preset drawn as an outline and filled (offset, H, cross, stepped);
 *  - "any": the best of every footprint, one of each before two of any.
 *
 * Options are chosen to differ in ways you can see at thumbnail size, and
 * named for what sets each apart. Pure — no store, no DOM.
 */
import { auditLayout, bounds } from './audit';
import { targetArea, type Brief, type ShapeId } from './brief';
import { factKey, factsOf, nameOptions } from './describe';
import { fillMask } from './fill';
import type { Layout, LayoutLink, LayoutRoom, RoomType } from './layout';
import type { Outline, Rect } from './outline';
import { generateProcedural, TITLES, type Recipe } from './procedural';
import { presetOutlines, type PresetShape } from './shapes';

export interface Draft {
  /** Titled and summarised. */
  layout: Layout;
  /** lower is better */
  penalty: number;
  /** Wing-recipe engine: how to make more like it. */
  recipe?: Recipe;
  /** Filled footprint: the rectangles it was fitted into (for "more like this"). */
  mask?: Rect[];
  /** Fitted into the person's own outline: coordinates must be kept as they are. */
  inPlace?: boolean;
  /** Which family of footprint it is — two drafts of different families are different ideas. */
  shape: string;
}

export interface DraftLike {
  layout: Layout;
  recipe?: Recipe;
  mask?: Rect[];
  inPlace?: boolean;
  shape?: string;
}

export interface DraftOptions {
  /** How many options (default 5). */
  count?: number;
  /** 0 = the canonical set; other values give a different one. */
  seed?: number;
  /** Fit the rooms into this outline, where it stands. */
  outline?: Outline | null;
  /** Re-plan `mask` around rooms that stay exactly where they are. */
  keep?: { mask: Rect[]; rooms: LayoutRoom[]; links: LayoutLink[]; taken: RoomType[] };
  /** Variations of this option. */
  like?: DraftLike;
}

export interface DraftResult {
  options: Draft[];
  /** One quiet line: what had to give. */
  note: string | null;
  /** Asked-for rooms left out of every option. */
  dropped: string[];
}

const FILL_SHAPES: readonly PresetShape[] = ['Z', 'step', 'plus', 'H'];
const isFillShape = (s: ShapeId): s is PresetShape => (FILL_SHAPES as readonly string[]).includes(s);

const LEADS: Record<string, [string, string]> = {
  Z: ['Offset bars', 'Two bars slid past each other.'],
  H: ['Two wings and a link', 'Two parallel wings joined across the middle, a court on each side.'],
  plus: ['Cross plan', 'A long bar with a wing reaching out front and back from its middle.'],
  step: ['Stepped plan', 'Three bays, each deeper than the last, stepping back along one side.'],
};

/* ------------------------------------------------------------------ */
/* Moving a finished layout around                                      */
/* ------------------------------------------------------------------ */

type Move = (r: Rect) => Rect;
const flipX: Move = (r) => ({ ...r, x: -(r.x + r.w) });
const flipY: Move = (r) => ({ ...r, y: -(r.y + r.h) });
const quarter: Move = (r) => ({ x: r.y, y: r.x, w: r.h, h: r.w });

function moved(d: Draft, move: Move): Draft {
  return {
    ...d,
    layout: { ...d.layout, rooms: d.layout.rooms.map((r) => ({ ...r, ...move(r) })) },
    ...(d.mask ? { mask: d.mask.map(move) } : {}),
  };
}

function alike(a: Layout, b: Layout): boolean {
  const pos = new Map(a.rooms.map((r) => [r.name, r]));
  let off = 0;
  for (const r of b.rooms) {
    const o = pos.get(r.name);
    if (!o || Math.abs(o.x - r.x) + Math.abs(o.y - r.y) + Math.abs(o.w - r.w) + Math.abs(o.h - r.h) > 1.01) off++;
  }
  return off < Math.max(3, b.rooms.length * 0.4);
}

/* ------------------------------------------------------------------ */
/* Picking the options that differ                                      */
/* ------------------------------------------------------------------ */

function pickDiverse(pool: Draft[], count: number): Draft[] {
  if (pool.length <= 1) return pool.slice(0, count);
  const sorted = pool.slice().sort((a, b) => a.penalty - b.penalty);
  const feats = sorted.map((d) => ({ box: bounds(d.layout.rooms), key: factKey(factsOf(d.layout)), shape: d.shape }));
  const dist = (i: number, j: number): number => {
    const a = feats[i];
    const b = feats[j];
    let d = a.shape !== b.shape ? 3 : 0;
    if (Math.abs(a.box.w - b.box.w) + Math.abs(a.box.h - b.box.h) >= 2) d += 1;
    for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) d += 1;
    return d;
  };
  const best = sorted[0].penalty;
  const picked = [0];
  while (picked.length < count) {
    let pick = -1;
    let top = -Infinity;
    for (let i = 1; i < sorted.length; i++) {
      if (picked.includes(i) || sorted[i].penalty > best + 26) continue;
      const near = Math.min(...picked.map((p) => dist(i, p)));
      if (near < 1) continue;
      // Difference first, but not at any price.
      const score = Math.min(near, 4) - (sorted[i].penalty - best) / 9;
      if (score > top) {
        top = score;
        pick = i;
      }
    }
    if (pick < 0) break;
    picked.push(pick);
  }
  // Still short: anything that isn't a repeat.
  for (let i = 1; i < sorted.length && picked.length < count; i++) {
    if (picked.includes(i) || sorted[i].penalty > best + 26) continue;
    if (picked.some((p) => alike(sorted[p].layout, sorted[i].layout))) continue;
    picked.push(i);
  }
  return picked.map((i) => sorted[i]);
}

/** Title every option for what distinguishes it. */
function named(drafts: Draft[], lead: (d: Draft) => [string, string] | undefined): Draft[] {
  const names = nameOptions(
    drafts.map((d) => {
      const l = lead(d);
      return { layout: d.layout, lead: l?.[0], leadSummary: l?.[1] };
    }),
  );
  return drafts.map((d, i) => ({ ...d, layout: { ...d.layout, title: names[i].title, summary: names[i].summary } }));
}

const leadOf = (d: Draft): [string, string] | undefined =>
  d.inPlace ? undefined : d.recipe ? TITLES[d.recipe.scheme] : LEADS[d.shape];

/* ------------------------------------------------------------------ */
/* Footprints that are filled                                           */
/* ------------------------------------------------------------------ */

/** Options for one preset shape drawn as an outline and filled, front door turned to the street. */
function presetDrafts(shape: PresetShape, brief: Brief, seed: number, each: number): { drafts: Draft[]; dropped: string[] } {
  const lotArea = brief.lot ? brief.lot.w * brief.lot.d * 0.9 : Infinity;
  const area = Math.min(targetArea(brief) * (brief.area ? 1 : 1.04), lotArea);
  const drafts: Draft[] = [];
  let dropped: string[] | null = null;
  for (const preset of presetOutlines(shape, area)) {
    let turnIt = false;
    if (brief.lot) {
      const fits = (w: number, h: number) => w <= brief.lot!.w + 1e-6 && h <= brief.lot!.d + 1e-6;
      if (!fits(preset.box.w, preset.box.h)) {
        if (!fits(preset.box.h, preset.box.w)) continue;
        turnIt = true;
      }
    }
    const rects = turnIt ? preset.rects.map(quarter) : preset.rects;
    const res = fillMask(rects, brief, { count: each, seed });
    if (res.options.length === 0 || res.options[0].penalty >= 900) continue;
    if (dropped === null || res.dropped.length < dropped.length) dropped = res.dropped;
    for (const o of res.options) {
      let d: Draft = { layout: o.layout, penalty: o.penalty + res.dropped.length * 12, mask: rects, shape };
      if (auditLayout(d.layout).entrance?.side === 'N') d = moved(d, flipY);
      drafts.push(d);
    }
  }
  return { drafts, dropped: dropped ?? [] };
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

export function draftOptions(brief: Brief, opts: DraftOptions = {}): DraftResult {
  const count = opts.count ?? 5;
  const seed = opts.seed ?? 0;
  const like = opts.like;

  // Inside an outline (the person's own, or the footprint of the option being varied).
  const mask = opts.keep ? opts.keep.mask : opts.outline ? opts.outline.rects : like?.mask;
  if (mask) {
    const inPlace = opts.keep || opts.outline ? true : !!like?.inPlace;
    const res = fillMask(mask, brief, {
      count: count + (like ? 1 : 0),
      seed,
      fixed: opts.keep?.rooms,
      fixedLinks: opts.keep?.links,
      taken: opts.keep?.taken,
    });
    let drafts: Draft[] = res.options.map((o) => ({
      layout: o.layout,
      penalty: o.penalty,
      mask: mask.slice(),
      inPlace,
      shape: opts.keep ? 'keep' : like?.shape ?? 'outline',
    }));
    if (like) drafts = drafts.filter((d) => !sameRooms(d.layout, like.layout)).slice(0, count);
    return { options: named(drafts, leadOf), note: res.note, dropped: res.dropped };
  }

  // Variations of a wing-recipe option.
  if (like?.recipe) {
    const res = generateProcedural(brief, { count, seed, like: like.recipe });
    const drafts: Draft[] = res.options.map((o) => ({ layout: o.layout, penalty: o.penalty, recipe: o.recipe, shape: o.recipe.scheme }));
    return { options: named(drafts, () => undefined), note: res.note, dropped: [] };
  }

  const pool: Draft[] = [];
  let note: string | null = null;
  let dropped: string[] = [];
  let shape = brief.shape;

  if (isFillShape(shape)) {
    const res = presetDrafts(shape, brief, seed, count);
    pool.push(...res.drafts);
    dropped = res.dropped;
    if (pool.length === 0) {
      // Too small (or the lot too tight) for this shape: show the closest plans instead.
      note = 'That shape doesn’t suit these rooms — showing the closest plans.';
      shape = 'any';
    } else if (dropped.length) {
      note = `Too small for everything — left out: ${dropped.map((n) => n.toLowerCase()).join(', ')}.`;
    }
  }
  if (!isFillShape(shape)) {
    const res = generateProcedural({ ...brief, shape }, { count: 40, seed, pool: true });
    note = note ?? res.note;
    for (const o of res.options) pool.push({ layout: o.layout, penalty: o.penalty, recipe: o.recipe, shape: o.recipe.scheme });
    if (shape === 'any') {
      // The filled footprints join in when they suit the brief about as well.
      const best = pool.length ? Math.min(...pool.map((d) => d.penalty)) : 0;
      for (const s of FILL_SHAPES) {
        const res2 = presetDrafts(s, brief, seed, 2);
        if (res2.dropped.length) continue;
        for (const d of res2.drafts) if (d.penalty <= best + 22) pool.push({ ...d, penalty: d.penalty + 2 });
      }
    }
  }
  if (pool.length === 0) {
    return { options: [], note: note ?? 'Couldn’t lay these rooms out — try fewer rooms or a larger size.', dropped };
  }

  let picked = pickDiverse(pool, count);
  // Alternate handedness so neighbouring cards read differently…
  picked = picked.map((d, i) => {
    if ((seed + i) % 2 === 0) return d;
    const m = moved(d, flipX);
    return m.recipe ? { ...m, recipe: { ...m.recipe, mirror: true } } : m;
  });
  // …and if the set is still short, a mirror image is better than an empty slot.
  for (const d of picked.slice()) {
    if (picked.length >= count) break;
    const m = moved(d, flipX);
    picked.push(m.recipe ? { ...m, recipe: { ...m.recipe, mirror: !m.recipe.mirror } } : m);
  }
  return { options: named(picked, leadOf), note, dropped };
}

function sameRooms(a: Layout, b: Layout): boolean {
  if (a.rooms.length !== b.rooms.length) return false;
  const pos = new Map(b.rooms.map((r) => [r.name, r]));
  return a.rooms.every((r) => {
    const o = pos.get(r.name);
    return !!o && Math.abs(o.x - r.x) + Math.abs(o.y - r.y) + Math.abs(o.w - r.w) + Math.abs(o.h - r.h) < 0.01;
  });
}
