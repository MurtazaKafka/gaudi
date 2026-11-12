/**
 * Filling a footprint: lay a brief's rooms out inside any region made of
 * rectangles (an outline the person drew, a preset shape, what is left of a
 * plan around the rooms being kept). Deterministic, no AI.
 *
 * The region is cut into wings (three different ways). The living spaces take
 * a wing or part of one, starting from an anchor wing; what remains is divided
 * among the bedrooms and baths, each piece laid out as rooms along a hall or,
 * for a room or two, straight off the living space. Every arrangement is
 * checked the same way the other engine's are — no narrow rooms, every room
 * reachable without crossing a bedroom — and the best few that differ are
 * returned. When the rooms cannot fit, the least important are left out, and
 * the result says which.
 */
import { ensureConnected, OUTSIDE, sharedEdge, type Layout, type LayoutLink, type LayoutRoom, type RoomType } from './layout';
import { auditLayout, DIMS, doorNeed, exposure, maxExposure, type Side } from './audit';
import { roomProgram, scaleProgram, type Brief, type ProgramRoom } from './brief';
import { bisect, DEPTH_RANK, fillRows, mulberry32, orderPublic, roomPenalty, sliceSpan, type Packed, type RowsResult } from './procedural';
import { cellsFromRects, largestFirst, rectsArea, slabs, type Rect } from './outline';

const GRID = 0.5;
const EPS = 1e-6;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const area = (r: Rect) => r.w * r.h;

interface FRoom extends LayoutRoom {
  /** m² the program wanted (0 for rooms that were already there) */
  target: number;
  /** index of the piece of the footprint it sits in; -1 for kept rooms */
  region: number;
  pub: boolean;
  ensuiteOf?: string;
  fixed?: boolean;
  /** added to use up a leftover piece (closet, storage, hall) */
  auto?: boolean;
}

/* ------------------------------------------------------------------ */
/* The program: what has to fit                                         */
/* ------------------------------------------------------------------ */

function hallReserve(rooms: readonly ProgramRoom[], total: number): number {
  const priv = rooms.filter((r) => r.zone === 'private' && !r.ensuiteOf).length;
  return priv >= 3 ? Math.max(4, total * 0.06) : 0;
}

/** The least floor area these rooms can be squeezed into. */
export function leastArea(rooms: readonly ProgramRoom[], total: number): number {
  return rooms.reduce((s, r) => s + r.min * 0.85, 0) + hallReserve(rooms, total) * 0.8;
}

/** Remove the room a house can best do without. Returns its name, or null when nothing more can go. */
function dropOne(rooms: ProgramRoom[]): string | null {
  const lastOf = (pred: (r: ProgramRoom) => boolean): number => {
    for (let i = rooms.length - 1; i >= 0; i--) if (pred(rooms[i])) return i;
    return -1;
  };
  const take = (i: number): string => rooms.splice(i, 1)[0].name;
  for (const type of ['pantry', 'entry', 'laundry', 'office', 'garage', 'dining'] as RoomType[]) {
    const i = lastOf((r) => r.type === type);
    if (i >= 0) return take(i);
  }
  const baths = rooms.filter((r) => r.type === 'bathroom' || r.type === 'primary_bath').length;
  if (baths > 1) {
    const en = lastOf((r) => r.type === 'primary_bath');
    return take(en >= 0 ? en : lastOf((r) => r.type === 'bathroom'));
  }
  const beds = rooms.filter((r) => r.type === 'bedroom' || r.type === 'primary_bedroom').length;
  if (beds > 1) {
    const plain = lastOf((r) => r.type === 'bedroom');
    if (plain >= 0) return take(plain);
  }
  const hasLiving = rooms.some((r) => r.type === 'living');
  const kitchen = lastOf((r) => r.type === 'kitchen');
  if (kitchen >= 0 && hasLiving) return take(kitchen);
  if (beds === 1) {
    const bed = lastOf((r) => r.type === 'bedroom' || r.type === 'primary_bedroom');
    const en = lastOf((r) => r.type === 'primary_bath');
    if (en >= 0) {
      // The only bath can't stay behind a bedroom that is going.
      const b = rooms[en];
      rooms[en] = { ...b, name: 'Bathroom', type: 'bathroom', ensuiteOf: undefined };
      delete rooms[en].ensuiteOf;
    }
    return take(bed);
  }
  return null;
}

/**
 * The brief's rooms, less one for each room that is being kept (`taken`: what
 * the kept rooms count as), with names that don't collide with theirs.
 */
function startProgram(brief: Brief, fixed: readonly LayoutRoom[], taken?: readonly RoomType[]): ProgramRoom[] {
  const rooms = roomProgram(brief);
  const family = (t: RoomType): RoomType =>
    t === 'primary_bedroom' ? 'bedroom' : t === 'primary_bath' ? 'bathroom' : t;
  const types = taken ?? fixed.map((f) => f.type);
  for (const type of types) {
    let i = rooms.findIndex((r) => r.type === type);
    if (i < 0) {
      // A kept bedroom stands in for the last plain one, a kept bath for the last shared one.
      for (let k = rooms.length - 1; k >= 0 && i < 0; k--) if (family(rooms[k].type) === family(type)) i = k;
    }
    if (i < 0) continue;
    const gone = rooms.splice(i, 1)[0];
    // Its ensuite goes too if one is kept; otherwise a bath that lost its bedroom becomes a plain one.
    for (let k = rooms.length - 1; k >= 0; k--) {
      if (rooms[k].ensuiteOf !== gone.name) continue;
      if (types.includes('primary_bath')) continue;
      rooms[k] = { ...rooms[k], name: 'Bathroom', type: 'bathroom' };
      delete rooms[k].ensuiteOf;
    }
  }
  // An ensuite whose bedroom is not being drawn can't be entered from it.
  for (let k = rooms.length - 1; k >= 0; k--) {
    const of = rooms[k].ensuiteOf;
    if (of && !rooms.some((r) => r.name === of)) {
      rooms[k] = { ...rooms[k], name: 'Bathroom', type: 'bathroom' };
      delete rooms[k].ensuiteOf;
    }
  }
  const used = new Set(fixed.map((f) => f.name.toLowerCase()));
  for (const r of rooms) {
    if (!used.has(r.name.toLowerCase())) {
      used.add(r.name.toLowerCase());
      continue;
    }
    const stem = r.name.replace(/\s+\d+$/, '');
    let n = 2;
    while (used.has(`${stem} ${n}`.toLowerCase())) n++;
    const name = `${stem} ${n}`;
    for (const o of rooms) if (o.ensuiteOf === r.name) o.ensuiteOf = name;
    r.name = name;
    used.add(name.toLowerCase());
  }
  return rooms;
}

