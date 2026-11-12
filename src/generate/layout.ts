/**
 * Layouts: a house described as named, axis-aligned room rectangles plus the
 * connections between them — the form both the AI and the procedural
 * generator produce, and the form templates are authored in.
 *
 * `layoutToPlan` turns one into a real Gaudí plan deterministically: shared
 * edges become single walls, 'open' connections leave the wall out, doors go
 * on the wall two rooms share, windows go on exterior walls, and room names
 * are attached to the detected rooms. Pure — no store, no DOM.
 */
import { detectRooms } from '../rooms';
import { pointInPolygon } from '../geometry';
import type { Opening, PlanData, PlanLook, PlanSettings, Wall } from '../types';

export type RoomType =
  | 'living'
  | 'kitchen'
  | 'dining'
  | 'bedroom'
  | 'primary_bedroom'
  | 'bathroom'
  | 'primary_bath'
  | 'office'
  | 'hall'
  | 'entry'
  | 'laundry'
  | 'garage'
  | 'closet'
  | 'pantry'
  | 'other';

export const ROOM_TYPES: readonly RoomType[] = [
  'living', 'kitchen', 'dining', 'bedroom', 'primary_bedroom', 'bathroom', 'primary_bath',
  'office', 'hall', 'entry', 'laundry', 'garage', 'closet', 'pantry', 'other',
];

/** A room rectangle in plan meters: (x, y) is its north-west corner; +x east, +y south. */
export interface LayoutRoom {
  /** Unique within the layout, shown on the plan. */
  name: string;
  type: RoomType;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The pseudo-room on the other side of the front door. */
export const OUTSIDE = 'outside';

/**
 * A connection between two rooms by name. `door`: a door on their shared
 * wall. `open`: no wall between them (open plan). Use b = 'outside' with kind
 * 'door' for an exterior door.
 */
export interface LayoutLink {
  a: string;
  b: string;
  kind: 'door' | 'open';
}

export interface Layout {
  title?: string;
  /** One line on the idea behind this arrangement. */
  summary?: string;
  rooms: LayoutRoom[];
  links: LayoutLink[];
}

export interface LayoutResult {
  plan: PlanData;
  /** Things that were adjusted or could not be honored (missing shared wall for a door, …). */
  warnings: string[];
}

const SNAP = 0.5;
const EPS = 1e-6;
const DOOR_W = 0.9;
const DOOR_W_SMALL = 0.8;
const GAP = 0.05;

const snap = (v: number, step = SNAP) => Math.round(v / step) * step;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const SMALL_DOOR: ReadonlySet<RoomType> = new Set(['bathroom', 'primary_bath', 'closet', 'pantry', 'laundry']);
const NO_WINDOW: ReadonlySet<RoomType> = new Set(['hall', 'entry', 'closet', 'pantry', 'garage']);

export function layoutArea(layout: Layout): number {
  return layout.rooms.reduce((s, r) => s + r.w * r.h, 0);
}

/** Overlap area of two rectangles (0 when they only touch). */
function overlap(a: LayoutRoom, b: LayoutRoom): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > EPS && h > EPS ? w * h : 0;
}

/** Length of the edge two rectangles share (0 if they don't abut). */
export function sharedEdge(a: LayoutRoom, b: LayoutRoom): number {
  const xo = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const touchV = Math.abs(a.x + a.w - b.x) < EPS || Math.abs(b.x + b.w - a.x) < EPS;
  const touchH = Math.abs(a.y + a.h - b.y) < EPS || Math.abs(b.y + b.h - a.y) < EPS;
  if (touchV && yo > EPS) return yo;
  if (touchH && xo > EPS) return xo;
  return 0;
}

export interface NormalizeOptions {
  /**
   * Leave the rooms at the coordinates they were given instead of re-centring
   * the layout on the origin — for rooms fitted into an outline the person drew.
   */
  keepPosition?: boolean;
  /** Replace the 0.5 m snap along x / y (e.g. to snap onto an outline's own coordinates). */
  snapX?: (v: number) => number;
  snapY?: (v: number) => number;
  /** Rooms narrower than this are dropped as noise (default 1 m). Lower it for rooms that already exist. */
  minSide?: number;
}

