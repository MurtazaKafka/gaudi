/**
 * Everything about asking a model for a layout except the call itself: the
 * reply schema, the prompt, the organising ideas that make five options
 * differ, and the checks a reply must pass. Pure — testable without a key.
 */
import { auditLayout, bounds, DIMS } from './audit';
import { areaNeed, roomProgram, targetArea, type Brief, type ShapeId } from './brief';
import { ensureConnected, layoutArea, normalizeLayout, OUTSIDE, ROOM_TYPES, type Layout, type LayoutLink, type LayoutRoom, type RoomType } from './layout';
import { areaOutside, subtractRects, type Outline } from './outline';

export const LAYOUT_TAG = 'generate-layout';

export const LAYOUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'rooms', 'links'],
  properties: {
    title: { type: 'string', description: 'Two to four words naming the idea, e.g. "Split bedroom wings".' },
    summary: { type: 'string', description: 'One plain sentence on how the house is organised.' },
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'x', 'y', 'w', 'h'],
        properties: {
          name: { type: 'string', description: 'Unique, e.g. "Bedroom 2".' },
          type: { type: 'string', enum: [...ROOM_TYPES] },
          x: { type: 'number', description: 'West edge, meters, multiple of 0.5.' },
          y: { type: 'number', description: 'North edge, meters, multiple of 0.5.' },
          w: { type: 'number', description: 'East–west size, meters, multiple of 0.5.' },
          h: { type: 'number', description: 'North–south size, meters, multiple of 0.5.' },
        },
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['a', 'b', 'kind'],
        properties: {
          a: { type: 'string', description: 'A room name.' },
          b: { type: 'string', description: 'Another room name, or "outside" for the front door.' },
          kind: { type: 'string', enum: ['door', 'open'] },
        },
      },
    },
  },
};

export interface Idea {
  title: string;
  steer: string;
}

/** Five organising ideas, so five options are five different houses. */
export const IDEAS: readonly Idea[] = [
  {
    title: 'Central hall',
    steer:
      'A hall runs through the middle of the house like a spine: living spaces at the front (south), bedrooms and baths opening off the hall behind. Keep the hall short and straight.',
  },
  {
    title: 'Open-plan core',
    steer:
      'One generous open space — kitchen, dining and living flowing into each other — is the heart of the house and takes the best side; the bedrooms line up along one edge off a short hall.',
  },
  {
    title: 'Split bedroom wings',
    steer:
      'The main bedroom (with its bath, if it has one) sits at one end of the house and the other bedrooms at the opposite end, with the living spaces in between for privacy.',
  },
  {
    title: 'Courtyard',
    steer:
      'The house wraps around an outdoor court or terrace (leave it empty — it is not a room): living spaces along one side of it, bedrooms along another, so most rooms look onto it.',
  },
  {
    title: 'Compact square',
    steer:
      'As compact as possible: a near-square outline with almost no corridor, rooms packed efficiently, wet rooms (kitchen, baths, laundry) grouped back to back.',
  },
];

/** Organising ideas for filling an outline the person drew (the footprint is fixed, so the ideas are about zoning). */
export const OUTLINE_IDEAS: readonly Idea[] = [
  {
    title: 'Bedrooms together',
    steer:
      'The living spaces take one part of the outline (the part best placed for a front door on the south side) and every bedroom and bath sits together in another part, off one short hall.',
  },
  {
    title: 'Split bedrooms',
    steer:
      'The main bedroom (with its bath, if it has one) sits at one end of the outline and the other bedrooms at the far end, with the living spaces between them for privacy.',
  },
  {
    title: 'Open-plan heart',
    steer:
      'One generous open space — kitchen, dining and living flowing into each other — fills the largest part of the outline; the bedrooms take the rest, reached by as little hall as possible.',
  },
  {
    title: 'Living across the front',
    steer:
      'The living spaces line the south (street) edge of the outline and the bedrooms and baths sit behind them to the north, reached from a hall that runs between the two.',
  },
  {
    title: 'Kitchen at the centre',
    steer:
      'The kitchen sits in the middle of the house, where the parts of the outline meet, with the living room to one side and the bedrooms to the other.',
  },
];

