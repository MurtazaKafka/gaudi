/**
 * The built-in layout engine — no AI, deterministic.
 *
 * A house is assembled from rectangular wings: one public wing (living,
 * kitchen, dining and friends, packed by recursive bisection) and up to two
 * private wings (bedrooms and baths in rows along a hall, or — for a couple of
 * rooms — directly off the living space). A "recipe" picks the arrangement
 * (side by side, split wings, front/back, L, T, U) and its depths; the engine
 * tries a few hundred recipes, throws out any whose rooms are too narrow,
 * unreachable or outside the lot, scores the rest on proportions and how well
 * they hit the brief, and returns the best few that genuinely differ.
 */
import { ensureConnected, OUTSIDE, sharedEdge, type Layout, type LayoutLink, type LayoutRoom, type RoomType } from './layout';
import { auditLayout, bounds, DIMS, doorNeed, exposure, maxExposure, type Side } from './audit';
import { roomProgram, scaleProgram, targetArea, type Brief, type ProgramRoom, type ShapeId } from './brief';

const GRID = 0.5;
const EPS = 1e-6;
const snap = (v: number) => Math.round(v / GRID) * GRID;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed extends LayoutRoom {
  /** m² the program wanted */ target: number;
  /** index of the wing it sits in */ wing: number;
  ensuiteOf?: string;
}

export type Scheme = 'side' | 'split' | 'frontback' | 'L' | 'T' | 'U';

export interface Recipe {
  scheme: Scheme;
  /** depth of the main body / public bar (m) */
  d: number;
  /** width of the private wing(s) for L / T / U, or depth of the bedroom band for front/back (m) */
  dw: number;
  /** ordering of the public rooms */
  order: number;
  /** office and laundry sit with the bedrooms instead of the living spaces */
  officePrivate: boolean;
  laundryPrivate: boolean;
  mirror: boolean;
}

export interface ProcOption {
  layout: Layout;
  recipe: Recipe;
  /** lower is better */
  penalty: number;
}

export interface ProcResult {
  options: ProcOption[];
  /** Something the person should know (shape or size couldn't be honoured). */
  note: string | null;
}

/* ------------------------------------------------------------------ */
/* Scoring a single room                                               */
/* ------------------------------------------------------------------ */

export function roomPenalty(type: RoomType, w: number, h: number, target: number): number {
  const d = DIMS[type];
  const lo = Math.min(w, h);
  const hi = Math.max(w, h);
  if (lo < d.hard - EPS) return Infinity;
  let p = 0;
  if (lo < d.pref - EPS) p += (d.pref - lo) * 3;
  const aspect = hi / lo;
  if (aspect > d.aspect * 1.3 + EPS) return Infinity;
  if (aspect > d.aspect) p += (aspect - d.aspect) * 6;
  const dev = Math.abs(w * h - target) / target;
  p += dev * 3 + Math.max(0, dev - 0.35) * 8;
  return p;
}

/* ------------------------------------------------------------------ */
/* Packing primitives                                                  */
/* ------------------------------------------------------------------ */

/** Split `total` into grid-aligned spans close to `ideals`, none below its minimum. */
export function sliceSpan(total: number, ideals: number[], mins: number[]): number[] | null {
  const odd = total - Math.floor(total / GRID + EPS) * GRID;
  if (odd > 1e-4) {
    // Off the grid (a wall the person drew): solve on the grid and give the odd bit to the largest span.
    let big = 0;
    ideals.forEach((v, i) => {
      if (v > ideals[big]) big = i;
    });
    const m = mins.slice();
    m[big] = Math.max(0, m[big] - odd);
    const out = sliceSpan(total - odd, ideals, m);
    if (!out) return null;
    out[big] += odd;
    return out;
  }
  const sumMin = mins.reduce((s, v) => s + v, 0);
  if (sumMin > total + EPS) return null;
  const sumIdeal = ideals.reduce((s, v) => s + v, 0) || 1;
  const want = ideals.map((v) => (v / sumIdeal) * total);
  const out = want.map((v, i) => Math.max(mins[i], snap(v)));
  let guard = 400;
  let sum = out.reduce((s, v) => s + v, 0);
  while (Math.abs(sum - total) > EPS && guard-- > 0) {
    let pick = -1;
    let best = -Infinity;
    if (sum > total) {
      out.forEach((v, i) => {
        if (v - GRID >= mins[i] - EPS && v - want[i] > best) {
          best = v - want[i];
          pick = i;
        }
      });
      if (pick < 0) return null;
      out[pick] -= GRID;
      sum -= GRID;
    } else {
      out.forEach((v, i) => {
        if (want[i] - v > best) {
          best = want[i] - v;
          pick = i;
        }
      });
      out[pick] += GRID;
      sum += GRID;
    }
  }
  return Math.abs(sum - total) > EPS ? null : out;
}

export interface Packed {
  rooms: { room: ProgramRoom; rect: Rect }[];
  penalty: number;
}

/**
 * Recursive bisection of a rectangle among an ordered list of rooms: rooms
 * next to each other in the list end up next to each other in space.
 */