/** How a layout whose rooms are already exactly where they belong is normalized: nothing moves, nothing is dropped. */
export const IN_PLACE: NormalizeOptions = {
  keepPosition: true,
  snapX: (v) => Math.round(v * 1000) / 1000,
  snapY: (v) => Math.round(v * 1000) / 1000,
  minSide: 0.05,
};

/** Snap to the millimetre only: for layouts whose coordinates are already exact. */
export const snapFine = (v: number): number => Math.round(v * 1000) / 1000;

const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);
const OPEN_ORDER: Partial<Record<RoomType, number>> = { living: 0, dining: 1, kitchen: 2 };
const OPEN_WORD: Partial<Record<RoomType, string>> = { living: 'Living', dining: 'Dining', kitchen: 'Kitchen' };

/**
 * A short, natural name for rooms that read as one space because the walls
 * between them were left out: "Living & kitchen", "Living, dining & kitchen".
 * A hall or entry that merges into a room is not named, nor is a pantry.
 */
export function openPlanName(rooms: readonly LayoutRoom[]): string {
  if (rooms.length === 0) return '';
  const bySize = rooms.slice().sort((p, q) => q.w * q.h - p.w * p.h);
  if (rooms.length === 1) return bySize[0].name;
  const minor = (t: RoomType) => t === 'closet' || t === 'pantry';
  const passage = (t: RoomType) => t === 'hall' || t === 'entry';
  const main = bySize.filter((r) => !minor(r.type) && !passage(r.type));
  // Only passages (or only cupboards) merged: it is still a hall.
  if (main.length === 0) return (bySize.find((r) => passage(r.type)) ?? bySize[0]).name;
  if (main.length === 1) return main[0].name;
  const parts: string[] = [];
  for (const r of main.slice().sort((p, q) => (OPEN_ORDER[p.type] ?? 3) - (OPEN_ORDER[q.type] ?? 3))) {
    const word = OPEN_WORD[r.type] ?? r.name;
    if (!parts.some((p) => p.toLowerCase() === word.toLowerCase())) parts.push(word);
  }
  const shown = parts.slice(0, 3).map((p, i) => (i === 0 ? p : lowerFirst(p)));
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} & ${shown[shown.length - 1]}`.slice(0, 80);
}

/**
 * Clean a raw layout: snap to the grid, de-duplicate names, drop degenerate
 * rooms and links to unknown rooms, and re-center on the origin. Returns
 * errors for problems that can't be fixed mechanically (overlapping rooms).
 */
export function normalizeLayout(raw: Layout, opts: NormalizeOptions = {}): { layout: Layout; errors: string[] } {
  const errors: string[] = [];
  const snapX = opts.snapX ?? ((v: number) => snap(v));
  const snapY = opts.snapY ?? ((v: number) => snap(v));
  const minSide = opts.minSide ?? 1;
  const seen = new Map<string, number>();
  const rename = new Map<string, string>();
  const rooms: LayoutRoom[] = [];

  for (const r of raw.rooms ?? []) {
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue;
    const x = snapX(r.x);
    const y = snapY(r.y);
    const w = snapX(r.x + r.w) - x;
    const h = snapY(r.y + r.h) - y;
    if (w < minSide - EPS || h < minSide - EPS) continue;
    const base = (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Room').slice(0, 40);
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    const name = n === 1 ? base : `${base} ${n}`;
    if (n === 1) rename.set(r.name, name);
    const type = ROOM_TYPES.includes(r.type) ? r.type : 'other';
    rooms.push({ name, type, x, y, w, h });
  }
  if (rooms.length === 0) return { layout: { ...raw, rooms: [], links: [] }, errors: ['No usable rooms.'] };

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (overlap(rooms[i], rooms[j]) > 0.01) {
        errors.push(`${rooms[i].name} overlaps ${rooms[j].name}.`);
      }
    }
  }

  // Center on the origin, staying on the grid (unless the rooms must stay where they are).
  const minX = Math.min(...rooms.map((r) => r.x));
  const maxX = Math.max(...rooms.map((r) => r.x + r.w));
  const minY = Math.min(...rooms.map((r) => r.y));
  const maxY = Math.max(...rooms.map((r) => r.y + r.h));
  const dx = opts.keepPosition ? 0 : snap((minX + maxX) / 2);
  const dy = opts.keepPosition ? 0 : snap((minY + maxY) / 2);
  for (const r of rooms) {
    r.x = r3(r.x - dx);
    r.y = r3(r.y - dy);
    r.w = r3(r.w);
    r.h = r3(r.h);
  }

  const names = new Set(rooms.map((r) => r.name));
  const resolve = (n: string) => (n === OUTSIDE ? OUTSIDE : rename.get(n) ?? n);
  const links: LayoutLink[] = [];
  const linkSeen = new Set<string>();
  for (const l of raw.links ?? []) {
    const a = resolve(l.a);
    const b = resolve(l.b);
    if (a === b) continue;
    if ((a !== OUTSIDE && !names.has(a)) || (b !== OUTSIDE && !names.has(b))) continue;
    const kind = l.kind === 'open' && a !== OUTSIDE && b !== OUTSIDE ? 'open' : 'door';
    const key = [a, b].sort().join('|');
    if (linkSeen.has(key)) continue;
    linkSeen.add(key);
    // Keep 'outside' on the b side.
    links.push(a === OUTSIDE ? { a: b, b: a, kind } : { a, b, kind });
  }

  return { layout: { title: raw.title, summary: raw.summary, rooms, links }, errors };
}

/**
 * Make sure every room can be reached from the front door: add an exterior
 * door if there is none, then connect any unreachable room to its best
 * reachable neighbour (longest shared wall, halls and living rooms first).
 */
export function ensureConnected(layout: Layout): Layout {
  const links = layout.links.slice();
  const byName = new Map(layout.rooms.map((r) => [r.name, r]));
  const exteriorLen = (r: LayoutRoom) => {
    // perimeter not shared with any other room
    let shared = 0;
    for (const o of layout.rooms) if (o !== r) shared += sharedEdge(r, o);
    return 2 * (r.w + r.h) - shared;
  };

  if (!links.some((l) => l.b === OUTSIDE)) {
    const rank = (r: LayoutRoom) =>
      (r.type === 'entry' ? 100 : r.type === 'hall' ? 60 : r.type === 'living' ? 40 : r.type === 'kitchen' ? 10 : 0) +
      Math.min(exteriorLen(r), 9);
    const candidates = layout.rooms.filter((r) => exteriorLen(r) > DOOR_W + 0.4);
    const best = candidates.sort((p, q) => rank(q) - rank(p))[0];
    if (best) links.push({ a: best.name, b: OUTSIDE, kind: 'door' });
  }

  const reach = new Set<string>();
  const grow = () => {
    const queue = links.filter((l) => l.b === OUTSIDE).map((l) => l.a);
    for (const n of queue) reach.add(n);
    while (queue.length) {
      const cur = queue.pop()!;
      for (const l of links) {
        const other = l.a === cur ? l.b : l.b === cur ? l.a : null;
        if (other && other !== OUTSIDE && !reach.has(other)) {
          reach.add(other);
          queue.push(other);
        }
      }
    }
  };
  grow();

  const hubScore = (t: RoomType) =>
    t === 'hall' || t === 'entry' ? 3 : t === 'living' ? 2 : t === 'dining' || t === 'kitchen' ? 1 : 0;
  let guard = layout.rooms.length + 1;
  while (reach.size < layout.rooms.length && guard-- > 0) {
    let best: { from: string; to: string; score: number } | null = null;
    for (const r of layout.rooms) {
      if (reach.has(r.name)) continue;
      for (const name of reach) {
        const o = byName.get(name)!;
        const len = sharedEdge(r, o);
        if (len < DOOR_W_SMALL + 0.2) continue;
        const score = hubScore(o.type) * 10 + Math.min(len, 5);
        if (!best || score > best.score) best = { from: r.name, to: name, score };
      }
    }
    if (!best) break; // an island that touches nothing reachable
    links.push({ a: best.from, b: best.to, kind: 'door' });
    reach.clear();
    grow();
  }
  return { ...layout, links };
}

interface Piece {
  /** fixed coordinate (y for horizontal walls, x for vertical) */
  c: number;
  from: number;
  to: number;
  horizontal: boolean;
  /** room on the north / west side, and on the south / east side */
  n: string | null;
  s: string | null;
}

/** Split every line that carries room edges into atomic pieces labelled by the rooms on each side. */
function wallPieces(rooms: LayoutRoom[], horizontal: boolean): Piece[] {
  // In "horizontal" mode a room spans [lo, hi] along the line and sits at c0 (near) / c1 (far).
  const span = (r: LayoutRoom) =>
    horizontal
      ? { lo: r.x, hi: r.x + r.w, c0: r.y, c1: r.y + r.h }
      : { lo: r.y, hi: r.y + r.h, c0: r.x, c1: r.x + r.w };

  const lines = new Map<number, LayoutRoom[]>();
  const key = (c: number) => Math.round(c * 1000);
  for (const r of rooms) {
    const s = span(r);
    for (const c of [s.c0, s.c1]) {
      const list = lines.get(key(c));
      if (list) list.push(r);
      else lines.set(key(c), [r]);
    }
  }

  const pieces: Piece[] = [];
  for (const [k, onLine] of lines) {
    const c = k / 1000;
    const stops = [...new Set(onLine.flatMap((r) => [span(r).lo, span(r).hi]).map((v) => key(v)))]
      .sort((a, b) => a - b)
      .map((v) => v / 1000);
    for (let i = 0; i + 1 < stops.length; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      const mid = (from + to) / 2;
      const covers = (r: LayoutRoom) => span(r).lo < mid && mid < span(r).hi;
      const north = onLine.find((r) => Math.abs(span(r).c1 - c) < EPS && covers(r));
      const south = onLine.find((r) => Math.abs(span(r).c0 - c) < EPS && covers(r));
      if (!north && !south) continue;
      pieces.push({ c, from, to, horizontal, n: north?.name ?? null, s: south?.name ?? null });
    }
  }
  return pieces;
}

/** Join consecutive pieces that separate the same pair of rooms. */
function mergePieces(pieces: Piece[]): Piece[] {
  const sorted = pieces
    .slice()
    .sort((a, b) => Number(a.horizontal) - Number(b.horizontal) || a.c - b.c || a.from - b.from);
  const out: Piece[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.horizontal === p.horizontal &&
      Math.abs(last.c - p.c) < EPS &&
      Math.abs(last.to - p.from) < EPS &&
      last.n === p.n &&
      last.s === p.s
    ) {
      last.to = p.to;
    } else out.push({ ...p });
  }
  return out;
}

interface BuiltWall extends Wall {
  n: string | null;
  s: string | null;
  len: number;
}

function fits(openings: Opening[], wall: BuiltWall, offset: number, width: number): boolean {
  if (offset - width / 2 < GAP || offset + width / 2 > wall.len - GAP) return false;
  return openings.every(
    (o) => o.wallId !== wall.id || Math.abs(o.offset - offset) >= (o.width + width) / 2 + 0.25,
  );
}

const DEFAULT_SETTINGS: PlanSettings = { wallHeight: 2.7, wallThickness: 0.1, gridSize: 0.5, units: 'm' };
const DEFAULT_LOOK: PlanLook = { style: 'maquette', roof: 'none' };

/**
 * Build a plan from a layout. The layout is normalized and made connected
 * first, so any reasonable input yields a usable plan; `warnings` says what
 * had to give. Throws only if no rooms survive.
 */
export function layoutToPlan(
  raw: Layout,
  base: { settings?: PlanSettings; look?: PlanLook; newId?: () => string } & NormalizeOptions = {},
): LayoutResult {
  const warnings: string[] = [];
  const norm = normalizeLayout(raw, { keepPosition: base.keepPosition, snapX: base.snapX, snapY: base.snapY, minSide: base.minSide });
  warnings.push(...norm.errors);
  if (norm.layout.rooms.length === 0) throw new Error('This layout has no usable rooms.');
  const layout = ensureConnected(norm.layout);
  const newId = base.newId ?? (() => crypto.randomUUID());
  const typeOf = new Map(layout.rooms.map((r) => [r.name, r.type]));

  const openPairs = new Set(
    layout.links.filter((l) => l.kind === 'open').map((l) => [l.a, l.b].sort().join('|')),
  );
  const pairKey = (a: string | null, b: string | null) => [a ?? OUTSIDE, b ?? OUTSIDE].sort().join('|');

  const pieces = mergePieces([
    ...wallPieces(layout.rooms, true),
    ...wallPieces(layout.rooms, false),
  ]).filter((p) => !(p.n && p.s && openPairs.has(pairKey(p.n, p.s))));

  const walls: BuiltWall[] = pieces.map((p) => ({
    id: newId(),
    a: p.horizontal ? { x: r3(p.from), y: r3(p.c) } : { x: r3(p.c), y: r3(p.from) },
    b: p.horizontal ? { x: r3(p.to), y: r3(p.c) } : { x: r3(p.c), y: r3(p.to) },
    n: p.n,
    s: p.s,
    len: p.to - p.from,
  }));

  const openings: Opening[] = [];
  const add = (wall: BuiltWall, type: 'door' | 'window', offset: number, width: number, label?: string) => {
    openings.push({ id: newId(), wallId: wall.id, type, offset: r3(offset), width, ...(label ? { label } : {}) });
  };

  // Doors: on the longest wall the two rooms share; near a corner on long walls, centered on short ones.
  for (const link of layout.links) {
    if (link.kind !== 'door') continue;
    const small = SMALL_DOOR.has(typeOf.get(link.a)!) || (link.b !== OUTSIDE && SMALL_DOOR.has(typeOf.get(link.b)!));
    const width = link.b === OUTSIDE ? DOOR_W : small ? DOOR_W_SMALL : DOOR_W;
    const key = pairKey(link.a, link.b);
    const between = walls.filter((w) => pairKey(w.n, w.s) === key).sort((p, q) => q.len - p.len);
    let candidates = between.filter((w) => w.len >= width + 0.3 - 1e-6);
    let doorWidth = width;
    if (candidates.length === 0 && link.b !== OUTSIDE) {
      // A metre of shared wall (the end of a hall) still takes a narrow door.
      doorWidth = DOOR_W_SMALL;
      candidates = between.filter((w) => w.len >= DOOR_W_SMALL + 0.2 - 1e-6);
    }
    let placed = false;
    for (const wall of candidates) {
      const width = doorWidth;
      const centered = wall.len / 2;
      const nearStart = 0.25 + width / 2;
      const tries = link.b === OUTSIDE || wall.len < 2.4 ? [centered, nearStart] : [nearStart, wall.len - nearStart, centered];
      const offset = tries.find((o) => fits(openings, wall, o, width));
      if (offset !== undefined) {
        add(wall, 'door', offset, width, link.b === OUTSIDE ? 'Entrance' : undefined);
        placed = true;
        break;
      }
    }
    if (!placed) {
      warnings.push(
        link.b === OUTSIDE
          ? `No exterior wall on ${link.a} long enough for an entrance.`
          : `${link.a} and ${link.b} don't share a wall long enough for a door.`,
      );
    }
  }

  // Windows: every habitable room gets glazing on its exterior walls.
  for (const room of layout.rooms) {
    if (NO_WINDOW.has(room.type)) continue;
    const wet = room.type === 'bathroom' || room.type === 'primary_bath' || room.type === 'laundry';
    const exterior = walls
      .filter((w) => (w.n === room.name && w.s === null) || (w.s === room.name && w.n === null))
      .sort((p, q) => q.len - p.len);
    let count = 0;
    for (const wall of exterior) {
      if (wet && count >= 1) break;
      const width = wet ? 0.6 : Math.min(1.5, Math.max(0.9, snap(wall.len * 0.35, 0.1)));
      if (wall.len < width + 0.8) continue;
      const spots = !wet && wall.len >= 5.5 ? [wall.len / 3, (2 * wall.len) / 3] : [wall.len / 2];
      for (const offset of spots) {
        if (fits(openings, wall, offset, width)) {
          add(wall, 'window', offset, width);
          count++;
        }
      }
    }
  }

  // Names: label each detected room with the layout room(s) it contains.
  const plainWalls: Wall[] = walls.map(({ id, a, b }) => ({ id, a, b }));
  const roomNames: Record<string, string> = {};
  for (const detected of detectRooms(plainWalls)) {
    const inside = layout.rooms
      .filter((r) => pointInPolygon({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, detected.polygon))
      .sort((p, q) => q.w * q.h - p.w * p.h);
    if (inside.length) roomNames[detected.key] = openPlanName(inside);
  }

  return {
    plan: {
      name: (layout.title ?? '').trim().slice(0, 80) || 'Untitled plan',
      walls: plainWalls,
      openings,
      furniture: [],
      roomNames,
      settings: { ...(base.settings ?? DEFAULT_SETTINGS) },
      customItems: {},
      look: { ...(base.look ?? DEFAULT_LOOK) },
    },
    warnings,
  };
}