/** Ways to vary an existing layout ("More like this"). */
export const VARIATIONS: readonly Idea[] = [
  { title: 'Mirrored, kitchen moved', steer: 'Keep the organisation but move the kitchen to the other side of the living spaces and adjust what follows from that.' },
  { title: 'Bigger living', steer: 'Keep the organisation but give the living spaces more of the area and tighten the bedrooms toward their minimum comfortable sizes.' },
  { title: 'Bigger bedrooms', steer: 'Keep the organisation but give the bedrooms more room and make the living spaces more compact.' },
  { title: 'Different proportions', steer: 'Keep the organisation but change the outline’s proportions noticeably (deeper and narrower, or wider and shallower).' },
  { title: 'Shorter hall', steer: 'Keep the organisation but rework the circulation so there is as little hall as possible.' },
];

const SHAPE_TEXT: Record<ShapeId, string> = {
  any: 'your choice — whatever suits the idea (a rectangle, an L, a U, a T…)',
  rect: 'a plain rectangle: the rooms together fill exactly one rectangle, no notches',
  L: 'an L: two rectangular wings that meet at a corner',
  U: 'a U: a bar with two wings reaching north from its two ends, leaving a court open to the north',
  T: 'a T: a bar with one wing reaching back from its middle',
  C: 'a C: a north–south bar with two wings reaching east (or west) from its two ends, leaving a court open to that side',
  bar: 'a long bar: one rectangle at least 2.3 times as long as it is deep, one or two rooms deep',
  Z: 'an offset pair: two parallel east–west bars, one behind the other, the back one slid sideways by about half its length so the outline reads as a Z',
  H: 'an H: two parallel north–south wings joined by a short link across their middles',
  plus: 'a cross: an east–west bar with a shorter wing reaching out from its middle on both the north and the south side',
  step: 'stepped: three bays side by side, each deeper than the last, lined up along the south so the north side steps back',
};

const n1 = (v: number) => (Math.round(v * 2) / 2).toString();

export const SYSTEM_PROMPT = `You design single-storey house floor plans for Gaudí, a drafting tool. You reply with ONE layout as JSON: named, axis-aligned room rectangles and the connections between them. The tool turns shared edges into walls, puts a door wherever you link two rooms, removes the wall where a link is "open", and adds windows to exterior walls by itself.

COORDINATES
- Meters. +x is east, +y is south. The street is to the south.
- A room is {x, y, w, h}: (x, y) is its north-west corner, w is its east–west size, h its north–south size.
- Every x, y, w and h is a multiple of 0.5.

GEOMETRY — checked mechanically, a reply that breaks these is thrown away
- Rooms never overlap.
- Rooms tile the outline: no gaps or slivers between rooms. The union of all rooms IS the footprint.
- Two rooms are neighbours only when they share part of an edge (a corner touch is not enough).
- A door needs at least 1.2 m of shared wall; an "open" link needs at least 1.5 m.
- Work like this: fix the outline, cut it into bands or wings, cut each band into rooms. Before you answer, add up the room widths along every band (they must equal the band's length) and the band depths (they must equal the outline), and check each link's two rooms really share an edge.

ROOM SIZES (typical area · smallest side)
- living 18–35 m² · 3.5 m     - kitchen 9–16 m² · 2.5 m      - dining 9–16 m² · 3 m
- primary_bedroom 14–20 m² · 3.5 m   - bedroom 9–14 m² · 3 m (never under 2.5 m)
- bathroom 4–6 m² · 1.5 m     - primary_bath 5–8 m² · 2 m    - office 7–11 m² · 2.5 m
- entry 3–6 m² · 1.5 m        - laundry 3–6 m² · 1.5 m       - pantry 2–4 m² · 1 m
- garage 18–21 m² (one car, 3.5 × 6) or about 36 m² (two cars) · hall 1–1.5 m wide
- Habitable rooms no more elongated than 2 : 1.

PLANNING SENSE
- Kitchen beside dining, dining beside living; these are usually "open" to each other.
- Bedrooms and shared bathrooms open off a hall (type "hall") or, in a small house, straight off the living space — never through another bedroom. Halls are short: under a tenth of the floor area.
- A primary_bath is entered only from its primary_bedroom.
- Pantry off the kitchen. Laundry off the kitchen or a hall. A garage sits on an outside edge with a door to the entry, laundry or kitchen.
- Every bedroom, the living room, kitchen and office has at least one exterior wall (for windows).
- Exactly one link to "outside": the front door, from the entry if there is one, otherwise the living room, facing south when you can.

LINKS
- {a, b, kind}: a and b are room names; kind is "door" or "open". Use b = "outside" for the front door.
- Link the rooms so that every room can be reached from the front door.

ROOMS
- Include exactly the rooms the brief lists, with those names and types, plus halls as needed. No other rooms, no closets, no outdoor spaces.`;

