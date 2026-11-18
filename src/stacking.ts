/**
 * Things rest on what is beneath them. A placed item stores only where it
 * stands on the plan, never a height: how high it stands is worked out here,
 * from what is under it, every time it is needed. So taking the table out
 * from under a plate, deleting the table or dragging the plate away all
 * simply settle the plate wherever it now is. Pure: no store, no three.js.
 *
 * What can carry what. An item can rest on another when its centre is over
 * the other's footprint and the other is bigger: a bigger footprint carries a
 * smaller one, and things of the same size stack in the order they were
 * placed, the first at the bottom. "Bigger, or as big and placed earlier" is
 * a strict order, so nothing can end up resting on itself however the pieces
 * overlap. Something thinner than 3 cm lying on the floor (a rug) carries
 * nothing: a table on a rug stands on the floor, and the plates on that table
 * on the table. Thin things still pile up (a plate on a plate) and, once up on
 * something, carry what is put on them (a cup on a plate on the table).
 *
 * What wants to be on top. Catalog furniture stands on the floor, except on a
 * stage riser. A custom item (a product, something the user made) goes on top
 * when it is a small tabletop thing: no taller than 80 cm, not hung on a
 * wall, not named like a seat or something kept on the floor or under a
 * table (a stool, a bin, a basket…), and over a surface at least twice its
 * footprint, or over another one of itself, so a pile of plates is a pile.
 * Then it takes the highest thing it can rest on. The item's own `rest` wins
 * over the guess: 'top' rests on whatever beneath can carry it, 'floor' never
 * leaves the floor.
 *
 * How high. The support's own height plus the top of the support right under
 * the item's centre (the table top under a plate, the seat of a chair, the
 * top of a bookcase) from the support's parts, or its overall height when no
 * part is under that point. Nothing is set down higher than 2.2 m: up there
 * is a ceiling lamp, not a shelf.
 */
import { isBuiltinKind, type FurnitureDef, type FurnitureKind, type Part } from './catalog';
import { partHalfExtents, rotatePartOffset } from './customItems';
import type { Furniture } from './types';

/** How a caller looks up an item's definition. Null (or a throw) means "unknown": that item stays on the floor. */
export type DefOf = (kind: FurnitureKind) => FurnitureDef | null | undefined;

export interface Rest {
  /** Height of the item's base above the floor, m. 0 on the floor. */
  readonly lift: number;
  /** The item it stands on, or null for the floor. */
  readonly on: string | null;
  /** What it would stand on if told to rest on top (the highest thing beneath that can carry it), or null. */
  readonly beneath: string | null;
  /** How many things are under it: 0 on the floor, 1 on a table, 2 on a plate on a table… */
  readonly depth: number;
}

export type RestMap = Map<string, Rest>;

/** Thinner than this is floor covering when it lies on the floor: it carries nothing (and, see solidity.ts, bumps into nothing). */
export const FLAT = 0.03;
/** Built-ins whose top is a floor to stand on. */
const PLATFORMS: ReadonlySet<string> = new Set(['stage']);
/** A tabletop thing is no taller than this, m. */
const TABLETOP_HEIGHT = 0.8;
/** …and goes on top of a surface at least this many times its own footprint. */
const TABLETOP_SURFACE = 2;
/** How far past a part's edge a point still counts as over it, m. */
const EDGE = 0.02;
/** No surface higher than this is offered, m. */
const HIGHEST_SURFACE = 2.2;
/** Lowest part this far off the floor: the item hangs on a wall or from the ceiling. */
const HUNG = 0.05;

const FLOOR_REST: Rest = Object.freeze({ lift: 0, on: null, beneath: null, depth: 0 });

// ---------- parts as the plan sees them ----------

/**
 * One part of a model seen from above: a rectangle in the item's own frame
 * (an ellipse inside it, for round parts) and the heights it spans. The item
 * frame is the plan's: x right, z toward the item's front.
 */
export interface PartBox {
  /** Centre in the item's frame, m. */
  x: number;
  z: number;
  /** Half sizes, m. */
  hx: number;
  hz: number;
  /** Turn in the item's frame, radians, the way the plan turns items. */
  a: number;
  /** Round in plan: the ellipse inside the rectangle is what is there. */
  round: boolean;
  /** Bottom and top above the item's base, m. */
  y0: number;
  y1: number;
}