export function bisect(rect: Rect, rooms: ProgramRoom[]): Packed | null {
  if (rooms.length === 0) return { rooms: [], penalty: 0 };
  if (rooms.length === 1) {
    const p = roomPenalty(rooms[0].type, rect.w, rect.h, rooms[0].area);
    return Number.isFinite(p) ? { rooms: [{ room: rooms[0], rect }], penalty: p } : null;
  }
  const total = rooms.reduce((s, r) => s + r.area, 0);
  // Candidate split points: the most balanced one and its neighbours.
  let acc = 0;
  let mid = 1;
  let bestGap = Infinity;
  for (let i = 1; i < rooms.length; i++) {
    acc += rooms[i - 1].area;
    const gap = Math.abs(acc - total / 2);
    if (gap < bestGap) {
      bestGap = gap;
      mid = i;
    }
  }
  const ks = [...new Set([mid, mid - 1, mid + 1])].filter((k) => k >= 1 && k < rooms.length);
  let best: Packed | null = null;
  for (const k of ks) {
    const left = rooms.slice(0, k);
    const right = rooms.slice(k);
    const frac = left.reduce((s, r) => s + r.area, 0) / total;
    const minOf = (list: ProgramRoom[]) => Math.max(...list.map((r) => DIMS[r.type].hard));
    for (const alongX of [true, false]) {
      const len = alongX ? rect.w : rect.h;
      const lo = minOf(left);
      const hi = len - minOf(right);
      if (hi < lo - EPS) continue;
      const cut = Math.min(hi, Math.max(lo, snap(len * frac)));
      const ra: Rect = alongX ? { ...rect, w: cut } : { ...rect, h: cut };
      const rb: Rect = alongX
        ? { ...rect, x: rect.x + cut, w: rect.w - cut }
        : { ...rect, y: rect.y + cut, h: rect.h - cut };
      const a = bisect(ra, left);
      if (!a) continue;
      const b = bisect(rb, right);
      if (!b) continue;
      const penalty = a.penalty + b.penalty;
      if (!best || penalty < best.penalty) best = { rooms: [...a.rooms, ...b.rooms], penalty };
    }
  }
  return best;
}

/** How deep along the hall a room likes to sit (0 = by the living spaces). */
export const DEPTH_RANK: Partial<Record<RoomType, number>> = {
  laundry: 0, bathroom: 1, office: 2, bedroom: 3, primary_bedroom: 4, primary_bath: 5,
};

export interface RowsResult extends Packed {
  /** hall rectangle in the wing's local frame */
  hall: Rect;
}

/**
 * Bedrooms and baths in one or two rows along a hall. Local frame: the hall
 * runs along x across the full length L; rows sit above (and below) it.
 */
