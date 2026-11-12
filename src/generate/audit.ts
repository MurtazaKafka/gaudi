/**
 * Checks on a Layout that both engines share: sane room dimensions, a door
 * that can actually be placed for every link, every room reachable from the
 * entrance without walking through someone's bedroom. Pure.
 */
import { OUTSIDE, sharedEdge, type Layout, type LayoutRoom, type RoomType } from './layout';

export type Side = 'N' | 'S' | 'E' | 'W';

/** Per room type: smallest side that works (m), the side we'd like, and the longest comfortable aspect ratio. */
export const DIMS: Record<RoomType, { hard: number; pref: number; aspect: number }> = {
  living: { hard: 3, pref: 3.5, aspect: 2 },
  kitchen: { hard: 2, pref: 2.5, aspect: 2.2 },
  dining: { hard: 2.5, pref: 3, aspect: 2 },
  bedroom: { hard: 2.5, pref: 3, aspect: 1.8 },
  primary_bedroom: { hard: 3, pref: 3.5, aspect: 1.8 },
  bathroom: { hard: 1.5, pref: 1.5, aspect: 2.7 },
  primary_bath: { hard: 1.5, pref: 2, aspect: 2.7 },
  office: { hard: 2, pref: 2.5, aspect: 2 },
  hall: { hard: 1, pref: 1, aspect: 99 },
  entry: { hard: 1.5, pref: 1.5, aspect: 3 },
  laundry: { hard: 1.5, pref: 1.5, aspect: 3 },
  garage: { hard: 3, pref: 3.5, aspect: 2.2 },
  closet: { hard: 1, pref: 1.5, aspect: 3.5 },
  pantry: { hard: 1, pref: 1, aspect: 3.5 },
  other: { hard: 1.5, pref: 2, aspect: 3 },
};

const EPS = 1e-6;
const SMALL_DOOR: ReadonlySet<RoomType> = new Set(['bathroom', 'primary_bath', 'closet', 'pantry', 'laundry']);
const SLEEPING: ReadonlySet<RoomType> = new Set(['bedroom', 'primary_bedroom']);

/** Wall length two rooms must share for layoutToPlan to fit a door between them. */
export function doorNeed(a: RoomType, b: RoomType | null): number {
  // The end of a metre-wide hall takes a narrow door (layoutToPlan falls back to one).
  if (b !== null && (a === 'hall' || b === 'hall')) return 1;
  const small = SMALL_DOOR.has(a) || (b !== null && SMALL_DOOR.has(b));
  return (b === null ? 0.9 : small ? 0.8 : 0.9) + 0.3;
}

/** Longest stretch of each side of `room` that no other room touches (its exterior wall there). */
export function exposure(room: LayoutRoom, rooms: readonly LayoutRoom[]): Record<Side, number> {
  const run = (lo: number, hi: number, covered: [number, number][]): number => {
    covered.sort((p, q) => p[0] - q[0]);
    let best = 0;
    let at = lo;
    for (const [a, b] of covered) {
      if (a > at) best = Math.max(best, a - at);
      at = Math.max(at, b);
    }
    return Math.max(best, hi - at);
  };
  const cover: Record<Side, [number, number][]> = { N: [], S: [], E: [], W: [] };
  for (const o of rooms) {
    if (o === room) continue;
    const xo: [number, number] = [Math.max(o.x, room.x), Math.min(o.x + o.w, room.x + room.w)];
    const yo: [number, number] = [Math.max(o.y, room.y), Math.min(o.y + o.h, room.y + room.h)];
    if (xo[1] - xo[0] > EPS) {
      if (Math.abs(o.y + o.h - room.y) < EPS) cover.N.push(xo);
      if (Math.abs(o.y - (room.y + room.h)) < EPS) cover.S.push(xo);
    }
    if (yo[1] - yo[0] > EPS) {
      if (Math.abs(o.x + o.w - room.x) < EPS) cover.W.push(yo);
      if (Math.abs(o.x - (room.x + room.w)) < EPS) cover.E.push(yo);
    }
  }
  return {
    N: run(room.x, room.x + room.w, cover.N),
    S: run(room.x, room.x + room.w, cover.S),
    W: run(room.y, room.y + room.h, cover.W),
    E: run(room.y, room.y + room.h, cover.E),
  };
}

export function maxExposure(room: LayoutRoom, rooms: readonly LayoutRoom[]): { side: Side; len: number } {
  const e = exposure(room, rooms);
  // Ties go to the front (south), then the sides.
  let best: { side: Side; len: number } = { side: 'S', len: e.S };
  for (const side of ['E', 'W', 'N'] as const) if (e[side] > best.len + EPS) best = { side, len: e[side] };
  return best;
}