interface Shape {
  boxes: PartBox[];
  /** Lowest point of the model above its base. */
  bottom: number;
  /** Its name reads as a seat or a floor thing (see `readsAsFloorThing`). */
  floorThing: boolean;
}

const shapes = new WeakMap<FurnitureDef, Shape>();

const isRound = (p: Part): boolean =>
  p.shape === 'cylinder' || p.shape === 'cone' || p.shape === 'sphere' || p.shape === 'torus';

/** Turned only about the vertical (or not at all): its plan outline is the part's own. */
function upright(rot: Part['rot']): boolean {
  return !rot || (Math.abs(rot[0] % 360) < 1e-6 && Math.abs(rot[2] % 360) < 1e-6);
}

function partBox(p: Part): PartBox | null {
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return null;
  const [hx, hy, hz] = partHalfExtents(p);
  if (![hx, hy, hz].every((v) => Number.isFinite(v) && v >= 0)) return null;
  if (upright(p.rot)) {
    // three.js turns +y counter-clockwise seen from above; the plan's y runs down the screen, so it reads as −.
    const turn = p.rot ? (p.rot[1] * Math.PI) / 180 : 0;
    return { x: p.x, z: p.z, hx, hz, a: -turn, round: isRound(p), y0: p.y - hy, y1: p.y + hy };
  }
  // Tilted: the box round its turned corners.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const [ox, oy, oz] = rotatePartOffset([sx * hx, sy * hy, sz * hz], p.rot);
        x0 = Math.min(x0, ox);
        x1 = Math.max(x1, ox);
        y0 = Math.min(y0, oy);
        y1 = Math.max(y1, oy);
        z0 = Math.min(z0, oz);
        z1 = Math.max(z1, oz);
      }
    }
  }
  if (![x0, x1, y0, y1, z0, z1].every(Number.isFinite)) return null;
  return {
    x: p.x + (x0 + x1) / 2,
    z: p.z + (z0 + z1) / 2,
    hx: (x1 - x0) / 2,
    hz: (z1 - z0) / 2,
    a: 0,
    round: false,
    y0: p.y + y0,
    y1: p.y + y1,
  };
}

function shapeOf(def: FurnitureDef): Shape {
  let s = shapes.get(def);
  if (!s) {
    const boxes: PartBox[] = [];
    for (const p of Array.isArray(def.parts) ? def.parts : []) {
      const b = partBox(p);
      if (b) boxes.push(b);
    }
    const bottom = boxes.length ? Math.min(...boxes.map((b) => b.y0)) : 0;
    s = { boxes, bottom: Number.isFinite(bottom) ? bottom : 0, floorThing: readsAsFloorThing(def.label) };
    shapes.set(def, s);
  }
  return s;
}

/** A definition's parts as plan boxes (cached per definition; treat as read-only). */
export function partBoxes(def: FurnitureDef): readonly PartBox[] {
  return shapeOf(def).boxes;
}

/** Is the point (x, z) of the item's frame over this part, give or take `tol`? */
export function overPart(b: PartBox, x: number, z: number, tol = 0): boolean {
  const dx = x - b.x;
  const dz = z - b.z;
  const c = Math.cos(b.a);
  const s = Math.sin(b.a);
  const u = dx * c + dz * s;
  const v = -dx * s + dz * c;
  if (b.round) {
    const rx = b.hx + tol;
    const rz = b.hz + tol;
    return rx > 0 && rz > 0 && (u * u) / (rx * rx) + (v * v) / (rz * rz) <= 1;
  }
  return Math.abs(u) <= b.hx + tol && Math.abs(v) <= b.hz + tol;
}

/** The highest top of the model over the point (x, z) of its own frame; its height when no part is there. */
export function surfaceAt(def: FurnitureDef, x: number, z: number): number {
  let top = -Infinity;
  for (const b of shapeOf(def).boxes) if (b.y1 > top && overPart(b, x, z, EDGE)) top = b.y1;
  return Number.isFinite(top) ? top : def.h;
}