export function fillRows(L: number, D: number, rooms: ProgramRoom[], loaded: 1 | 2, hw: number, gallery: boolean): RowsResult | null {
  // The ensuite travels with its bedroom.
  const units: ProgramRoom[][] = [];
  for (const r of rooms) {
    if (r.ensuiteOf) continue;
    const bath = rooms.find((o) => o.ensuiteOf === r.name);
    units.push(bath ? [r, bath] : [r]);
  }
  const rank = (u: ProgramRoom[]) => DEPTH_RANK[u[0].type] ?? 2;
  const order = (list: ProgramRoom[][]): ProgramRoom[] => {
    const sorted = list.slice().sort((a, b) => rank(a) - rank(b));
    if (!gallery) return sorted.flat();
    // Along a gallery there is no "deep end": put the baths between the bedrooms.
    const wet = sorted.filter((u) => rank(u) <= 1);
    const dry = sorted.filter((u) => rank(u) > 1);
    const half = Math.floor(dry.length / 2);
    return [...dry.slice(0, half), ...wet, ...dry.slice(half)].flat();
  };
  const areaOf = (list: ProgramRoom[]) => list.reduce((s, r) => s + r.area, 0);

  const layRow = (list: ProgramRoom[], y: number, depth: number): Packed | null => {
    const widths = sliceSpan(
      L,
      list.map((r) => r.area / depth),
      list.map((r) => DIMS[r.type].hard),
    );
    if (!widths) return null;
    let x = 0;
    let penalty = 0;
    const out: Packed['rooms'] = [];
    for (let i = 0; i < list.length; i++) {
      const rect = { x, y, w: widths[i], h: depth };
      const p = roomPenalty(list[i].type, rect.w, rect.h, list[i].area);
      if (!Number.isFinite(p)) return null;
      penalty += p;
      out.push({ room: list[i], rect });
      x += widths[i];
    }
    return { rooms: out, penalty };
  };

  if (loaded === 1) {
    const depth = D - hw;
    const row = layRow(order(units), 0, depth);
    if (!row) return null;
    return { ...row, hall: { x: 0, y: depth, w: L, h: hw } };
  }

  const free = D - hw;
  let best: RowsResult | null = null;
  const n = units.length;
  if (n < 2) return null;
  // Every way of dealing the units into two rows (the first unit stays in row A).
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const a: ProgramRoom[][] = [units[0]];
    const b: ProgramRoom[][] = [];
    for (let i = 1; i < n; i++) (mask & (1 << (i - 1)) ? b : a).push(units[i]);
    if (b.length === 0) continue;
    const la = order(a);
    const lb = order(b);
    const needA = Math.max(2.5, ...la.map((r) => DIMS[r.type].hard));
    const needB = Math.max(2.5, ...lb.map((r) => DIMS[r.type].hard));
    if (needA + needB > free + EPS) continue;
    const dA = Math.min(free - needB, Math.max(needA, snap((free * areaOf(la)) / (areaOf(la) + areaOf(lb)))));
    const ra = layRow(la, 0, dA);
    if (!ra) continue;
    const rb = layRow(lb, dA + hw, free - dA);
    if (!rb) continue;
    const penalty = ra.penalty + rb.penalty;
    if (!best || penalty < best.penalty) {
      best = { rooms: [...ra.rooms, ...rb.rooms], penalty, hall: { x: 0, y: dA, w: L, h: hw } };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Wings                                                               */
/* ------------------------------------------------------------------ */

interface WingSpec {
  mode: 'public' | 'rows' | 'direct';
  rect: Rect;
  rooms: ProgramRoom[];
  /** rows / direct: the side that touches the living wing */
  attach?: Side;
  loaded?: 1 | 2;
  /** rows, single-loaded: the hall lies along the attach side instead of running away from it */
  gallery?: boolean;
  /** rows, single-loaded spine: put the hall on the other long edge */
  flip?: boolean;
}

interface Built {
  rooms: Placed[];
  links: LayoutLink[];
  penalty: number;
  halls: { name: string; wing: number; gallery: boolean }[];
}

const fillCache = new Map<string, RowsResult | null>();
const packCache = new Map<string, Packed | null>();

/** `bisect`, remembered by size and room list (the search asks for the same packing many times). */
function pack(rect: Rect, rooms: ProgramRoom[]): Packed | null {
  const key = `${rect.w}|${rect.h}|${rooms.map((r) => `${r.name}:${r.area.toFixed(2)}`).join(',')}`;
  let hit = packCache.get(key);
  if (hit === undefined) {
    hit = bisect({ x: 0, y: 0, w: rect.w, h: rect.h }, rooms);
    packCache.set(key, hit);
  }
  if (!hit) return null;
  return {
    penalty: hit.penalty,
    rooms: hit.rooms.map((p) => ({ room: p.room, rect: { ...p.rect, x: p.rect.x + rect.x, y: p.rect.y + rect.y } })),
  };
}

function buildWings(wings: WingSpec[], hw: number): Built | null {
  const rooms: Placed[] = [];
  const links: LayoutLink[] = [];
  const halls: Built['halls'] = [];
  let penalty = 0;
  const place = (room: ProgramRoom, rect: Rect, wing: number) =>
    rooms.push({
      name: room.name, type: room.type, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      target: room.area, wing, ...(room.ensuiteOf ? { ensuiteOf: room.ensuiteOf } : {}),
    });

  for (let wi = 0; wi < wings.length; wi++) {
    const wing = wings[wi];
    const { rect } = wing;
    if (wing.rooms.length === 0) continue;
    if (rect.w < 1 - EPS || rect.h < 1 - EPS) return null;

    if (wing.mode === 'public') {
      const packed = pack(rect, wing.rooms);
      if (!packed) return null;
      penalty += packed.penalty;
      for (const p of packed.rooms) place(p.room, p.rect, wi);
      continue;
    }

    const attach = wing.attach!;
    const horizontalEdge = attach === 'N' || attach === 'S';

    if (wing.mode === 'direct') {
      // A row along the attach edge: every room touches the living wing.
      const edge = horizontalEdge ? rect.w : rect.h;
      const thick = horizontalEdge ? rect.h : rect.w;
      const list = wing.rooms.slice().sort((a, b) => (DEPTH_RANK[a.type] ?? 2) - (DEPTH_RANK[b.type] ?? 2));
      const spans = sliceSpan(edge, list.map((r) => r.area / thick), list.map((r) => DIMS[r.type].hard));
      if (!spans) return null;
      let at = 0;
      for (let i = 0; i < list.length; i++) {
        const r: Rect = horizontalEdge
          ? { x: rect.x + at, y: rect.y, w: spans[i], h: thick }
          : { x: rect.x, y: rect.y + at, w: thick, h: spans[i] };
        const p = roomPenalty(list[i].type, r.w, r.h, list[i].area);
        if (!Number.isFinite(p)) return null;
        penalty += p;
        place(list[i], r, wi);
        at += spans[i];
      }
      for (const r of list) if (r.ensuiteOf) links.push({ a: r.name, b: r.ensuiteOf, kind: 'door' });
      continue;
    }

    // rows: fill in a local frame (hall along local x), then map into place.
    const gallery = !!wing.gallery;
    const loaded = wing.loaded ?? 2;
    // Local x runs along the hall. A spine's hall runs away from the attach edge; a gallery's along it.
    const alongX = gallery ? horizontalEdge : !horizontalEdge;
    const L = alongX ? rect.w : rect.h;
    const D = alongX ? rect.h : rect.w;
    const key = `${L}|${D}|${loaded}|${hw}|${gallery}|${wing.rooms.map((r) => `${r.name}:${r.area.toFixed(2)}`).join(',')}`;
    let filled = fillCache.get(key);
    if (filled === undefined) {
      filled = fillRows(L, D, wing.rooms, loaded, hw, gallery);
      fillCache.set(key, filled);
    }
    if (!filled) return null;
    // Local "far" end / hall side → the right global direction.
    const flipLong = gallery ? false : attach === 'E' || attach === 'S';
    const flipCross = gallery ? attach === 'N' || attach === 'W' : !!wing.flip;
    const toGlobal = (r: Rect): Rect => {
      const lx = flipLong ? L - r.x - r.w : r.x;
      const ly = flipCross ? D - r.y - r.h : r.y;
      return alongX
        ? { x: rect.x + lx, y: rect.y + ly, w: r.w, h: r.h }
        : { x: rect.x + ly, y: rect.y + lx, w: r.h, h: r.w };
    };
    const hallName = halls.length === 0 ? 'Hall' : `Hall ${halls.length + 1}`;
    const hr = toGlobal(filled.hall);
    rooms.push({ name: hallName, type: 'hall', ...hr, target: hr.w * hr.h, wing: wi });
    halls.push({ name: hallName, wing: wi, gallery });
    penalty += filled.penalty;
    for (const p of filled.rooms) {
      place(p.room, toGlobal(p.rect), wi);
      links.push(
        p.room.ensuiteOf
          ? { a: p.room.name, b: p.room.ensuiteOf, kind: 'door' }
          : { a: p.room.name, b: hallName, kind: 'door' },
      );
    }
  }
  return { rooms, links, penalty, halls };
}

/* ------------------------------------------------------------------ */
/* Doors and openings between the wings                                */
/* ------------------------------------------------------------------ */

const HUB: Partial<Record<RoomType, number>> = { living: 5, entry: 4, hall: 4, dining: 3, kitchen: 1 };

/** Add the links a sensible house has; returns extra penalty, or null if the plan can't work. */
function connect(built: Built, hw: number): { links: LayoutLink[]; penalty: number } | null {
  const { rooms } = built;
  const links = built.links.slice();
  let penalty = 0;
  const linked = (a: string, b: string) => links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  const tryLink = (a: Placed, b: Placed, kind: 'door' | 'open'): boolean => {
    if (linked(a.name, b.name)) return true;
    const shared = sharedEdge(a, b);
    if (kind === 'open' ? shared < 1.5 - EPS : shared < doorNeed(a.type, b.type) - EPS) return false;
    links.push({ a: a.name, b: b.name, kind });
    return true;
  };
  const first = (type: RoomType) => rooms.find((r) => r.type === type);
  const all = (type: RoomType) => rooms.filter((r) => r.type === type);
  const firstOf = (from: Placed, types: RoomType[], kind: 'door' | 'open' = 'door'): boolean => {
    for (const t of types) for (const o of all(t)) if (o !== from && tryLink(from, o, kind)) return true;
    return false;
  };

  // Halls open onto the living spaces.
  for (const hall of built.halls) {
    const h = rooms.find((r) => r.name === hall.name)!;
    const near = rooms
      .filter((o) => o.wing !== h.wing && HUB[o.type] !== undefined)
      .map((o) => ({ o, shared: sharedEdge(h, o) }))
      .filter((c) => c.shared > 0.5 - EPS)
      .sort((p, q) => HUB[q.o.type]! - HUB[p.o.type]! || q.shared - p.shared);
    if (hall.gallery) {
      const wide = near.filter((c) => c.shared >= 1.5 - EPS);
      if (wide.length === 0) return null;
      links.push({ a: h.name, b: wide[0].o.name, kind: 'door' });
      if (wide[0].o.type === 'kitchen') penalty += 3;
      const second = wide.slice(1).find((c) => HUB[c.o.type]! >= 3);
      if (second) links.push({ a: h.name, b: second.o.name, kind: 'door' });
    } else {
      const total = near.reduce((s, c) => s + c.shared, 0);
      if (near.length === 0 || total < hw - EPS) return null;
      if (near[0].shared >= hw - EPS) {
        links.push({ a: h.name, b: near[0].o.name, kind: near[0].shared >= 1.5 - EPS && hw >= 1.5 ? 'door' : 'open' });
        if (near[0].o.type === 'kitchen') penalty += 3;
      } else {
        // The hall end straddles two living spaces: open to both.
        for (const c of near) links.push({ a: h.name, b: c.o.name, kind: 'open' });
        penalty += 2;
      }
    }
  }

  // Rooms in a hall-less wing get a door straight onto the living spaces.
  const hallWings = new Set(built.halls.map((h) => h.wing));
  for (const r of rooms) {
    if (r.ensuiteOf || r.type === 'hall' || hallWings.has(r.wing)) continue;
    if (!['bedroom', 'primary_bedroom', 'bathroom', 'office', 'laundry'].includes(r.type)) continue;
    const order: RoomType[] =
      r.type === 'laundry'
        ? ['kitchen', 'hall', 'entry', 'garage', 'dining', 'living']
        : r.type === 'bathroom'
          ? ['hall', 'entry', 'living', 'dining', 'laundry', 'kitchen']
          : ['hall', 'living', 'entry', 'dining', 'kitchen'];
    if (!firstOf(r, order)) penalty += 6;
    else if (linked(r.name, first('kitchen')?.name ?? '') && r.type !== 'laundry') penalty += 3;
  }

  // The living spaces flow into each other.
  const kitchen = first('kitchen');
  const dining = first('dining');
  const living = first('living');
  if (kitchen && dining && !tryLink(kitchen, dining, 'open') && !tryLink(kitchen, dining, 'door')) penalty += 8;
  if (dining && living && !tryLink(dining, living, 'open') && !tryLink(dining, living, 'door')) penalty += 6;
  if (kitchen && living && !tryLink(kitchen, living, 'open') && !dining && !tryLink(kitchen, living, 'door')) penalty += 4;

  const entry = first('entry');
  if (entry) {
    const ok =
      (living && tryLink(entry, living, 'open')) ||
      firstOf(entry, ['living', 'dining', 'hall', 'kitchen']);
    if (!ok) penalty += 5;
  }
  const pantry = first('pantry');
  if (pantry && !firstOf(pantry, ['kitchen'])) {
    penalty += 4;
    firstOf(pantry, ['dining', 'hall', 'laundry', 'living']);
  }
  const garage = first('garage');
  if (garage && !firstOf(garage, ['entry', 'laundry', 'hall', 'kitchen', 'living', 'dining'])) penalty += 5;

  // Front door: the entry if there is one, else the living room.
  for (const type of ['entry', 'living', 'dining', 'kitchen', 'hall'] as RoomType[]) {
    const r = first(type);
    if (r && maxExposure(r, rooms).len >= doorNeed(r.type, null) - EPS) {
      links.push({ a: r.name, b: OUTSIDE, kind: 'door' });
      if (type !== 'entry' && type !== 'living') penalty += 2;
      break;
    }
  }
  return { links, penalty };
}

/* ------------------------------------------------------------------ */
/* Recipes → wings                                                     */
/* ------------------------------------------------------------------ */

interface Program {
  pub: ProgramRoom[];
  /** all private rooms */
  priv: ProgramRoom[];
  /** private rooms split in two groups (primary suite / the rest); g2 is empty when there is only one bedroom */
  g1: ProgramRoom[];
  g2: ProgramRoom[];
}

const isBed = (r: ProgramRoom) => r.type === 'bedroom' || r.type === 'primary_bedroom';
const sum = (list: ProgramRoom[]) => list.reduce((s, r) => s + r.area, 0);

function zoneProgram(rooms: ProgramRoom[], recipe: Recipe): Program {
  const beds = rooms.filter(isBed);
  const moved = (r: ProgramRoom) =>
    beds.length >= 2 && ((r.type === 'office' && recipe.officePrivate) || (r.type === 'laundry' && recipe.laundryPrivate));
  let pub = rooms.filter((r) => r.zone === 'public' && !moved(r));
  let priv = rooms.filter((r) => r.zone === 'private' || moved(r));
  // Without a bedroom there is no private wing: the bath joins the living spaces.
  if (beds.length === 0) {
    pub = [...pub, ...priv];
    priv = [];
  }
  let g1: ProgramRoom[] = [];
  let g2: ProgramRoom[] = [];
  if (beds.length >= 2) {
    const head = beds[0];
    g1 = priv.filter((r) => r === head || r.ensuiteOf === head.name);
    g2 = priv.filter((r) => !g1.includes(r));
    // A lone bedroom wing reads better with company.
    const office = g2.find((r) => r.type === 'office');
    if (office && g2.length > 3) {
      g1 = [...g1, office];
      g2 = g2.filter((r) => r !== office);
    }
  } else g1 = priv;
  return { pub, priv, g1, g2 };
}

/** The order the public rooms are handed to the packer (neighbours in the list become neighbours in space). */
export function orderPublic(pub: ProgramRoom[], order: number): ProgramRoom[] {
  const get = (t: RoomType) => pub.filter((r) => r.type === t);
  const L = get('living');
  const D = get('dining');
  const K = get('kitchen');
  const kitchenSide = [...get('pantry'), ...get('laundry'), ...get('garage')];
  const livingSide = [...get('entry'), ...get('office'), ...get('bathroom')];
  const rest = pub.filter(
    (r) => !['living', 'dining', 'kitchen', 'pantry', 'laundry', 'garage', 'entry', 'office', 'bathroom'].includes(r.type),
  );
  switch (order % 4) {
    case 0: // office · entry · living · dining · kitchen · pantry · laundry · garage
      return [...livingSide.slice().reverse(), ...L, ...D, ...K, ...kitchenSide, ...rest];
    case 1: // mirror image of the list (matters when wings attach at one end)
      return [...rest, ...kitchenSide.slice().reverse(), ...K, ...D, ...L, ...livingSide];
    case 2: // kitchen in the middle
      return [...livingSide.slice().reverse(), ...L, ...K, ...kitchenSide, ...D, ...rest];
    default: // living in the middle, entry beside it
      return [...D, ...K, ...kitchenSide, ...L, ...livingSide, ...rest];
  }
}

interface Assembly {
  wings: WingSpec[];
}

/** How a private group is laid out in a wing `across` meters wide. */
function wingMode(group: ProgramRoom[], across: number, hw: number): { mode: 'rows' | 'direct'; loaded: 1 | 2 } {
  const units = group.filter((r) => !r.ensuiteOf).length;
  if (units < 3) return { mode: 'direct', loaded: 1 };
  return { mode: 'rows', loaded: across - hw >= 5.5 - EPS ? 2 : 1 };
}

/** Length (away from the attach edge) a private wing needs. */
function wingLength(group: ProgramRoom[], across: number, hw: number): number {
  const m = wingMode(group, across, hw);
  if (m.mode === 'direct') return Math.max(2.5, snap(sum(group) / across));
  return Math.max(3, snap(sum(group) / (across - hw)));
}

function assemble(recipe: Recipe, rooms: ProgramRoom[], total: number, hw: number): Assembly | null {
  const prog = zoneProgram(rooms, recipe);
  const pubList = orderPublic(prog.pub, recipe.order);
  if (pubList.length === 0) return null;
  const D = recipe.d;
  const spec = (group: ProgramRoom[], rect: Rect, attach: Side, across: number, extra: Partial<WingSpec> = {}): WingSpec => {
    const m = wingMode(group, across, hw);
    return { mode: m.mode, loaded: m.loaded, rect, rooms: group, attach, ...extra };
  };

  switch (recipe.scheme) {
    case 'side': {
      if (prog.priv.length === 0) {
        const W = Math.max(3, snap(total / D));
        return { wings: [{ mode: 'public', rect: { x: 0, y: 0, w: W, h: D }, rooms: pubList }] };
      }
      const Lp = wingLength(prog.priv, D, hw);
      const Wpub = snap((total - Lp * D) / D);
      if (Wpub < 3) return null;
      return {
        wings: [
          { mode: 'public', rect: { x: Lp, y: 0, w: Wpub, h: D }, rooms: pubList },
          spec(prog.priv, { x: 0, y: 0, w: Lp, h: D }, 'E', D, { flip: recipe.order >= 4 }),
        ],
      };
    }
    case 'split': {
      if (prog.g2.length === 0) return null;
      const L1 = wingLength(prog.g1, D, hw);
      const L2 = wingLength(prog.g2, D, hw);
      const Wpub = snap((total - (L1 + L2) * D) / D);
      if (Wpub < 3) return null;
      return {
        wings: [
          { mode: 'public', rect: { x: L1, y: 0, w: Wpub, h: D }, rooms: pubList },
          spec(prog.g1, { x: 0, y: 0, w: L1, h: D }, 'E', D),
          spec(prog.g2, { x: L1 + Wpub, y: 0, w: L2, h: D }, 'W', D, { flip: recipe.order >= 4 }),
        ],
      };
    }
    case 'frontback': {
      // Bedrooms in a band at the back, a gallery hall between them and the living spaces.
      if (prog.priv.filter((r) => !r.ensuiteOf).length < 3) return null;
      const Dp = recipe.dw;
      const W = Math.max(snap(sum(prog.priv) / (Dp - hw)), snap(total / (Dp + D)));
      const Dpub = snap((total - W * Dp) / W);
      if (Dpub < 3.5 || Dpub > 8.5) return null;
      return {
        wings: [
          { mode: 'public', rect: { x: 0, y: Dp, w: W, h: Dpub }, rooms: pubList },
          { mode: 'rows', loaded: 1, gallery: true, attach: 'S', rect: { x: 0, y: 0, w: W, h: Dp }, rooms: prog.priv },
        ],
      };
    }
    case 'L':
    case 'T': {
      const Dw = recipe.dw;
      let wingRooms = prog.priv;
      let base = pubList;
      let publicWing = false;
      if (wingRooms.length === 0) {
        // No bedrooms: the kitchen side becomes the wing.
        wingRooms = pubList.filter((r) => ['kitchen', 'dining', 'pantry'].includes(r.type));
        base = pubList.filter((r) => !wingRooms.includes(r));
        publicWing = true;
        if (wingRooms.length === 0 || base.length === 0) return null;
      }
      const Lw = publicWing ? Math.max(3, snap(sum(wingRooms) / Dw)) : wingLength(wingRooms, Dw, hw);
      const Wb = snap((total - Dw * Lw) / D);
      const centered = recipe.scheme === 'T';
      if (Wb < Dw + (centered ? 4 : 2.5)) return null;
      const x0 = centered ? snap((Wb - Dw) / 2) : 0;
      const rect = { x: x0, y: -Lw, w: Dw, h: Lw };
      return {
        wings: [
          { mode: 'public', rect: { x: 0, y: 0, w: Wb, h: D }, rooms: base },
          publicWing ? { mode: 'public', rect, rooms: wingRooms } : spec(wingRooms, rect, 'S', Dw, { flip: recipe.order >= 4 }),
        ],
      };
    }
    case 'U': {
      const Dw = recipe.dw;
      const g1 = prog.g1;
      let g2 = prog.g2;
      let base = pubList;
      let g2Public = false;
      if (g1.length === 0) return null;
      if (g2.length === 0) {
        g2 = pubList.filter((r) => ['kitchen', 'dining', 'pantry', 'laundry'].includes(r.type));
        base = pubList.filter((r) => !g2.includes(r));
        g2Public = true;
        if (g2.length === 0 || base.length === 0) return null;
      }
      // The smaller group gets the narrower wing.
      const Dw1 = wingMode(g1, Dw, hw).mode === 'direct' ? Math.min(Dw, 5) : Math.max(Dw, 4.5);
      const Dw2 = g2Public
        ? Math.min(Dw, 4.5)
        : wingMode(g2, Dw, hw).mode === 'direct' ? Math.min(Dw, 5) : Math.max(Dw, 4.5);
      let L1 = wingLength(g1, Dw1, hw);
      let L2 = g2Public ? Math.max(3, snap(sum(g2) / Dw2)) : wingLength(g2, Dw2, hw);
      if (Math.abs(L1 - L2) <= 1.5) L1 = L2 = Math.max(L1, L2);
      const Wb = Math.max(snap((total - Dw1 * L1 - Dw2 * L2) / D), Dw1 + Dw2 + 2.5);
      const r1 = { x: 0, y: -L1, w: Dw1, h: L1 };
      const r2 = { x: Wb - Dw2, y: -L2, w: Dw2, h: L2 };
      return {
        wings: [
          { mode: 'public', rect: { x: 0, y: 0, w: Wb, h: D }, rooms: base },
          spec(g1, r1, 'S', Dw1),
          g2Public ? { mode: 'public', rect: r2, rooms: g2 } : spec(g2, r2, 'S', Dw2, { flip: true }),
        ],
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

export const TITLES: Record<Scheme, [string, string]> = {
  side: ['Bedroom wing', 'Living spaces at one end, bedrooms along a hall at the other.'],
  split: ['Split bedrooms', 'The main bedroom at one end, the others at the far end, living in between.'],
  frontback: ['Front and back', 'Living spaces across the front, bedrooms in a row behind a gallery hall.'],
  L: ['L with a bedroom wing', 'A living bar with the bedroom wing turning the corner.'],
  T: ['T plan', 'A living bar with the bedroom wing running back from its middle.'],
  U: ['Courtyard wings', 'Two wings reach back from the living bar around a sheltered court.'],
};

interface Candidate extends ProcOption {
  w: number;
  h: number;
  /** needs a quarter turn to fit the lot / make a C */
  turn: boolean;
  /** how far the floor area is from the goal (0.1 = 10%) */
  off: number;
}

function range(from: number, to: number, step = GRID): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + EPS; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

function recipesFor(shape: ShapeId, hasOffice: boolean, hasLaundry: boolean): Recipe[] {
  const out: Recipe[] = [];
  const zonings: [boolean, boolean][] = [[false, false]];
  if (hasOffice) zonings.push([true, false]);
  if (hasLaundry) zonings.push([false, true]);
  if (hasOffice && hasLaundry) zonings.push([true, true]);
  const push = (scheme: Scheme, d: number, dw: number, orders: number) => {
    for (let order = 0; order < orders; order++) {
      for (const [officePrivate, laundryPrivate] of zonings) {
        out.push({ scheme, d, dw, order, officePrivate, laundryPrivate, mirror: false });
      }
    }
  };
  const want = (s: ShapeId) => shape === 'any' || shape === s;
  if (want('rect') || want('bar')) {
    for (const d of range(4.5, 11)) {
      push('side', d, 0, 8);
      push('split', d, 0, 8);
    }
    for (const d of [5, 6, 7]) for (const dw of [4, 4.5, 5]) push('frontback', d, dw, 4);
  }
  const wingWidths = [3, 3.5, 4, 4.5, 5, 5.5, 7, 7.5, 8];
  if (want('L')) for (const d of range(4, 7)) for (const dw of wingWidths) push('L', d, dw, 8);
  if (want('T')) for (const d of range(4, 7)) for (const dw of wingWidths) push('T', d, dw, 8);
  if (want('U') || want('C')) for (const d of range(3.5, 6.5)) for (const dw of wingWidths) push('U', d, dw, 4);
  return out;
}

function shapeAccepts(shape: ShapeId, scheme: Scheme, w: number, h: number): boolean {
  const aspect = Math.max(w, h) / Math.min(w, h);
  if (shape === 'rect') return aspect <= 2.3;
  if (shape === 'bar') return aspect >= 2.3;
  if (shape === 'any' && (scheme === 'side' || scheme === 'split' || scheme === 'frontback')) return aspect <= 3.2;
  return true;
}

function evaluate(
  recipe: Recipe,
  brief: Brief,
  rooms: ProgramRoom[],
  total: number,
  goal: number,
  hw: number,
): Candidate | null {
  const asm = assemble(recipe, rooms, total, hw);
  if (!asm) return null;
  // The outline is known before any room is placed: reject on shape and lot first.
  const used = asm.wings.filter((w) => w.rooms.length > 0).map((w) => w.rect);
  const bx = Math.min(...used.map((r) => r.x));
  const by = Math.min(...used.map((r) => r.y));
  const box = {
    w: Math.max(...used.map((r) => r.x + r.w)) - bx,
    h: Math.max(...used.map((r) => r.y + r.h)) - by,
  };
  const outline = used.reduce((a, r) => a + r.w * r.h, 0);
  const off = Math.abs(outline - goal) / goal;
  if (off > 0.2) return null;
  if (!shapeAccepts(brief.shape, recipe.scheme, box.w, box.h)) return null;
  let turn = brief.shape === 'C';
  if (brief.lot) {
    const fits = (w: number, h: number) => w <= brief.lot!.w + EPS && h <= brief.lot!.d + EPS;
    const upright = fits(box.w, box.h);
    const turned = fits(box.h, box.w);
    if (brief.shape === 'C') {
      if (!turned) return null;
    } else if (brief.shape === 'U') {
      if (!upright) return null;
    } else if (upright) turn = false;
    else if (turned) turn = true;
    else return null;
  }

  const built = buildWings(asm.wings, hw);
  if (!built) return null;
  const con = connect(built, hw);
  if (!con) return null;
  const draft: Layout = {
    rooms: built.rooms.map(({ name, type, x, y, w, h }) => ({ name, type, x, y, w, h })),
    links: con.links,
  };
  const layout = ensureConnected(draft);
  const patched = layout.links.length - draft.links.length;
  const audit = auditLayout(layout);
  if (audit.unreachable.length || audit.throughBedroom.length || audit.narrow.length || !audit.entrance) return null;

  let penalty = built.penalty + con.penalty + patched * 8;
  // Daylight: habitable rooms want an outside wall.
  for (const r of built.rooms) {
    if (!['bedroom', 'primary_bedroom', 'living', 'kitchen', 'dining', 'office'].includes(r.type)) continue;
    const e = exposure(r, built.rooms);
    if (Math.max(e.N, e.S, e.E, e.W) < 1.7) penalty += r.type === 'kitchen' || r.type === 'dining' ? 3 : 8;
  }
  const area = built.rooms.reduce((s, r) => s + r.w * r.h, 0);
  penalty += off * 40 + Math.max(0, off - 0.06) * 120;
  const hallArea = built.rooms.filter((r) => r.type === 'hall').reduce((s, r) => s + r.w * r.h, 0);
  penalty += Math.max(0, hallArea / area - 0.08) * 60;
  // A house much longer than deep wastes wall; a gentle nudge toward compact unless a bar was asked for.
  if (brief.shape !== 'bar') penalty += Math.max(0, Math.max(box.w, box.h) / Math.min(box.w, box.h) - 2.2) * 2;

  const [title, summary] = TITLES[recipe.scheme];
  return { layout: { ...layout, title, summary }, recipe, penalty, w: box.w, h: box.h, turn, off };
}

/* ------------------------------------------------------------------ */
/* Orientation                                                         */
/* ------------------------------------------------------------------ */

function transform(layout: Layout, fn: (r: LayoutRoom) => LayoutRoom): Layout {
  return { ...layout, rooms: layout.rooms.map(fn) };
}
const mirrorX = (l: Layout) => transform(l, (r) => ({ ...r, x: -(r.x + r.w) }));
const mirrorY = (l: Layout) => transform(l, (r) => ({ ...r, y: -(r.y + r.h) }));
const transpose = (l: Layout) => transform(l, (r) => ({ ...r, x: r.y, y: r.x, w: r.h, h: r.w }));

/** Turn / mirror the finished layout: fit the lot, put the front door toward the street (south). */
function orient(c: Candidate): Layout {
  let layout = c.layout;
  if (c.recipe.mirror) layout = mirrorX(layout);
  if (c.turn) layout = transpose(layout);
  const side = auditLayout(layout).entrance?.side;
  if (side === 'N') layout = mirrorY(layout);
  // Re-centre on the grid.
  const b = bounds(layout.rooms);
  const dx = snap(b.x + b.w / 2);
  const dy = snap(b.y + b.h / 2);
  return transform(layout, (r) => ({ ...r, x: r.x - dx, y: r.y - dy }));
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two candidates that would look the same on a card. */
function alike(a: Candidate, b: Candidate): boolean {
  if (a.recipe.scheme !== b.recipe.scheme) return false;
  if (Math.abs(a.w - b.w) > 0.75 || Math.abs(a.h - b.h) > 0.75) return false;
  const sig = (c: Candidate) =>
    c.layout.rooms.map((r) => `${r.name}:${r.x},${r.y},${r.w},${r.h}`).sort().join(';');
  if (sig(a) === sig(b)) return true;
  // Same outline: call them alike unless a fair share of the rooms moved.
  const pos = new Map(a.layout.rooms.map((r) => [r.name, r]));
  let moved = 0;
  for (const r of b.layout.rooms) {
    const o = pos.get(r.name);
    if (!o || Math.abs(o.x - r.x) + Math.abs(o.y - r.y) + Math.abs(o.w - r.w) + Math.abs(o.h - r.h) > 1.01) moved++;
  }
  return moved < Math.max(3, b.layout.rooms.length * 0.4);
}

export interface ProcOptions {
  /** How many options to return (default 5). */
  count?: number;
  /** 0 = the canonical best set; other values shuffle among good candidates and nudge room sizes. */
  seed?: number;
  /** Return variations of this recipe (same arrangement, different depths / ordering / handedness). */
  like?: Recipe;
  /**
   * Return a wide pool instead of a finished set: every good candidate that
   * doesn't look like a better one, unmirrored, with no twins added to make up
   * the count. The caller picks the ones that differ most.
   */
  pool?: boolean;
}

export function generateProcedural(rawBrief: Brief, opts: ProcOptions = {}): ProcResult {
  const count = opts.count ?? 5;
  const seed = opts.seed ?? 0;
  const rand = mulberry32(seed * 7919 + 17);
  fillCache.clear();
  packCache.clear();

  const goal = targetArea(rawBrief);
  const lotArea = rawBrief.lot ? rawBrief.lot.w * rawBrief.lot.d : Infinity;
  const hw = goal >= 210 ? 1.5 : 1;
  const base = roomProgram(rawBrief);
  // Nudge room sizes a little per seed so "again" isn't the same five.
  const jitter = base.map((r) => ({ ...r, area: r.area * (seed === 0 ? 1 : 0.93 + rand() * 0.14) }));
  const hasOffice = base.some((r) => r.type === 'office');
  const hasLaundry = base.some((r) => r.type === 'laundry');

  const run = (brief: Brief, total: number): Candidate[] => {
    const privCount = base.filter((r) => r.zone === 'private' && !r.ensuiteOf).length;
    const reserve = privCount >= 3 ? Math.max(4, total * 0.06) : 0;
    const rooms = scaleProgram(jitter, total, reserve);
    let recipes = recipesFor(brief.shape, hasOffice, hasLaundry);
    if (opts.like) {
      const like = opts.like;
      recipes = recipes.filter((r) => r.scheme === like.scheme);
      if (recipes.length === 0) recipes = recipesFor('any', hasOffice, hasLaundry).filter((r) => r.scheme === like.scheme);
    }
    const found: Candidate[] = [];
    for (const recipe of recipes) {
      const c = evaluate(recipe, brief, rooms, total, total, hw);
      if (c) found.push(c);
    }
    return found;
  };

  let note: string | null = null;
  let brief = rawBrief;
  let total = Math.min(goal, lotArea);
  let found = run(brief, total);
  // Too big for the lot (or the shape): shrink until something fits.
  for (let i = 0; found.length === 0 && i < 7; i++) {
    total *= 0.9;
    found = run(brief, total);
    if (found.length) note = rawBrief.lot ? 'Sized down to fit the lot.' : 'Sized down to make the rooms work.';
  }
  if (found.length === 0 && brief.shape !== 'any') {
    // The shape doesn't suit this brief: show the closest plans instead.
    brief = { ...brief, shape: 'any' };
    total = Math.min(goal, lotArea);
    found = run(brief, total);
    for (let i = 0; found.length === 0 && i < 7; i++) {
      total *= 0.9;
      found = run(brief, total);
    }
    if (found.length) note = 'That shape doesn’t suit these rooms — showing the closest plans.';
  }
  if (found.length === 0) {
    return { options: [], note: rawBrief.lot ? 'These rooms don’t fit on that lot.' : 'Couldn’t lay these rooms out — try fewer rooms or a larger size.' };
  }

  // Plans well off the asked size are a last resort.
  const onSize = found.filter((c) => c.off <= 0.1);
  if (onSize.length) found = onSize;
  found.sort((a, b) => a.penalty - b.penalty);
  if (opts.like) {
    const like = opts.like;
    const same = (r: Recipe) =>
      r.d === like.d && r.dw === like.dw && r.order === like.order &&
      r.officePrivate === like.officePrivate && r.laundryPrivate === like.laundryPrivate;
    found = found.filter((c) => !same(c.recipe));
  }
  if (seed !== 0) {
    // Shuffle within the good ones.
    const cut = found[0].penalty + 14;
    const good = found.filter((c) => c.penalty <= cut);
    const rest = found.filter((c) => c.penalty > cut);
    for (let i = good.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [good[i], good[j]] = [good[j], good[i]];
    }
    found = [...good, ...rest];
  }

  // One of each arrangement first, then the best of the rest — never two that look alike.
  const picked: Candidate[] = [];
  // Variations of one plan are meant to be close; only exact repeats are dropped then.
  const same = (a: Candidate, b: Candidate) =>
    opts.like ? JSON.stringify(a.layout.rooms) === JSON.stringify(b.layout.rooms) : alike(a, b);
  const take = (c: Candidate) => {
    if (picked.length < count && !picked.some((p) => same(p, c))) picked.push(c);
  };
  if (!opts.like) {
    const cap = found[0].penalty + 30;
    const seen = new Set<Scheme>();
    for (const c of found) {
      if (seen.has(c.recipe.scheme) || c.penalty > cap) continue;
      seen.add(c.recipe.scheme);
      take(c);
    }
  }
  // Fill the rest with the next best, but nothing much worse than the best: a mirrored twin beats a poor plan.
  const ceiling = found[0].penalty + (opts.like || opts.pool ? 24 : 14);
  for (const c of found) if (c.penalty <= ceiling) take(c);
  if (picked.length === 0) take(found[0]);
  if (seed === 0 && !opts.like) picked.sort((a, b) => a.penalty - b.penalty);
  if (opts.pool) {
    return { options: picked.map((c) => ({ layout: orient(c), recipe: c.recipe, penalty: c.penalty })), note };
  }
  // Alternate handedness so neighbouring cards read differently.
  const out = picked.map((c, i) => ({ ...c, recipe: { ...c.recipe, mirror: (seed + i) % 2 === 1 } }));
  // Still short: mirrored twins of what we have are better than empty slots.
  for (const c of out.slice()) {
    if (out.length >= count) break;
    out.push({ ...c, recipe: { ...c.recipe, mirror: !c.recipe.mirror } });
  }

  return {
    options: out.map((c) => ({ layout: orient(c), recipe: c.recipe, penalty: c.penalty })),
    note,
  };
}