export interface PromptOptions {
  /**
   * An outline the person drew: the rooms must fill exactly this footprint.
   * The model is given (and answers in) coordinates measured from the
   * outline's north-west corner, so the numbers stay small.
   */
  outline?: Outline;
  /** Vary this layout instead of starting from scratch. */
  base?: Layout;
  /** Problems found in the previous attempt, to fix. */
  feedback?: { previous: Layout; problems: string[] };
}

const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** The fixed-footprint part of the prompt: corners, the rectangles it is made of, and what that demands. */
function outlineLines(outline: Outline): string[] {
  const ox = outline.box.x;
  const oy = outline.box.y;
  const lines: string[] = [];
  lines.push('FOOTPRINT — FIXED. The owner has already drawn the outside walls; the rooms must fill exactly this outline.');
  lines.push(`It fits a box ${n2(outline.box.w)} m wide (east–west) by ${n2(outline.box.h)} m deep (north–south); (0, 0) is the box's north-west corner.`);
  lines.push(`Corners, clockwise (x, y): ${outline.polygon.map((p) => `(${n2(p.x - ox)}, ${n2(p.y - oy)})`).join(' ')}`);
  lines.push('It is made of these rectangles {x, y, w, h}:');
  outline.rects.forEach((r, i) => {
    lines.push(`- ${String.fromCharCode(65 + (i % 26))}: {x: ${n2(r.x - ox)}, y: ${n2(r.y - oy)}, w: ${n2(r.w)}, h: ${n2(r.h)}} — ${Math.round(r.w * r.h)} m²`);
  });
  lines.push(`Total floor area: ${n2(outline.area)} m², all of it. Checked mechanically:`);
  lines.push('- No room may reach outside the outline, anywhere.');
  lines.push('- No part of the outline may be left without a room: room edges on the outside lie exactly on the outline’s lines (use the outline’s own coordinates there, even where they are not multiples of 0.5).');
  lines.push('- Work rectangle by rectangle: cut each of the rectangles above into rooms (a room may also span two of them where they line up).');
  lines.push('The outline decides the size: if the listed rooms need less area than it has, make them larger; if they need more, make them smaller (never under the smallest sides) and, only if they still cannot fit, leave out the least important room (pantry, entry, laundry, office, then dining).');
  lines.push('A leftover corner too small for a real room becomes a closet (type "closet") or part of a hall — never a misshapen bedroom.');
  return lines;
}