// ---------- what an item is ----------

/** Named like a seat, or like something that lives on the floor: never guessed onto a table. */
const FLOOR_ANYWHERE = new Set([
  'chair', 'armchair', 'highchair', 'stool', 'footstool', 'bench', 'ottoman', 'pouf', 'pouffe', 'sofa', 'couch',
  'settee', 'loveseat', 'futon', 'recliner', 'beanbag', 'bin', 'wastebasket', 'basket', 'hamper', 'floor', 'trash',
  'waste', 'laundry', 'litter',
]);
/** …or ends in a word for furniture of its own (a "side table", but not a "table lamp"). */
const FLOOR_LAST = new Set([
  'seat', 'table', 'desk', 'nightstand', 'dresser', 'cabinet', 'sideboard', 'credenza', 'bookcase', 'bookshelf',
  'wardrobe', 'bed', 'crib', 'cot', 'mattress', 'rug', 'mat', 'carpet', 'crate', 'trunk', 'cart', 'trolley',
]);

const forms = (w: string): string[] => [w, w.replace(/e?s$/, ''), w.replace(/s$/, '')];

/** Does this name read as a seat, or as something kept on the floor or under a table? */
export function readsAsFloorThing(label: string): boolean {
  const words = (typeof label === 'string' ? label.toLowerCase() : '').match(/[a-z]+/g) ?? [];
  if (words.length === 0) return false;
  if (words.some((w) => forms(w).some((f) => FLOOR_ANYWHERE.has(f)))) return true;
  return forms(words[words.length - 1]).some((f) => FLOOR_LAST.has(f));
}

/** An item as the resting rules see it. */
export interface Body {
  f: Furniture;
  /** Index in the plan's furniture: the order things were placed. */
  i: number;
  def: FurnitureDef;
  area: number;
  /** The area in whole square centimetres: equal keys are "the same size". */
  key: number;
  cos: number;
  sin: number;
  hw: number;
  hd: number;
  /** Squared reach from the centre to a corner. */
  reach2: number;
  /** Thinner than FLAT: a rug, a mat, a plate. */
  thin: boolean;
  platform: boolean;
  tabletop: boolean;
  rest: Rest;
}

function bodyOf(f: Furniture, i: number, defOf: DefOf): Body | null {
  if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.rotation)) return null;
  let def: FurnitureDef | null | undefined;
  try {
    def = defOf(f.kind);
  } catch {
    return null;
  }
  if (!def || !(def.w > 0) || !(def.d > 0) || !Number.isFinite(def.w) || !Number.isFinite(def.d) || !Number.isFinite(def.h)) {
    return null;
  }
  const builtin = isBuiltinKind(f.kind);
  const area = def.w * def.d;
  return {
    f,
    i,
    def,
    area,
    key: Math.round(area * 1e4),
    cos: Math.cos(f.rotation),
    sin: Math.sin(f.rotation),
    hw: def.w / 2,
    hd: def.d / 2,
    reach2: (def.w * def.w + def.d * def.d) / 4 + 1e-9,
    thin: def.h < FLAT,
    platform: builtin && PLATFORMS.has(f.kind),
    tabletop: !builtin && def.h <= TABLETOP_HEIGHT && !shapeOf(def).floorThing && shapeOf(def).bottom <= HUNG,
    rest: FLOOR_REST,
  };
}

/** Where the plan point (x, y) falls in an item's own frame. */
function local(b: Body, x: number, y: number): [number, number] {
  const dx = x - b.f.x;
  const dy = y - b.f.y;
  return [dx * b.cos + dy * b.sin, -dx * b.sin + dy * b.cos];
}

// ---------- resting ----------

/** Does `b` come before `a` in the carrying order: bigger, or as big and placed earlier? */
const outranks = (b: Body, a: Body): boolean => b.key > a.key || (b.key === a.key && b.i < a.i);

/**
 * Where `a` comes to rest among `bodies` (the first `end` of them, all with
 * their own rest already worked out). Only bodies that outrank it are
 * considered, so the order of the list does not matter.
 */
