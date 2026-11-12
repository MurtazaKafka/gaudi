/**
 * Naming options for what sets them apart. Each layout is read for a few
 * plain facts — where the bedrooms are, where the kitchen sits, how the
 * living room faces — and each option in a set takes the fact fewest of the
 * others share. Pure.
 */
import { bounds, exposure } from './audit';
import type { Layout, LayoutRoom } from './layout';
import { cellsFromRects, largestFirst, type Rect } from './outline';

export interface Facts {
  /** Where the bedrooms are: "Bedrooms in the long wing". */
  beds: string | null;
  kitchen: string | null;
  living: string | null;
  hall: string | null;
  /** The outline's proportions: "Wide and shallow". */
  form: string;
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (p: { x: number; y: number }, r: Rect) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

/** The footprint's wings: its largest rectangles, ignoring scraps. */
function wingsOf(rooms: readonly LayoutRoom[]): Rect[] {
  const total = rooms.reduce((s, r) => s + r.w * r.h, 0);
  return largestFirst(cellsFromRects(rooms)).filter((w) => w.w * w.h >= total * 0.12);
}

const SIDE_WORD = { N: 'back', S: 'front', E: 'east', W: 'west' } as const;

function sideOf(dx: number, dy: number): 'N' | 'S' | 'E' | 'W' {
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : dy > 0 ? 'S' : 'N';
}

const place = (side: 'N' | 'S' | 'E' | 'W') => (side === 'N' || side === 'S' ? `at the ${SIDE_WORD[side]}` : `to the ${SIDE_WORD[side]}`);

export function factsOf(layout: Layout): Facts {
  const rooms = layout.rooms;
  const box = bounds(rooms);
  const mid = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const of = (...types: string[]) => rooms.filter((r) => types.includes(r.type));
  const biggest = (list: LayoutRoom[]) => list.slice().sort((p, q) => q.w * q.h - p.w * p.h)[0];
  const beds = of('bedroom', 'primary_bedroom');
  const living = biggest(of('living')) ?? biggest(of('dining', 'kitchen'));
  const kitchen = biggest(of('kitchen'));
  const halls = of('hall');
  const wings = wingsOf(rooms);
  const wingOf = (r: LayoutRoom) => wings.findIndex((w) => inside(centre(r), w));
  const word = beds.length === 1 ? 'Bedroom' : 'Bedrooms';

  let bedFact: string | null = null;
  if (beds.length > 0 && living) {
    const lc = centre(living);
    const bedWings = new Set(beds.map(wingOf));
    const livingWing = wingOf(living);
    if (wings.length >= 2 && bedWings.size === 1 && !bedWings.has(-1) && !bedWings.has(livingWing)) {
      const w = wings[[...bedWings][0]];
      const lengths = wings.map((o) => Math.max(o.w, o.h));
      const len = Math.max(w.w, w.h);
      const longest = lengths.every((l) => l <= len + 1e-6) && lengths.filter((l) => Math.abs(l - len) < 0.75).length === 1;
      const shortest = lengths.every((l) => l >= len - 1e-6) && lengths.filter((l) => Math.abs(l - len) < 0.75).length === 1;
      const wc = centre(w);
      bedFact = longest
        ? `${word} in the long wing`
        : shortest
          ? `${word} in the short wing`
          : `${word} in the ${{ N: 'north', S: 'south', E: 'east', W: 'west' }[sideOf(wc.x - mid.x, wc.y - mid.y)]} wing`;
    } else if (wings.length >= 2 && bedWings.size >= 2 && beds.length >= 2) {
      const primary = beds.find((b) => b.type === 'primary_bedroom');
      const alone = primary && beds.every((b) => b === primary || wingOf(b) !== wingOf(primary));
      bedFact = alone ? 'Main bedroom in its own wing' : `${word} in two wings`;
    } else {
      const west = beds.filter((b) => centre(b).x < living.x + 1e-6).length;
      const east = beds.filter((b) => centre(b).x > living.x + living.w - 1e-6).length;
      const north = beds.filter((b) => centre(b).y < living.y + 1e-6).length;
      const south = beds.filter((b) => centre(b).y > living.y + living.h - 1e-6).length;
      if (west > 0 && east > 0 && west + east === beds.length) bedFact = `${word} at both ends`;
      else if (north > 0 && south > 0 && north + south === beds.length) bedFact = `${word} front and back`;
      else {
        const bx = beds.reduce((s, b) => s + centre(b).x, 0) / beds.length;
        const by = beds.reduce((s, b) => s + centre(b).y, 0) / beds.length;
        bedFact = `${word} ${place(sideOf((bx - lc.x) / Math.max(box.w, 1), (by - lc.y) / Math.max(box.h, 1)))}`;
      }
    }
  }

  const outsideSides = (r: LayoutRoom) => {
    const e = exposure(r, rooms);
    return (['S', 'N', 'E', 'W'] as const).filter((s) => e[s] >= 1.5);
  };
  let kitchenFact: string | null = null;
  if (kitchen) {
    const sides = outsideSides(kitchen);
    kitchenFact =
      sides.length === 0
        ? 'Kitchen in the middle'
        : sides.length >= 2 && !(sides.includes('N') && sides.includes('S') && sides.length === 2) && !(sides.includes('E') && sides.includes('W') && sides.length === 2)
          ? 'Kitchen at the corner'
          : `Kitchen ${place(sides[0])}`;
  }
  let livingFact: string | null = null;
  if (living && living.type === 'living') {
    const e = exposure(living, rooms);
    const sides = outsideSides(living);
    if (sides.includes('S') && sides.includes('N')) livingFact = 'Living front to back';
    else if (sides.includes('S') && e.S >= box.w * 0.6) livingFact = 'Living across the front';
    else if (sides.length === 0) livingFact = 'Living in the middle';
    else if (sides.length >= 2) livingFact = `Living at the ${sides.includes('S') ? 'front' : sides.includes('N') ? 'back' : SIDE_WORD[sides[0]]} corner`;
    else livingFact = `Living ${place(sides[0])}`;
  }
  let hallFact: string | null = null;
  if (beds.length >= 2) {
    if (halls.length === 0) hallFact = 'No corridor';
    else if (halls.length >= 2) hallFact = 'Two short halls';
    else if (living && halls.some((h) => Math.max(h.w, h.h) >= 4 && sharedLong(h, living))) hallFact = 'Gallery hall';
  }
  const ratio = box.w / box.h;
  const form = ratio >= 1.9 ? 'Wide and shallow' : ratio <= 0.8 ? 'Narrow and deep' : ratio <= 1.25 ? 'Nearly square' : 'Broad front';
  return { beds: bedFact, kitchen: kitchenFact, living: livingFact, hall: hallFact, form };
}

/** The hall runs along the room (they share most of the hall's long side). */
function sharedLong(h: LayoutRoom, r: LayoutRoom): boolean {
  const horizontal = h.w >= h.h;
  if (horizontal) {
    const touch = Math.abs(h.y + h.h - r.y) < 1e-6 || Math.abs(r.y + r.h - h.y) < 1e-6;
    return touch && Math.min(h.x + h.w, r.x + r.w) - Math.max(h.x, r.x) >= h.w * 0.5;
  }
  const touch = Math.abs(h.x + h.w - r.x) < 1e-6 || Math.abs(r.x + r.w - h.x) < 1e-6;
  return touch && Math.min(h.y + h.h, r.y + r.h) - Math.max(h.y, r.y) >= h.h * 0.5;
}

/** Facts with left and right folded together, so a plan and its mirror image read the same. */
export function factKey(f: Facts): string[] {
  const fold = (s: string | null) => (s ?? '').replace(/\b(east|west)\b/g, 'side');
  return [fold(f.beds), fold(f.kitchen), fold(f.living)];
}

export interface Nameable {
  layout: Layout;
  /** A name for the whole idea ("T plan", "Offset bars") — used when no other option shares it. */
  lead?: string;
  /** What comes after the lead in the tooltip. */
  leadSummary?: string;
}

/**
 * A title and one-line summary for each option of a set. Each takes the
 * telling fact that fewest of the others share (and that no earlier option
 * already took), so five L-shaped houses are not five "L with a bedroom wing".
 */
export function nameOptions(options: readonly Nameable[]): { title: string; summary: string }[] {
  const all = options.map((o) => factsOf(o.layout));
  const lists = options.map((o, i) => {
    const f = all[i];
    return [o.lead ?? null, f.beds, f.kitchen, f.living, f.hall, f.form].filter((s): s is string => !!s);
  });
  const freq = new Map<string, number>();
  for (const list of lists) for (const t of new Set(list)) freq.set(t, (freq.get(t) ?? 0) + 1);
  const used = new Set<string>();
  return options.map((o, i) => {
    const f = all[i];
    const list = lists[i];
    let pick: string | null = null;
    let best = Infinity;
    list.forEach((t, rank) => {
      if (used.has(t)) return;
      // Rarest first; among equals, the more important fact.
      const score = (freq.get(t) ?? 1) * 10 + rank;
      if (score < best) {
        best = score;
        pick = t;
      }
    });
    let title: string = pick ?? list[0] ?? 'Layout';
    if (!pick) {
      let n = 2;
      while (used.has(`${title} ${n}`)) n++;
      title = `${title} ${n}`;
    }
    used.add(title);
    const rest = [f.beds, f.kitchen, f.living].filter((s): s is string => !!s && s !== title);
    const body = rest.length ? `${rest.join(', ').replace(/, ([A-Z])/g, (_, c: string) => `, ${c.toLowerCase()}`)}.` : '';
    const summary = [o.leadSummary && title === o.lead ? o.leadSummary : null, body].filter(Boolean).join(' ');
    return { title, summary: summary || (o.leadSummary ?? '') };
  });
}