export interface ProgramFit {
  /** Rooms that have to be left out for the rest to fit this area. */
  dropped: string[];
  /** m² the asked-for rooms need at ideal sizes (halls included) and at their tightest. */
  ideal: number;
  least: number;
  /** area ÷ ideal */
  ratio: number;
}

/** How a brief sits in a given floor area, before anything is laid out. */
export function programFit(brief: Brief, total: number, fixed: readonly LayoutRoom[] = [], taken?: readonly RoomType[]): ProgramFit {
  const rooms = startProgram(brief, fixed, taken);
  const ideal = rooms.reduce((s, r) => s + r.area, 0) + hallReserve(rooms, total);
  const least = leastArea(rooms, total);
  const dropped: string[] = [];
  while (leastArea(rooms, total) > total + EPS) {
    const d = dropOne(rooms);
    if (!d) break;
    dropped.push(d);
  }
  return { dropped, ideal, least, ratio: ideal > 0 ? total / ideal : 1 };
}

/* ------------------------------------------------------------------ */
/* Wings and zones                                                      */
/* ------------------------------------------------------------------ */

function touch(a: Rect, b: Rect): { len: number; side: Side } | null {
  const xo = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (yo > EPS) {
    if (Math.abs(a.x + a.w - b.x) < EPS) return { len: yo, side: 'E' };
    if (Math.abs(b.x + b.w - a.x) < EPS) return { len: yo, side: 'W' };
  }
  if (xo > EPS) {
    if (Math.abs(a.y + a.h - b.y) < EPS) return { len: xo, side: 'S' };
    if (Math.abs(b.y + b.h - a.y) < EPS) return { len: xo, side: 'N' };
  }
  return null;
}

const rectKey = (r: Rect) => `${r.x.toFixed(3)},${r.y.toFixed(3)},${r.w.toFixed(3)},${r.h.toFixed(3)}`;

/** Different ways of cutting the footprint into rectangular wings. */
export function decompositions(mask: readonly Rect[]): Rect[][] {
  const cells = cellsFromRects(mask);
  const out: Rect[][] = [];
  const seen = new Set<string>();
  for (const rects of [slabs(cells, true), slabs(cells, false), largestFirst(cells)]) {
    if (rects.length === 0 || rects.some((r) => Math.min(r.w, r.h) < 1 - EPS)) continue;
    const key = rects.map(rectKey).sort().join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rects);
  }
  return out;
}

/** Wings in the order you would walk them from `start` (nearest first, longest shared wall first). */
function walkOrder(wings: readonly Rect[], start: number): number[] {
  const order = [start];
  const seen = new Set(order);
  for (let at = 0; at < order.length; at++) {
    const cur = wings[order[at]];
    const next = wings
      .map((w, i) => ({ i, t: seen.has(i) ? null : touch(cur, w) }))
      .filter((c) => c.t && c.t.len >= 1 - EPS)
      .sort((p, q) => q.t!.len - p.t!.len);
    for (const c of next) {
      seen.add(c.i);
      order.push(c.i);
    }
  }
  // Anything only touching at a corner still has to be filled.
  wings.forEach((_, i) => {
    if (!seen.has(i)) order.push(i);
  });
  return order;
}

interface ZonePlan {
  pub: Rect[];
  priv: Rect[];
  key: string;
}

/** Ways of cutting one wing so that `need` m² of it is living space. */
function splitWing(W: Rect, need: number, side: Side | null, mid: number | null): { pub: Rect[]; priv: Rect[] }[] {
  const out: { pub: Rect[]; priv: Rect[] }[] = [];
  const seg = (axisX: boolean, t0: number, t1: number): Rect =>
    axisX ? { x: W.x + t0, y: W.y, w: t1 - t0, h: W.h } : { x: W.x, y: W.y + t0, w: W.w, h: t1 - t0 };
  const tryCut = (axisX: boolean, pubLo: boolean, minPub: number, minPriv: number) => {
    const len = axisX ? W.w : W.h;
    const across = axisX ? W.h : W.w;
    const ideal = snap(need / across);
    const done = new Set<number>();
    // The exact share first, then a metre either way: the rooms flex, the bedrooms' rows often can't.
    for (const d of [0, -1, 1]) {
      let t = ideal + d;
      if (d === 0) {
        // A little give keeps a small house from losing its bedroom to rounding.
        if (len - t < minPriv - EPS && len - minPriv >= Math.max(minPub, t * 0.75) - EPS) t = len - minPriv;
        if (t < minPub - EPS && minPub <= t * 1.3 + EPS && len - minPub >= minPriv - EPS) t = minPub;
      }
      if (t < minPub - EPS || len - t < minPriv - EPS || done.has(Math.round(t * 1000))) continue;
      if (Math.abs(t * across - need) > need * 0.3) continue;
      done.add(Math.round(t * 1000));
      out.push(
        pubLo
          ? { pub: [seg(axisX, 0, t)], priv: [seg(axisX, t, len)] }
          : { pub: [seg(axisX, len - t, len)], priv: [seg(axisX, 0, len - t)] },
      );
    }
  };
  if (side) {
    // Living space spilling in from a neighbouring wing stays against that wing.
    tryCut(side === 'W' || side === 'E', side === 'W' || side === 'N', 2.5, 2.5);
    return out;
  }
  const alongX = W.w >= W.h;
  tryCut(alongX, true, 3, 2.5);
  tryCut(alongX, false, 3, 2.5);
  tryCut(!alongX, true, 3.5, 3.5);
  tryCut(!alongX, false, 3.5, 3.5);
  if (mid !== null) {
    // Bedrooms at both ends, living between.
    const len = alongX ? W.w : W.h;
    const across = alongX ? W.h : W.w;
    const t = snap(need / across);
    const l1 = snap((len - t) * mid);
    const l2 = len - t - l1;
    if (t >= 3 - EPS && l1 >= 2.5 - EPS && l2 >= 2.5 - EPS) {
      out.push({ pub: [seg(alongX, l1, l1 + t)], priv: [seg(alongX, 0, l1), seg(alongX, l1 + t, len)] });
    }
  }
  return out;
}