function settle(a: Body, bodies: readonly Body[], end: number): Rest {
  let any: { b: Body; y: number } | null = null;
  let platform: { b: Body; y: number } | null = null;
  let invited = false;
  for (let j = 0; j < end; j++) {
    const b = bodies[j];
    if (b === a || b.f.id === a.f.id || !outranks(b, a)) continue;
    // A rug on the floor carries nothing; a plate carries another plate, and on a table anything.
    if (b.thin && b.f.kind !== a.f.kind && !b.rest.on) continue;
    const dx = a.f.x - b.f.x;
    const dy = a.f.y - b.f.y;
    if (dx * dx + dy * dy > b.reach2) continue;
    const [u, v] = local(b, a.f.x, a.f.y);
    if (Math.abs(u) > b.hw + 1e-6 || Math.abs(v) > b.hd + 1e-6) continue;
    const top = surfaceAt(b.def, u, v);
    if (!(top > 0) || top > HIGHEST_SURFACE) continue;
    const y = b.rest.lift + top;
    if (!any || y > any.y) any = { b, y };
    if (b.platform && (!platform || y > platform.y)) platform = { b, y };
    if (b.area >= a.area * TABLETOP_SURFACE || b.f.kind === a.f.kind) invited = true;
  }
  if (!any) return FLOOR_REST;
  const mode = a.f.rest;
  const chosen = mode === 'floor' ? null : mode === 'top' || (a.tabletop && invited) ? any : platform;
  return chosen
    ? { lift: chosen.y, on: chosen.b.f.id, beneath: any.b.f.id, depth: chosen.b.rest.depth + 1 }
    : { lift: 0, on: null, beneath: any.b.f.id, depth: 0 };
}

/**
 * Where everything in `furniture` rests: one entry per item id. Cheap enough
 * to run on every edit (a pair test per two items, most rejected by distance)
 * and total: an item with bad numbers or an unknown kind stands on the floor
 * and carries nothing.
 */
export function restOf(furniture: readonly Furniture[], defOf: DefOf): RestMap {
  const out: RestMap = new Map();
  const bodies: Body[] = [];
  furniture.forEach((f, i) => {
    if (!f || typeof f.id !== 'string') return;
    out.set(f.id, FLOOR_REST);
    const b = bodyOf(f, i, defOf);
    if (b) bodies.push(b);
  });
  // Biggest first, the same sizes in the order placed: whatever can carry an item comes before it.
  bodies.sort((a, b) => b.key - a.key || a.i - b.i);
  for (let k = 0; k < bodies.length; k++) {
    const a = bodies[k];
    try {
      a.rest = settle(a, bodies, k);
      out.set(a.f.id, a.rest);
    } catch {
      // A broken item stands on the floor.
    }
  }
  return out;
}

/**
 * Everything standing still while some pieces are moved: what a piece in
 * hand could come to rest on, wherever it is tried.
 */
export interface Ground {
  readonly rest: RestMap;
  readonly bodies: readonly Body[];
  /** Where each item sits in the plan's list (the order things were placed). */
  readonly index: ReadonlyMap<string, number>;
  readonly defOf: DefOf;
}

/** The ground for moving `moving` (they and whatever rides on them are left out). */
export function groundFor(furniture: readonly Furniture[], defOf: DefOf, moving: ReadonlySet<string>): Ground {
  const rest = restOf(furniture, defOf);
  const riders = ridersOf(rest, moving);
  const bodies: Body[] = [];
  const index = new Map<string, number>();
  furniture.forEach((f, i) => {
    if (!f || typeof f.id !== 'string') return;
    index.set(f.id, i);
    if (moving.has(f.id) || riders.has(f.id)) return;
    const b = bodyOf(f, i, defOf);
    if (!b) return;
    b.rest = rest.get(f.id) ?? FLOOR_REST;
    bodies.push(b);
  });
  return { rest, bodies, index, defOf };
}

/**
 * Where `item` would rest if it stood where it says, everything else staying
 * put. A new item (not yet in the plan) counts as placed last.
 */
export function restHere(ground: Ground, item: Furniture): Rest {
  try {
    const b = bodyOf(item, ground.index.get(item.id) ?? ground.index.size, ground.defOf);
    return b ? settle(b, ground.bodies, ground.bodies.length) : FLOOR_REST;
  } catch {
    return FLOOR_REST;
  }
}