export function bounds(rooms: readonly LayoutRoom[]): { x: number; y: number; w: number; h: number } {
  const minX = Math.min(...rooms.map((r) => r.x));
  const minY = Math.min(...rooms.map((r) => r.y));
  const maxX = Math.max(...rooms.map((r) => r.x + r.w));
  const maxY = Math.max(...rooms.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface Audit {
  /** Pairs of rooms that overlap. */
  overlaps: string[];
  /** Rooms narrower than their type can bear. */
  narrow: string[];
  /** Links that can't be built (rooms don't share enough wall). */
  badLinks: string[];
  /** Rooms with no route from the entrance. */
  unreachable: string[];
  /** Rooms only reachable by walking through a bedroom or bathroom. */
  throughBedroom: string[];
  /** Rooms that touch no other room. */
  islands: string[];
  /** The room holding the front door and the side it faces; null if there is none. */
  entrance: { room: string; side: Side } | null;
}

export function auditOk(a: Audit): boolean {
  return (
    a.overlaps.length === 0 && a.unreachable.length === 0 && a.islands.length === 0 && a.entrance !== null
  );
}

/** Inspect a (normalized) layout. Nothing is changed. */
export function auditLayout(layout: Layout): Audit {
  const rooms = layout.rooms;
  const byName = new Map(rooms.map((r) => [r.name, r]));
  const overlaps: string[] = [];
  const narrow: string[] = [];
  const islands: string[] = [];

  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i];
    if (Math.min(a.w, a.h) < DIMS[a.type].hard - EPS) narrow.push(a.name);
    let touches = rooms.length === 1;
    for (let j = 0; j < rooms.length; j++) {
      if (i === j) continue;
      const b = rooms[j];
      if (sharedEdge(a, b) > EPS) touches = true;
      if (j > i) {
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (w > EPS && h > EPS && w * h > 0.01) overlaps.push(`${a.name} / ${b.name}`);
      }
    }
    if (!touches) islands.push(a.name);
  }

  // Which links can really be built.
  const badLinks: string[] = [];
  const adj = new Map<string, string[]>();
  const starts: string[] = [];
  let entrance: Audit['entrance'] = null;
  for (const l of layout.links) {
    const a = byName.get(l.a);
    if (!a) continue;
    if (l.b === OUTSIDE) {
      const ex = maxExposure(a, rooms);
      if (ex.len >= doorNeed(a.type, null) - EPS) {
        starts.push(a.name);
        if (!entrance) entrance = { room: a.name, side: ex.side };
      } else badLinks.push(`${l.a} / outside`);
      continue;
    }
    const b = byName.get(l.b);
    if (!b) continue;
    const shared = sharedEdge(a, b);
    const ok = l.kind === 'open' ? shared > 0.4 : shared >= doorNeed(a.type, b.type) - EPS;
    if (!ok) {
      badLinks.push(`${l.a} / ${l.b}`);
      continue;
    }
    (adj.get(a.name) ?? adj.set(a.name, []).get(a.name)!).push(b.name);
    (adj.get(b.name) ?? adj.set(b.name, []).get(b.name)!).push(a.name);
  }

  const flood = (passThrough: (r: LayoutRoom) => boolean): Set<string> => {
    const seen = new Set<string>(starts);
    const queue = starts.slice();
    while (queue.length) {
      const cur = queue.pop()!;
      if (!starts.includes(cur) && !passThrough(byName.get(cur)!)) continue;
      for (const n of adj.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen;
  };
  const all = flood(() => true);
  const polite = flood((r) => !SLEEPING.has(r.type) && r.type !== 'bathroom' && r.type !== 'primary_bath');
  // An ensuite (or a closet) behind its own bedroom is fine.
  const privateOk = (r: LayoutRoom) =>
    (r.type === 'primary_bath' || r.type === 'closet') &&
    (adj.get(r.name) ?? []).some((n) => SLEEPING.has(byName.get(n)!.type) && polite.has(n));

  return {
    overlaps,
    narrow,
    badLinks,
    islands,
    unreachable: rooms.filter((r) => !all.has(r.name)).map((r) => r.name),
    throughBedroom: rooms
      .filter((r) => all.has(r.name) && !polite.has(r.name) && !privateOk(r))
      .map((r) => r.name),
    entrance,
  };
}

/** Rooms merged by 'open' links read as one space on the plan: how many separate rooms result. */
export function enclosedRoomCount(layout: Layout): number {
  const parent = new Map(layout.rooms.map((r) => [r.name, r.name]));
  const find = (n: string): string => {
    let p = parent.get(n)!;
    while (p !== parent.get(p)!) p = parent.get(p)!;
    parent.set(n, p);
    return p;
  };
  const byName = new Map(layout.rooms.map((r) => [r.name, r]));
  for (const l of layout.links) {
    if (l.kind !== 'open') continue;
    const a = byName.get(l.a);
    const b = byName.get(l.b);
    if (a && b && sharedEdge(a, b) > EPS) parent.set(find(a.name), find(b.name));
  }
  return new Set(layout.rooms.map((r) => find(r.name))).size;
}