/** Which parts of the footprint are living space and which are bedrooms. */
function zonePlans(wings: readonly Rect[], P: number, Q: number, mid: number | null): ZonePlan[] {
  const plans: ZonePlan[] = [];
  const seen = new Set<string>();
  const push = (pub: Rect[], priv: Rect[]) => {
    const key = `${pub.map(rectKey).sort().join(';')}|${priv.map(rectKey).sort().join(';')}`;
    if (seen.has(key)) return;
    seen.add(key);
    plans.push({ pub, priv, key });
  };
  const bySize = wings.map((_, i) => i).sort((p, q) => area(wings[q]) - area(wings[p]));
  if (P <= EPS || Q <= EPS) {
    const list = walkOrder(wings, bySize[0]).map((i) => wings[i]);
    if (P <= EPS) push([], list);
    else push(list, []);
    return plans;
  }
  for (const a of bySize.slice(0, 3)) {
    const list = walkOrder(wings, a).map((i) => wings[i]);
    let cum = 0;
    let j = 0;
    for (; j < list.length - 1; j++) {
      if (cum + area(list[j]) >= P - EPS) break;
      cum += area(list[j]);
    }
    const before = list.slice(0, j);
    const rest = list.slice(j + 1);
    const W = list[j];
    if (j > 0 && cum >= 0.72 * P) push(before, [W, ...rest]);
    if (rest.length > 0 && cum + area(W) <= 1.4 * P) push([...before, W], rest);
    let side: Side | null = null;
    if (j > 0) {
      let best = 0;
      for (const b of before) {
        const t = touch(W, b);
        if (t && t.len > best) {
          best = t.len;
          side = t.side;
        }
      }
      if (!side) continue;
    }
    const need = P - cum;
    if (need < 6 || area(W) - need < 6) continue;
    for (const s of splitWing(W, need, side, j === 0 ? mid : null)) push([...before, ...s.pub], [...s.priv, ...rest]);
  }
  return plans;
}

/* ------------------------------------------------------------------ */
/* Dealing bedrooms and baths out to the private pieces                 */
/* ------------------------------------------------------------------ */

interface Unit {
  rooms: ProgramRoom[];
  area: number;
  cls: string;
  /** narrowest piece it can sit in */
  side: number;
}

function unitsOf(priv: readonly ProgramRoom[]): Unit[] {
  const units: Unit[] = [];
  for (const r of priv) {
    if (r.ensuiteOf) continue;
    const with_ = priv.filter((o) => o.ensuiteOf === r.name);
    const rooms = [r, ...with_];
    units.push({
      rooms,
      area: rooms.reduce((s, o) => s + o.area, 0),
      cls: r.type === 'primary_bedroom' ? `primary:${r.name}` : r.type,
      side: DIMS[r.type].hard,
    });
  }
  return units;
}

function compositions(n: number, parts: number): number[][] {
  if (parts === 1) return [[n]];
  const out: number[][] = [];
  for (let k = 0; k <= n; k++) for (const rest of compositions(n - k, parts - 1)) out.push([k, ...rest]);
  return out;
}

/** The best couple of ways to share the private rooms among the private pieces. */
function dealUnits(regs: readonly Rect[], units: readonly Unit[], hw: number): Unit[][][] {
  if (regs.length === 0) return [];
  if (regs.length === 1) return [[units.slice()]];
  const classes = new Map<string, Unit[]>();
  for (const u of units) {
    const list = classes.get(u.cls);
    if (list) list.push(u);
    else classes.set(u.cls, [u]);
  }
  const score = (per: Unit[][], final: boolean): number => {
    let s = 0;
    for (let r = 0; r < regs.length; r++) {
      const A = area(regs[r]);
      const list = per[r];
      const hall = list.length >= 3 ? hw * Math.max(regs[r].w, regs[r].h) * 0.9 : 0;
      const cap = A - hall;
      const load = list.reduce((t, u) => t + u.area, 0);
      if (load * 0.7 > cap) s += 50;
      s += (Math.max(0, load - cap) / A) * 6;
      if (!final) continue;
      if (list.length === 0) s += A <= 6 ? 0.3 : A <= 12 ? 1.5 : 4 + A / 8;
      else s += (Math.max(0, cap - load) / A) * 2;
    }
    return s;
  };
  interface State {
    per: Unit[][];
    s: number;
  }
  let beam: State[] = [{ per: regs.map(() => []), s: 0 }];
  const groups = [...classes.values()].sort((p, q) => q[0].area - p[0].area);
  groups.forEach((group, gi) => {
    const final = gi === groups.length - 1;
    const next: State[] = [];
    const comps = compositions(group.length, regs.length).filter((c) =>
      c.every((k, r) => k === 0 || Math.min(regs[r].w, regs[r].h) >= group[0].side - EPS),
    );
    for (const st of beam) {
      for (const c of comps) {
        let at = 0;
        const per = st.per.map((list, r) => {
          const add = group.slice(at, at + c[r]);
          at += c[r];
          return add.length ? [...list, ...add] : list;
        });
        next.push({ per, s: score(per, final) });
      }
    }
    next.sort((p, q) => p.s - q.s);
    beam = next.slice(0, 6);
  });
  return beam.filter((b) => b.s < 40).slice(0, 2).map((b) => b.per);
}

/* ------------------------------------------------------------------ */
/* Building one piece                                                   */
/* ------------------------------------------------------------------ */

type Cfg =
  | { mode: 'rows'; alongX: boolean; loaded: 1 | 2; flip: boolean }
  | { mode: 'direct'; alongX: boolean; reverse: boolean }
  | { mode: 'store' }
  | { mode: 'hall' };

function configsFor(units: readonly Unit[]): Cfg[] {
  if (units.length === 0) return [{ mode: 'store' }, { mode: 'hall' }];
  const rows: Cfg[] = [];
  const direct: Cfg[] = [];
  for (const alongX of [true, false]) {
    rows.push({ mode: 'rows', alongX, loaded: 1, flip: false }, { mode: 'rows', alongX, loaded: 1, flip: true });
    if (units.length >= 2) rows.push({ mode: 'rows', alongX, loaded: 2, flip: false });
    direct.push({ mode: 'direct', alongX, reverse: false }, { mode: 'direct', alongX, reverse: true });
  }
  return units.length >= 3 ? [...rows, ...direct] : [...direct, ...rows];
}

interface Piece {
  rooms: FRoom[];
  links: LayoutLink[];
  penalty: number;
  hall: FRoom | null;
}

class Builder {
  private rowsCache = new Map<string, RowsResult | null>();
  private packCache = new Map<string, Packed | null>();
  readonly hw: number;
  constructor(hw: number) {
    this.hw = hw;
  }