export function buildPrompt(brief: Brief, idea: Idea, opts: PromptOptions = {}): string {
  const rooms = roomProgram(brief);
  const outline = opts.outline;
  const goal = outline ? outline.area : targetArea(brief);
  const need = areaNeed(brief);
  // Scale the typical sizes to the asked area so the list adds up.
  const k = Math.min(1.6, Math.max(0.7, goal / need.ideal));
  const lines: string[] = [];
  lines.push('BRIEF');
  lines.push('Rooms (name — type — about this size):');
  for (const r of rooms) {
    const a = Math.min(r.max, Math.max(r.min, r.area * k));
    lines.push(`- ${r.name} — ${r.type} — ${Math.round(a)} m²${r.ensuiteOf ? ` (entered from ${r.ensuiteOf})` : ''}`);
  }
  lines.push('Add halls only where needed.');
  if (outline) {
    lines.push('');
    lines.push(...outlineLines(outline));
  } else {
    lines.push(
      brief.area
        ? `Total floor area: ${Math.round(goal)} m², within 8%.`
        : `Total floor area: around ${Math.round(goal)} m² (no fixed target — what suits the rooms).`,
    );
    lines.push(`Footprint: ${SHAPE_TEXT[brief.shape]}.`);
    if (brief.lot) {
      lines.push(
        `Lot: the whole plan must fit inside a box ${n1(brief.lot.w)} m wide (east–west) by ${n1(brief.lot.d)} m deep (north–south).`,
      );
    }
  }
  if (brief.wishes.trim()) lines.push(`Wishes from the owner: "${brief.wishes.trim()}"`);
  lines.push('');
  if (opts.base) {
    lines.push('START FROM THIS LAYOUT and produce a variation of it:');
    lines.push(JSON.stringify(compact(opts.base, outline)));
    lines.push(`How to vary it: ${idea.steer}`);
  } else {
    lines.push(`ORGANISING IDEA FOR THIS OPTION — "${idea.title}": ${idea.steer}`);
    lines.push('Other options are being drawn from other ideas, so commit to this one.');
  }
  if (opts.feedback) {
    lines.push('');
    lines.push('YOUR PREVIOUS ATTEMPT was:');
    lines.push(JSON.stringify(compact(opts.feedback.previous, outline)));
    lines.push('It has these problems — fix every one and re-check the arithmetic:');
    for (const p of opts.feedback.problems.slice(0, 12)) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

function compact(l: Layout, outline?: Outline): Layout {
  // With an outline the model works from the outline's north-west corner.
  const ox = outline?.box.x ?? 0;
  const oy = outline?.box.y ?? 0;
  const n = (v: number) => Math.round(v * 1000) / 1000;
  return {
    title: l.title,
    rooms: l.rooms.map((r) => ({ name: r.name, type: r.type, x: n(r.x - ox), y: n(r.y - oy), w: r.w, h: r.h })),
    links: l.links.map((k) => ({ a: k.a, b: k.b, kind: k.kind })),
  };
}

/* ------------------------------------------------------------------ */
/* Checking a reply                                                    */
/* ------------------------------------------------------------------ */

export interface Checked {
  /** Normalized, connected layout — usable when `fatal` is empty. */
  layout: Layout;
  /** Makes the layout unusable (overlaps, islands, unreachable rooms). */
  fatal: string[];
  /** Usable, but misses the brief (counts, size, lot, proportions). */
  major: string[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Coerce whatever the model returned into a Layout shape (never trust ranges). */
export function coerceLayout(raw: unknown): Layout {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rooms: LayoutRoom[] = [];
  for (const r of (Array.isArray(o.rooms) ? o.rooms : []).slice(0, 40) as Record<string, unknown>[]) {
    if (typeof r !== 'object' || r === null) continue;
    if (!finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) continue;
    if (Math.abs(r.x) > 200 || Math.abs(r.y) > 200 || r.w <= 0 || r.h <= 0 || r.w > 40 || r.h > 40) continue;
    rooms.push({
      name: typeof r.name === 'string' ? r.name : 'Room',
      type: ROOM_TYPES.includes(r.type as RoomType) ? (r.type as RoomType) : 'other',
      x: r.x, y: r.y, w: r.w, h: r.h,
    });
  }
  const links: LayoutLink[] = [];
  for (const l of (Array.isArray(o.links) ? o.links : []).slice(0, 120) as Record<string, unknown>[]) {
    if (typeof l !== 'object' || l === null || typeof l.a !== 'string' || typeof l.b !== 'string') continue;
    const outside = (s: string) => (s.trim().toLowerCase() === OUTSIDE ? OUTSIDE : s);
    links.push({ a: outside(l.a), b: outside(l.b), kind: l.kind === 'open' ? 'open' : 'door' });
  }
  return {
    title: typeof o.title === 'string' ? o.title.trim().slice(0, 40) : undefined,
    summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 160) : undefined,
    rooms,
    links,
  };
}

/**
 * Snap onto the outline's lattice: the outline's own lines, and half-metre
 * steps measured from any of them (rooms are cut in half-metres from whichever
 * wall they start at, and an outline need not sit on the grid).
 */
function outlineSnap(lines: readonly number[]): (v: number) => number {
  return (v) => {
    let best = Infinity;
    let at = v;
    for (const l of lines) {
      const steps = Math.round((v - l) / 0.5);
      const c = l + steps * 0.5;
      // On a tie the outline's own line wins.
      const err = Math.abs(v - c) + (steps === 0 ? 0 : 1e-4);
      if (err < best) {
        best = err;
        at = c;
      }
    }
    return Math.round(at * 1000) / 1000;
  };
}

/**
 * Check a reply. With `outline`, the reply's coordinates are measured from
 * the outline's north-west corner; the checked layout is back in plan
 * coordinates, and rooms straying outside the outline or leaving part of it
 * empty make it unusable.
 */
export function checkLayout(raw: unknown, brief: Brief, outline?: Outline): Checked {
  const fatal: string[] = [];
  const major: string[] = [];
  const given = coerceLayout(raw);
  if (outline) {
    for (const r of given.rooms) {
      r.x += outline.box.x;
      r.y += outline.box.y;
    }
  }
  const norm = outline
    ? normalizeLayout(given, {
        keepPosition: true,
        snapX: outlineSnap([...new Set(outline.polygon.map((p) => p.x))]),
        snapY: outlineSnap([...new Set(outline.polygon.map((p) => p.y))]),
      })
    : normalizeLayout(given);
  if (norm.layout.rooms.length < (outline ? 1 : 2)) {
    return { layout: norm.layout, fatal: ['The reply had no usable rooms.'], major };
  }
  fatal.push(...norm.errors);
  if (outline) {
    const ox = outline.box.x;
    const oy = outline.box.y;
    for (const r of norm.layout.rooms) {
      const out = areaOutside(r, outline.rects);
      if (out > 0.05) fatal.push(`${r.name} reaches outside the outline (about ${n2(out)} m² of it).`);
    }
    const empty = subtractRects(outline.rects, norm.layout.rooms).filter((r) => r.w * r.h > 0.05);
    for (const r of empty.slice(0, 4)) {
      fatal.push(
        `No room covers the part of the outline from x ${n2(r.x - ox)} to ${n2(r.x + r.w - ox)}, y ${n2(r.y - oy)} to ${n2(r.y + r.h - oy)}.`,
      );
    }
  }

  // What the model linked, before we patch anything.
  const asGiven = auditLayout(norm.layout);
  for (const b of asGiven.badLinks) major.push(`${b}: linked, but they don't share enough wall for it.`);

  const layout = ensureConnected(norm.layout);
  const audit = auditLayout(layout);
  for (const n of audit.islands) fatal.push(`${n} doesn't touch any other room.`);
  for (const n of audit.unreachable) {
    if (!audit.islands.includes(n)) fatal.push(`${n} can't be reached from the front door.`);
  }
  if (!audit.entrance) fatal.push('There is no room with enough exterior wall for a front door.');
  for (const n of audit.throughBedroom) major.push(`${n} is only reachable through a bedroom or bathroom.`);
  for (const r of layout.rooms) {
    const lo = Math.min(r.w, r.h);
    const hi = Math.max(r.w, r.h);
    if (lo < DIMS[r.type].hard - 1e-6) {
      major.push(`${r.name} is only ${lo} m wide (needs ${DIMS[r.type].hard} m).`);
    } else if (r.type !== 'hall' && hi / lo > DIMS[r.type].aspect * 1.5) {
      major.push(`${r.name} is ${r.w} × ${r.h} m — too elongated.`);
    }
  }

  const count = (...t: RoomType[]) => layout.rooms.filter((r) => t.includes(r.type)).length;
  const beds = count('bedroom', 'primary_bedroom');
  const baths = count('bathroom', 'primary_bath');
  if (beds !== brief.bedrooms) major.push(`The brief asks for ${brief.bedrooms} bedrooms; the layout has ${beds}.`);
  if (baths !== brief.bathrooms) major.push(`The brief asks for ${brief.bathrooms} bathrooms; the layout has ${baths}.`);
  for (const r of roomProgram(brief)) {
    if (r.zone === 'public' && count(r.type) === 0) major.push(`The ${r.name.toLowerCase()} is missing.`);
  }

  // An outline fixes the size and shape; the checks above already hold the reply to it.
  if (outline) return { layout, fatal, major };

  const area = layoutArea(layout);
  const goal = targetArea(brief);
  const tolerance = brief.area ? 0.15 : 0.4;
  if (Math.abs(area - goal) / goal > tolerance) {
    major.push(`Total floor area is ${Math.round(area)} m²; it should be about ${Math.round(goal)} m².`);
  }
  const box = bounds(layout.rooms);
  if (brief.lot && (box.w > brief.lot.w + 1e-6 || box.h > brief.lot.d + 1e-6)) {
    major.push(`The plan is ${box.w} × ${box.h} m; the lot is ${brief.lot.w} × ${brief.lot.d} m.`);
  }
  const fill = area / (box.w * box.h);
  if (brief.shape === 'rect' && fill < 0.985) major.push('The outline is not a plain rectangle — there are gaps or notches.');
  if (brief.shape === 'bar' && Math.max(box.w, box.h) / Math.min(box.w, box.h) < 2) major.push('The outline is not a long bar.');

  return { layout, fatal, major };
}