/** How high an item stands (0 when unknown). */
export const liftOf = (rest: RestMap, id: string): number => rest.get(id)?.lift ?? 0;

/** Everything resting on `ids`, on what rests on them, and so on (not `ids` themselves). */
export function ridersOf(rest: RestMap, ids: Iterable<string>): Set<string> {
  const kids = new Map<string, string[]>();
  for (const [id, r] of rest) {
    if (!r.on) continue;
    const list = kids.get(r.on);
    if (list) list.push(id);
    else kids.set(r.on, [id]);
  }
  const from = new Set(ids);
  const out = new Set<string>();
  const queue = [...from];
  while (queue.length) {
    const id = queue.pop()!;
    for (const k of kids.get(id) ?? []) {
      if (out.has(k) || from.has(k)) continue;
      out.add(k);
      queue.push(k);
    }
  }
  return out;
}

/** Does something rest on this item? */
export function carriesAnything(rest: RestMap, id: string): boolean {
  for (const r of rest.values()) if (r.on === id) return true;
  return false;
}

/** Is `id` resting (however far up) on one of `ids`? */
export function restsOnAny(rest: RestMap, id: string, ids: ReadonlySet<string>): boolean {
  let on = rest.get(id)?.on ?? null;
  for (let guard = 0; on && guard < 10_000; guard++) {
    if (ids.has(on)) return true;
    on = rest.get(on)?.on ?? null;
  }
  return false;
}

/** Furniture in drawing order for a plan: rugs first, then whatever stands on the floor, then what rests on it, and so on up. */
export function stackOrder<T extends Pick<Furniture, 'id'>>(furniture: readonly T[], rest: RestMap, flat: (f: T) => boolean): T[] {
  const tier = (f: T): number => {
    const depth = rest.get(f.id)?.depth ?? 0;
    return depth > 0 ? depth + 1 : flat(f) ? 0 : 1;
  };
  let sorted = true;
  for (let i = 1; i < furniture.length && sorted; i++) if (tier(furniture[i]) < tier(furniture[i - 1])) sorted = false;
  if (sorted) return furniture as T[];
  return furniture
    .map((f, i) => ({ f, i, t: tier(f) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((e) => e.f);
}

// ---------- carrying ----------

type Pose = Pick<Furniture, 'x' | 'y' | 'rotation'>;

/** Where `item` ends up when the piece it rests on goes from `from` to `to`: same place on it, turned with it. */
export function carried(item: Pose, from: Pose, to: Pose): Pose {
  const t = to.rotation - from.rotation;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = item.x - from.x;
  const dy = item.y - from.y;
  return { x: to.x + dx * c - dy * s, y: to.y + dx * s + dy * c, rotation: item.rotation + t };
}

/**
 * After some pieces moved or turned (`before` → `after`, with `rest` worked
 * out from `before`), whatever rested on them goes along as if carried. A
 * piece that was itself moved stays where it was put. Returns `after` itself
 * when nothing needed carrying.
 */
export function carryRiders(before: readonly Furniture[], after: Furniture[], rest: RestMap, round: (p: Pose) => Pose = (p) => p): Furniture[] {
  const was = new Map(before.map((f) => [f.id, f]));
  const now = new Map(after.map((f) => [f.id, f]));
  const moved = (id: string): boolean => {
    const a = was.get(id);
    const b = now.get(id);
    return !!a && !!b && (a.x !== b.x || a.y !== b.y || a.rotation !== b.rotation);
  };
  let changed = false;
  const out = after.map((f) => {
    const r = rest.get(f.id);
    if (!r?.on || moved(f.id)) return f;
    // The nearest piece beneath it that moved.
    let s: string | null = r.on;
    for (let guard = 0; s && !moved(s) && guard < 10_000; guard++) s = rest.get(s)?.on ?? null;
    if (!s || !moved(s)) return f;
    changed = true;
    return { ...f, ...round(carried(was.get(f.id) ?? f, was.get(s)!, now.get(s)!)) };
  });
  return changed ? out : after;
}