  pack(rect: Rect, rooms: ProgramRoom[]): Packed | null {
    const key = `${rect.w.toFixed(3)}|${rect.h.toFixed(3)}|${rooms.map((r) => `${r.name}:${r.area.toFixed(2)}`).join(',')}`;
    let hit = this.packCache.get(key);
    if (hit === undefined) {
      hit = bisect({ x: 0, y: 0, w: rect.w, h: rect.h }, rooms);
      this.packCache.set(key, hit);
    }
    if (!hit) return null;
    return {
      penalty: hit.penalty,
      rooms: hit.rooms.map((p) => ({ room: p.room, rect: { ...p.rect, x: p.rect.x + rect.x, y: p.rect.y + rect.y } })),
    };
  }

  rows(L: number, D: number, rooms: ProgramRoom[], loaded: 1 | 2): RowsResult | null {
    const key = `${L.toFixed(3)}|${D.toFixed(3)}|${loaded}|${rooms.map((r) => `${r.name}:${r.area.toFixed(2)}`).join(',')}`;
    let hit = this.rowsCache.get(key);
    if (hit === undefined) {
      hit = fillRows(L, D, rooms, loaded, this.hw, false);
      this.rowsCache.set(key, hit);
    }
    return hit;
  }

  /** Lay `units` out in `rect`. `nearLow`: the living spaces are toward the low-coordinate end. */
  piece(rect: Rect, units: readonly Unit[], cfg: Cfg, region: number, hallName: string, nearLowX: boolean, nearLowY: boolean): Piece | null {
    const mk = (room: ProgramRoom, r: Rect): FRoom => ({
      name: room.name, type: room.type, x: r.x, y: r.y, w: r.w, h: r.h,
      target: room.area, region, pub: false, ...(room.ensuiteOf ? { ensuiteOf: room.ensuiteOf } : {}),
    });
    const whole = (name: string, type: RoomType): Piece => ({
      rooms: [{ name, type, ...rect, target: area(rect), region, pub: false, auto: true }],
      links: [],
      penalty: 2 + area(rect) / 6,
      hall: null,
    });
    if (cfg.mode === 'hall') {
      if (Math.min(rect.w, rect.h) > 2.5 + EPS || area(rect) > 14) return null;
      const p = whole(hallName, 'hall');
      return { ...p, hall: p.rooms[0] };
    }
    if (cfg.mode === 'store') {
      const thin = Math.min(rect.w, rect.h) < 1.5 - EPS;
      if (area(rect) <= 6 + EPS) return whole('Closet', 'closet');
      if (thin) return null;
      return whole('Storage', 'other');
    }
    const flat = units.flatMap((u) => u.rooms);
    if (cfg.mode === 'rows') {
      const L = cfg.alongX ? rect.w : rect.h;
      const D = cfg.alongX ? rect.h : rect.w;
      if (D - this.hw < 2.5 - EPS) return null;
      const filled = this.rows(L, D, flat, cfg.loaded);
      if (!filled) return null;
      const flipLong = !(cfg.alongX ? nearLowX : nearLowY);
      const toGlobal = (r: Rect): Rect => {
        const lx = flipLong ? L - r.x - r.w : r.x;
        const ly = cfg.flip ? D - r.y - r.h : r.y;
        return cfg.alongX
          ? { x: rect.x + lx, y: rect.y + ly, w: r.w, h: r.h }
          : { x: rect.x + ly, y: rect.y + lx, w: r.h, h: r.w };
      };
      const hr = toGlobal(filled.hall);
      const hall: FRoom = { name: hallName, type: 'hall', ...hr, target: area(hr), region, pub: false };
      const rooms: FRoom[] = [hall];
      const links: LayoutLink[] = [];
      for (const p of filled.rooms) {
        rooms.push(mk(p.room, toGlobal(p.rect)));
        links.push({ a: p.room.name, b: p.room.ensuiteOf ?? hallName, kind: 'door' });
      }
      return { rooms, links, penalty: filled.penalty + (units.length < 3 ? 2 : 0), hall };
    }
    // direct: one row of rooms, each of which must find its own way to the living space.
    const nearLow = cfg.alongX ? nearLowX : nearLowY;
    const sorted = units.slice().sort((a, b) => (DEPTH_RANK[a.rooms[0].type] ?? 2) - (DEPTH_RANK[b.rooms[0].type] ?? 2));
    if (cfg.reverse !== !nearLow) sorted.reverse();
    const list = sorted.flatMap((u) => (cfg.reverse !== !nearLow ? u.rooms.slice().reverse() : u.rooms));
    const edge = cfg.alongX ? rect.w : rect.h;
    const thick = cfg.alongX ? rect.h : rect.w;
    const spans = sliceSpan(edge, list.map((r) => r.area / thick), list.map((r) => DIMS[r.type].hard));
    if (!spans) return null;
    const rooms: FRoom[] = [];
    const links: LayoutLink[] = [];
    let at = 0;
    let penalty = 0;
    for (let i = 0; i < list.length; i++) {
      const r: Rect = cfg.alongX
        ? { x: rect.x + at, y: rect.y, w: spans[i], h: thick }
        : { x: rect.x, y: rect.y + at, w: thick, h: spans[i] };
      const p = roomPenalty(list[i].type, r.w, r.h, list[i].area);
      if (!Number.isFinite(p)) return null;
      penalty += p;
      rooms.push(mk(list[i], r));
      if (list[i].ensuiteOf) links.push({ a: list[i].name, b: list[i].ensuiteOf!, kind: 'door' });
      at += spans[i];
    }
    return { rooms, links, penalty: penalty + (units.length >= 3 ? 4 : 0), hall: null };
  }
}

/* ------------------------------------------------------------------ */
/* Doors                                                                */
/* ------------------------------------------------------------------ */

const HUB: Partial<Record<RoomType, number>> = { living: 5, entry: 4, hall: 4, dining: 3, kitchen: 1 };

/** Where a room without a hall of its own looks for a door, best first. */
const DOOR_ORDER: Partial<Record<RoomType, RoomType[]>> = {
  bedroom: ['hall', 'living', 'entry', 'dining', 'kitchen'],
  primary_bedroom: ['hall', 'living', 'entry', 'dining', 'kitchen'],
  office: ['hall', 'living', 'entry', 'dining', 'kitchen'],
  bathroom: ['hall', 'entry', 'living', 'dining', 'laundry', 'kitchen'],
  laundry: ['kitchen', 'hall', 'entry', 'garage', 'dining', 'living'],
  pantry: ['kitchen', 'dining', 'hall', 'laundry', 'living'],
  garage: ['entry', 'laundry', 'hall', 'kitchen', 'living', 'dining'],
  closet: ['hall', 'entry', 'bedroom', 'primary_bedroom', 'kitchen', 'laundry', 'living', 'dining'],
  other: ['hall', 'entry', 'kitchen', 'living', 'dining', 'laundry', 'garage'],
};

interface State {
  rooms: FRoom[];
  links: LayoutLink[];
  penalty: number;
  /** rooms that could not be given a proper door */
  bad: number;
  /** rooms known to be reachable without crossing a bedroom */
  ok: Set<string>;
  halls: number;
}

const linked = (links: readonly LayoutLink[], a: string, b: string) =>
  links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));

/** Give the rooms of a freshly built piece their doors onto what is already there. */
function attach(state: State, piece: Piece, hw: number, manyBeds: boolean): State {
  const links = [...state.links, ...piece.links];
  const ok = new Set(state.ok);
  let penalty = state.penalty + piece.penalty;
  let bad = state.bad;
  const hubs = state.rooms.filter((o) => ok.has(o.name));

  if (piece.hall) {
    const h = piece.hall;
    const near = hubs
      .filter((o) => HUB[o.type] !== undefined)
      .map((o) => ({ o, len: sharedEdge(h, o) }))
      .filter((c) => c.len >= 1 - EPS)
      .sort((p, q) => HUB[q.o.type]! - HUB[p.o.type]! || q.len - p.len);
    if (near.length === 0) bad += piece.rooms.length - 1 || 1;
    else {
      const best = near[0];
      const along = best.len > hw + 0.25;
      // A kept room's walls stay whole: a door into it, never an opening.
      const whole = !!best.o.fixed;
      if (along) {
        links.push({ a: h.name, b: best.o.name, kind: best.o.type === 'hall' && !whole ? 'open' : 'door' });
        const second = near.slice(1).find((c) => HUB[c.o.type]! >= 3 && c.len >= 1.5 - EPS && c.o.type !== 'hall');
        if (second && best.o.type !== 'hall') links.push({ a: h.name, b: second.o.name, kind: 'door' });
      } else {
        links.push({ a: h.name, b: best.o.name, kind: !whole && (best.o.type === 'hall' || hw < 1.5 || best.len < 1.2) ? 'open' : 'door' });
      }
      if (best.o.type === 'kitchen') penalty += 3;
      ok.add(h.name);
      for (const r of piece.rooms) if (!r.ensuiteOf) ok.add(r.name);
    }
  } else {
    for (const r of piece.rooms) {
      if (r.ensuiteOf) continue;
      const order = DOOR_ORDER[r.type] ?? DOOR_ORDER.other!;
      let done = false;
      for (const t of order) {
        const o = hubs.find((c) => c.type === t && sharedEdge(r, c) >= doorNeed(r.type, c.type) - EPS);
        if (!o) continue;
        // A closet may open off a bedroom; nothing else may.
        if ((o.type === 'bedroom' || o.type === 'primary_bedroom') && r.type !== 'closet') continue;
        links.push({ a: r.name, b: o.name, kind: 'door' });
        if (o.type === 'kitchen' && r.type !== 'laundry' && r.type !== 'closet' && r.type !== 'other') penalty += 3;
        if (manyBeds && (r.type === 'bedroom' || r.type === 'primary_bedroom') && o.type !== 'hall') penalty += 1.5;
        done = true;
        break;
      }
      if (done) ok.add(r.name);
      else if (!r.auto) bad++;
    }
  }
  return { rooms: [...state.rooms, ...piece.rooms], links, penalty, bad, ok, halls: state.halls + (piece.hall ? 1 : 0) };
}

/** The links between the living spaces themselves, the odd rooms and the front door. */
function finishLinks(rooms: readonly FRoom[], start: readonly LayoutLink[]): { links: LayoutLink[]; penalty: number } {
  const links = start.slice();
  let penalty = 0;
  const tryLink = (a: FRoom, b: FRoom, asked: 'door' | 'open'): boolean => {
    if (linked(links, a.name, b.name)) return true;
    // A kept room's walls stay whole: a door into it, never an opening.
    const kind = a.fixed || b.fixed ? 'door' : asked;
    const len = sharedEdge(a, b);
    if (kind === 'open' ? len < 1.5 - EPS : len < doorNeed(a.type, b.type) - EPS) return false;
    links.push({ a: a.name, b: b.name, kind });
    return true;
  };
  const all = (type: RoomType) => rooms.filter((r) => r.type === type);
  const first = (type: RoomType) => rooms.find((r) => r.type === type && !r.fixed) ?? rooms.find((r) => r.type === type);
  const firstOf = (from: FRoom, types: readonly RoomType[]): boolean => {
    for (const t of types) for (const o of all(t)) if (o !== from && tryLink(from, o, 'door')) return true;
    return false;
  };
  const hasLink = (r: FRoom) => links.some((l) => l.a === r.name || l.b === r.name);

  const kitchen = first('kitchen');
  const dining = first('dining');
  const living = first('living');
  const fresh = (r: FRoom | undefined) => !!r && !r.fixed;
  if (kitchen && dining && (fresh(kitchen) || fresh(dining)) && !tryLink(kitchen, dining, 'open') && !tryLink(kitchen, dining, 'door')) penalty += 8;
  if (dining && living && (fresh(dining) || fresh(living)) && !tryLink(dining, living, 'open') && !tryLink(dining, living, 'door')) penalty += 6;
  if (kitchen && living && (fresh(kitchen) || fresh(living)) && !tryLink(kitchen, living, 'open') && !dining && !tryLink(kitchen, living, 'door')) penalty += 4;

  for (const r of rooms) {
    if (r.fixed || r.ensuiteOf || r.type === 'hall') continue;
    if (r.type === 'entry') {
      const ok = (living && tryLink(r, living, 'open')) || firstOf(r, ['living', 'dining', 'hall', 'kitchen']);
      if (!ok) penalty += 5;
      continue;
    }
    if (r.type === 'living' || r.type === 'dining' || r.type === 'kitchen') continue;
    if (hasLink(r) && !r.pub) continue;
    if (r.type === 'pantry') {
      if (!firstOf(r, ['kitchen'])) {
        penalty += 4;
        firstOf(r, ['dining', 'hall', 'laundry', 'living']);
      }
      continue;
    }
    if (hasLink(r)) continue;
    const order = DOOR_ORDER[r.type] ?? DOOR_ORDER.other!;
    const usable = r.type === 'closet' ? order : order.filter((t) => t !== 'bedroom' && t !== 'primary_bedroom');
    if (!firstOf(r, usable)) penalty += r.auto ? 2 : r.type === 'garage' ? 5 : 6;
    else if (kitchen && linked(links, r.name, kitchen.name) && r.type !== 'laundry' && r.type !== 'garage' && !r.auto) penalty += 3;
  }

  // Front door: the entry if there is one, else the living room.
  if (!links.some((l) => l.b === OUTSIDE)) {
    for (const type of ['entry', 'living', 'dining', 'kitchen', 'hall'] as RoomType[]) {
      const r = rooms.find((o) => o.type === type && maxExposure(o, rooms).len >= doorNeed(o.type, null) - EPS);
      if (r) {
        links.push({ a: r.name, b: OUTSIDE, kind: 'door' });
        if (type !== 'entry' && type !== 'living') penalty += 2;
        break;
      }
    }
  }
  return { links, penalty };
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

interface Candidate {
  layout: Layout;
  penalty: number;
  /** 0: sound. 1: everything can be reached, but some room only through a bedroom. */
  tier: number;
  /** which zoning produced it — options with different keys are different ideas */
  idea: string;
}

interface Fixed {
  rooms: FRoom[];
  links: LayoutLink[];
}

function publicSplits(list: readonly ProgramRoom[], regs: readonly Rect[]): ProgramRoom[][][] {
  if (regs.length === 1) return [[list.slice()]];
  const found: { parts: ProgramRoom[][]; s: number }[] = [];
  const walk = (at: number, r: number, parts: ProgramRoom[][], s: number) => {
    if (r === regs.length - 1) {
      const chunk = list.slice(at);
      const A = area(regs[r]);
      const load = chunk.reduce((t, o) => t + o.area, 0);
      found.push({ parts: [...parts, chunk], s: s + (chunk.length ? Math.abs(load - A) / A : 3 + A / 6) });
      return;
    }
    for (let end = at; end <= list.length; end++) {
      const chunk = list.slice(at, end);
      const A = area(regs[r]);
      const load = chunk.reduce((t, o) => t + o.area, 0);
      walk(end, r + 1, [...parts, chunk], s + (chunk.length ? Math.abs(load - A) / A : 3 + A / 6));
    }
  };
  walk(0, 0, [], 0);
  found.sort((p, q) => p.s - q.s);
  return found.slice(0, 3).map((f) => f.parts);
}

function centroid(rects: readonly Rect[]): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let sa = 0;
  for (const r of rects) {
    sx += (r.x + r.w / 2) * area(r);
    sy += (r.y + r.h / 2) * area(r);
    sa += area(r);
  }
  return sa > 0 ? { x: sx / sa, y: sy / sa } : { x: 0, y: 0 };
}

/** Order the private pieces so each one is next to something already placed. */
function reachOrder(priv: readonly Rect[], placed: readonly Rect[]): number[] {
  const order: number[] = [];
  const done = new Set<number>();
  const have = placed.slice();
  for (let guard = 0; guard < priv.length; guard++) {
    let pick = -1;
    let best = -1;
    priv.forEach((r, i) => {
      if (done.has(i)) return;
      let len = 0;
      for (const p of have) len = Math.max(len, touch(r, p)?.len ?? 0);
      if (len > best) {
        best = len;
        pick = i;
      }
    });
    if (pick < 0) break;
    done.add(pick);
    order.push(pick);
    have.push(priv[pick]);
  }
  return order;
}

function search(
  decomps: readonly Rect[][],
  program: readonly ProgramRoom[],
  total: number,
  fixed: Fixed,
  beds: number,
  trace?: Record<string, number>,
): Candidate[] {
  const note = (k: string) => {
    if (trace) trace[k] = (trace[k] ?? 0) + 1;
  };
  const hw = total >= 210 ? 1.5 : 1;
  const builder = new Builder(hw);
  const out: Candidate[] = [];
  const hasOffice = program.some((r) => r.type === 'office');
  const hasLaundry = program.some((r) => r.type === 'laundry');
  const bedCount = program.filter((r) => r.type === 'bedroom' || r.type === 'primary_bedroom').length;
  const zonings: [boolean, boolean][] = [[false, false]];
  if (bedCount >= 2 && (hasOffice || hasLaundry)) zonings.push([hasOffice, hasLaundry && !hasOffice]);
  const fixedNames = new Set(fixed.rooms.map((r) => r.name));
  const takenNames = new Set([...fixedNames].map((n) => n.toLowerCase()));

  for (let di = 0; di < decomps.length; di++) {
    const wings = decomps[di];
    for (const [officePrivate, laundryPrivate] of zonings) {
      const moved = (r: ProgramRoom) => (r.type === 'office' && officePrivate) || (r.type === 'laundry' && laundryPrivate);
      let pub = program.filter((r) => r.zone === 'public' && !moved(r));
      let priv = program.filter((r) => r.zone === 'private' || moved(r));
      // Without a bedroom there is no private side: the bath joins the living spaces
      // (unless living spaces are being kept, in which case what is left is all private).
      if (bedCount === 0 && pub.length > 0) {
        pub = [...pub, ...priv];
        priv = [];
      }
      const units = unitsOf(priv);
      const P = pub.reduce((s, r) => s + r.area, 0);
      const Q = total - P;
      const head = units.find((u) => u.cls.startsWith('primary')) ?? units.find((u) => u.cls === 'bedroom');
      const unitArea = units.reduce((s, u) => s + u.area, 0);
      const mid = bedCount >= 2 && head && unitArea > 0 ? Math.min(0.6, Math.max(0.25, head.area / unitArea)) : null;

      for (const zp of zonePlans(wings, priv.length ? P : total, priv.length ? Q : 0, mid)) {
        note('zonePlans');
        if (priv.length > 0 && zp.priv.length === 0) continue;
        if (pub.length > 0 && zp.pub.length === 0) continue;
        const deals = priv.length ? dealUnits(zp.priv, units, hw) : [zp.priv.map(() => [] as Unit[])];
        if (deals.length === 0) {
          note('noDeal');
          continue;
        }
        const home = zp.pub.length ? centroid(zp.pub) : centroid(fixed.rooms.length ? fixed.rooms : wings);
        const order = reachOrder(zp.priv, [...zp.pub, ...fixed.rooms.filter((r) => HUB[r.type] !== undefined)]);
        const idea = `${di}:${zp.key}`;

        for (let ord = 0; ord < (pub.length > 1 ? 4 : 1); ord++) {
          const list = orderPublic(pub, ord);
          let base: State | null = null;
          for (const parts of zp.pub.length ? publicSplits(list, zp.pub) : [[]]) {
            const rooms: FRoom[] = fixed.rooms.slice();
            let penalty = 0;
            let ok = true;
            for (let r = 0; r < zp.pub.length && ok; r++) {
              const rect = zp.pub[r];
              if (parts[r].length === 0) {
                const small = area(rect) <= 6 + EPS;
                if (!small && Math.min(rect.w, rect.h) < 1.5 - EPS) ok = false;
                rooms.push({
                  name: small ? 'Closet' : 'Storage', type: small ? 'closet' : 'other', ...rect,
                  target: area(rect), region: r, pub: true, auto: true,
                });
                penalty += 2 + area(rect) / 6;
                continue;
              }
              const packed = builder.pack(rect, parts[r]);
              if (!packed) {
                ok = false;
                break;
              }
              penalty += packed.penalty;
              for (const p of packed.rooms) {
                rooms.push({
                  name: p.room.name, type: p.room.type, ...p.rect, target: p.room.area, region: r, pub: true,
                  ...(p.room.ensuiteOf ? { ensuiteOf: p.room.ensuiteOf } : {}),
                });
              }
            }
            if (!ok) continue;
            base = {
              rooms,
              links: fixed.links.slice(),
              penalty,
              bad: 0,
              ok: new Set(rooms.filter((r) => r.pub || r.fixed).map((r) => r.name)),
              halls: 0,
            };
            break;
          }
          if (!base) {
            note('noPack');
            continue;
          }

          for (const deal of deals) {
            let leaves = 0;
            const walk = (k: number, state: State): void => {
              if (leaves >= 4) return;
              if (k === order.length) {
                leaves++;
                const c = finish(state, idea, fixedNames);
                note(c ? `tier${c.tier}` : 'rejected');
                if (c) out.push(c);
                return;
              }
              const ri = order[k];
              const rect = zp.priv[ri];
              const us = deal[ri];
              const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
              const hallName = uniqueName('Hall', state, takenNames);
              const tries: State[] = [];
              for (const cfg of configsFor(us)) {
                const piece = builder.piece(rect, us, cfg, zp.pub.length + ri, hallName, home.x <= c.x, home.y <= c.y);
                if (!piece) continue;
                dedupeAuto(piece, state, takenNames);
                tries.push(attach(state, piece, hw, beds >= 3));
              }
              if (tries.length === 0) {
                note('noPiece');
                return;
              }
              tries.sort((p, q) => p.bad - q.bad || p.penalty - q.penalty);
              const good = tries.filter((t) => t.bad === state.bad).slice(0, 2);
              for (const t of good.length ? good : tries.slice(0, 1)) walk(k + 1, t);
            };
            walk(0, base);
          }
        }
      }
    }
  }
  return out;
}

function uniqueName(stem: string, state: State, taken: ReadonlySet<string>): string {
  const used = new Set([...state.rooms.map((r) => r.name.toLowerCase()), ...taken]);
  if (!used.has(stem.toLowerCase())) return stem;
  let n = 2;
  while (used.has(`${stem} ${n}`.toLowerCase())) n++;
  return `${stem} ${n}`;
}

function dedupeAuto(piece: Piece, state: State, taken: ReadonlySet<string>): void {
  for (const r of piece.rooms) {
    if (!r.auto || r.type === 'hall') continue;
    r.name = uniqueName(r.name, state, taken);
  }
}

function finish(state: State, idea: string, fixedNames: ReadonlySet<string>): Candidate | null {
  // Auto rooms placed with the living spaces may share a name too.
  const seen = new Set<string>();
  const rooms = state.rooms.map((r) => {
    let name = r.name;
    if (seen.has(name.toLowerCase()) && r.auto) {
      let n = 2;
      while (seen.has(`${r.name} ${n}`.toLowerCase())) n++;
      name = `${r.name} ${n}`;
    }
    seen.add(name.toLowerCase());
    return name === r.name ? r : { ...r, name };
  });
  const fin = finishLinks(rooms, state.links);
  const draft: Layout = {
    rooms: rooms.map(({ name, type, x, y, w, h }) => ({ name, type, x, y, w, h })),
    links: fin.links,
  };
  const layout = ensureConnected(draft);
  const patched = layout.links.length - draft.links.length;
  const audit = auditLayout(layout);
  if (audit.unreachable.length || !audit.entrance || audit.overlaps.length) return null;
  if (audit.narrow.some((n) => !fixedNames.has(n))) return null;
  const through = audit.throughBedroom.filter((n) => !fixedNames.has(n)).length;

  let penalty = state.penalty + fin.penalty + patched * 8 + state.bad * 6 + through * 25;
  const total = rooms.reduce((s, r) => s + r.w * r.h, 0);
  for (const r of rooms) {
    if (r.fixed) continue;
    if (!['bedroom', 'primary_bedroom', 'living', 'kitchen', 'dining', 'office'].includes(r.type)) continue;
    const e = exposure(r, rooms);
    if (Math.max(e.N, e.S, e.E, e.W) < 1.7) penalty += r.type === 'kitchen' || r.type === 'dining' ? 3 : 8;
  }
  const hallArea = rooms.filter((r) => r.type === 'hall' && !r.fixed).reduce((s, r) => s + r.w * r.h, 0);
  penalty += Math.max(0, hallArea / total - 0.08) * 60;
  if (audit.entrance.side !== 'S') penalty += audit.entrance.side === 'N' ? 2 : 1;
  // A hall along an outside wall wastes the daylight.
  for (const r of rooms) {
    if (r.type !== 'hall' || r.fixed) continue;
    const e = exposure(r, rooms);
    penalty += Math.max(0, Math.max(e.N, e.S, e.E, e.W) - 2) * 0.5;
  }
  return { layout, penalty, tier: through > 0 ? 1 : 0, idea };
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

export interface FillOptions {
  /** How many options to return (default 5). */
  count?: number;
  /** 0 = the best set; other values shuffle among the good ones and nudge room sizes. */
  seed?: number;
  /** Rooms that stay exactly where they are (they lie outside the region being filled). */
  fixed?: readonly LayoutRoom[];
  /** Links among the kept rooms (and to 'outside') to carry over. */
  fixedLinks?: readonly LayoutLink[];
  /** What the kept rooms count as in the brief (default: one room of each kept room's type). */
  taken?: readonly RoomType[];
  /** Development: counts of what the search tried and why arrangements were thrown out. */
  trace?: Record<string, number>;
}

export interface FillOption {
  layout: Layout;
  /** lower is better */
  penalty: number;
  /** which zoning it came from */
  idea: string;
}

export interface FillResult {
  options: FillOption[];
  /** Asked-for rooms that were left out so the rest would fit. */
  dropped: string[];
  /** Something the person should know. */
  note: string | null;
}

function alike(a: Layout, b: Layout): boolean {
  const pos = new Map(a.rooms.map((r) => [r.name, r]));
  let moved = 0;
  for (const r of b.rooms) {
    const o = pos.get(r.name);
    if (!o || Math.abs(o.x - r.x) + Math.abs(o.y - r.y) + Math.abs(o.w - r.w) + Math.abs(o.h - r.h) > 1.01) moved++;
  }
  return moved < Math.max(3, b.rooms.length * 0.4);
}

/** When nothing else works: one room per wing, doors wherever two of them meet. */
function lastResort(wings: readonly Rect[], fixed: Fixed): Layout {
  const bySize = wings.slice().sort((p, q) => area(q) - area(p));
  const taken = new Set(fixed.rooms.map((r) => r.name.toLowerCase()));
  const name = (stem: string) => {
    if (!taken.has(stem.toLowerCase())) {
      taken.add(stem.toLowerCase());
      return stem;
    }
    let n = 2;
    while (taken.has(`${stem} ${n}`.toLowerCase())) n++;
    taken.add(`${stem} ${n}`.toLowerCase());
    return `${stem} ${n}`;
  };
  const rooms: LayoutRoom[] = fixed.rooms.map(({ name: n, type, x, y, w, h }) => ({ name: n, type, x, y, w, h }));
  bySize.forEach((w, i) => {
    const small = area(w) <= 6;
    rooms.push(
      i === 0 && !fixed.rooms.some((r) => r.type === 'living')
        ? { name: name('Living'), type: 'living', ...w }
        : { name: name(small ? 'Closet' : 'Room'), type: small ? 'closet' : 'other', ...w },
    );
  });
  return ensureConnected({ rooms, links: fixed.links.slice() });
}

/**
 * Lay the brief's rooms out inside `mask` (disjoint rectangles that together
 * make the footprint). Always returns at least one option if the footprint
 * can hold a room at all.
 */
export function fillMask(mask: readonly Rect[], brief: Brief, opts: FillOptions = {}): FillResult {
  const count = opts.count ?? 5;
  const seed = opts.seed ?? 0;
  const rand = mulberry32(seed * 7919 + 31);
  const total = rectsArea(mask);
  const decomps = decompositions(mask);
  if (decomps.length === 0 || total < 4) {
    return { options: [], dropped: [], note: 'Part of this outline is too narrow for a room.' };
  }
  const fixed: Fixed = {
    rooms: (opts.fixed ?? []).map((r) => ({ ...r, target: 0, region: -1, pub: HUB[r.type] !== undefined, fixed: true })),
    links: (opts.fixedLinks ?? []).slice(),
  };
  const program = startProgram(brief, fixed.rooms, opts.taken);
  const asked = program.length;
  const dropped: string[] = [];
  while (leastArea(program, total) > total + EPS) {
    const d = dropOne(program);
    if (!d) break;
    dropped.push(d);
  }

  const scaled = (): ProgramRoom[] => {
    const reserve = hallReserve(program, total);
    const jitter = program.map((r) => ({ ...r, area: r.area * (seed === 0 ? 1 : 0.93 + rand() * 0.14) }));
    const rooms = scaleProgram(jitter, total, reserve);
    // A roomy outline: the rooms share the surplus instead of stopping at their usual largest.
    const sum = rooms.reduce((s, r) => s + r.area, 0);
    const spare = total - reserve - sum;
    if (spare > total * 0.02 && sum > 0) for (const r of rooms) r.area *= (sum + spare) / sum;
    return rooms;
  };
  const beds = program.filter((r) => r.type === 'bedroom' || r.type === 'primary_bedroom').length;

  let found: Candidate[] = [];
  let fallback: { cands: Candidate[]; dropped: string[] } | null = null;
  for (let attempt = 0; attempt < 14 && program.length > 0; attempt++) {
    const cands = search(decomps, scaled(), total, fixed, beds, attempt === 0 ? opts.trace : undefined);
    const sound = cands.filter((c) => c.tier === 0);
    if (sound.length) {
      found = sound;
      break;
    }
    // Nothing sound: a plan missing a room beats one you cross a bedroom to use, so keep
    // taking rooms out; the unsound one is kept only in case nothing ever works.
    if (cands.length && !fallback) fallback = { cands, dropped: dropped.slice() };
    const d = dropOne(program);
    if (!d) break;
    dropped.push(d);
  }
  let outDropped = dropped;
  if (found.length === 0 && fallback) {
    found = fallback.cands;
    outDropped = fallback.dropped;
  }
  if (found.length === 0) {
    const layout = lastResort(decomps[0], fixed);
    return {
      options: [{ layout: { ...layout, title: 'Open plan', summary: 'These rooms don’t fit this outline — one space per wing.' }, penalty: 999, idea: 'last' }],
      dropped: roomProgram(brief).map((r) => r.name).filter((n) => !layout.rooms.some((r) => r.name === n)),
      note: 'These rooms don’t fit this outline.',
    };
  }

  found.sort((a, b) => a.tier - b.tier || a.penalty - b.penalty);
  if (seed !== 0) {
    const cut = found[0].penalty + 14;
    const good = found.filter((c) => c.tier === found[0].tier && c.penalty <= cut);
    const rest = found.filter((c) => !good.includes(c));
    for (let i = good.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [good[i], good[j]] = [good[j], good[i]];
    }
    found = [...good, ...rest];
  }
  const picked: Candidate[] = [];
  const take = (c: Candidate) => {
    if (picked.length < count && !picked.some((p) => alike(p.layout, c.layout))) picked.push(c);
  };
  // One of each idea first, then the best of the rest — never two that look alike.
  const cap = found[0].penalty + 30;
  const ideas = new Set<string>();
  for (const c of found) {
    if (ideas.has(c.idea) || c.penalty > cap || c.tier !== found[0].tier) continue;
    ideas.add(c.idea);
    take(c);
  }
  for (const c of found) if (c.penalty <= cap) take(c);
  if (picked.length === 0) picked.push(found[0]);
  if (seed === 0) picked.sort((a, b) => a.tier - b.tier || a.penalty - b.penalty);

  const note =
    outDropped.length > 0
      ? `Too small for everything — left out: ${outDropped.map((n) => n.toLowerCase()).join(', ')}.`
      : asked > 0 && picked[0].tier > 0
        ? 'A tight fit — some rooms open off another room.'
        : null;
  return {
    options: picked.map((c) => ({ layout: c.layout, penalty: c.penalty, idea: c.idea })),
    dropped: outDropped,
    note,
  };
}
