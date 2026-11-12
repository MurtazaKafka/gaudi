/**
 * Plan-edit operations: the small vocabulary Claude answers "Ask Gaudí"
 * requests in, and the pure function that applies them.
 *
 * `applyOps(plan, ops, refs)` never touches the store: it works on a copy,
 * applies each operation on its own (a bad one is dropped with a reason, the
 * rest still land) and returns the new plan. Things are referenced by the
 * short ids `describePlan` hands out (W3, D1, F2, R1 or a room name), never
 * by raw uuid, so the model cannot invent a reference that half-works.
 */
import { dist, distToSegment, pointInPolygon, quadsOverlap } from '../geometry';
import { detectRooms, type DetectedRoom } from '../rooms';
import type { FurnitureKind } from '../catalog';
import type { Furniture, Opening, PlanData, Point, Wall } from '../types';
import {
  COMPASS,
  OPENING_GAP,
  analyzeRooms,
  clampOffset,
  clearZone,
  collinearOverlap,
  crossesWall,
  defFor,
  degToRad,
  fitsInside,
  footprint,
  interiorPoint,
  isCompass,
  isFlat,
  isNum,
  openingFits,
  pointOnWall,
  projectOnWall,
  r3,
  roomOpenings,
  settleInside,
  type Compass,
} from './planGeom';

// ---------- references ----------

export interface RoomRef {
  /** R1, R2 … */
  ref: string;
  key: string;
  name: string | undefined;
}

/** Short id → real id, as handed to the model by `describePlan`. */
export interface PlanRefs {
  walls: Record<string, string>;
  openings: Record<string, string>;
  furniture: Record<string, string>;
  rooms: RoomRef[];
}

// ---------- the vocabulary ----------

export type EditOp =
  | { op: 'move_wall'; wall: string; toward: Compass; distance: number }
  | { op: 'add_wall'; x1: number; y1: number; x2: number; y2: number }
  | { op: 'remove_wall'; wall: string }
  | { op: 'add_opening'; wall: string; kind: 'door' | 'window'; offset: number; width: number }
  | { op: 'move_opening'; opening: string; wall: string; offset: number }
  | { op: 'resize_opening'; opening: string; width: number }
  | { op: 'remove_opening'; opening: string }
  | { op: 'rename_room'; room: string; name: string }
  | { op: 'name_room_at'; x: number; y: number; name: string }
  | { op: 'add_furniture'; kind: string; room: string; x: number; y: number; rotation_deg: number }
  | { op: 'move_furniture'; item: string; x: number; y: number }
  | { op: 'rotate_furniture'; item: string; rotation_deg: number }
  | { op: 'remove_furniture'; item: string }
  | { op: 'clear_room'; room: string }
  | { op: 'set_wall_height'; height: number }
  | { op: 'cannot'; reason: string };

export interface EditReply {
  /** One short sentence, past tense, shown to the user. */
  summary: string;
  operations: EditOp[];
}

const obj = (props: Record<string, unknown>) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
const str = { type: 'string' };
const num = { type: 'number' };
const SIDES = ['north', 'south', 'east', 'west'];

/** JSON schema for the reply. `kinds` is every furniture kind valid in this plan. */
export function editSchema(kinds: string[]): Record<string, unknown> {
  const op = (name: string, props: Record<string, unknown>) => obj({ op: { type: 'string', enum: [name] }, ...props });
  return obj({
    summary: str,
    operations: {
      type: 'array',
      items: {
        anyOf: [
          op('move_wall', { wall: str, toward: { type: 'string', enum: SIDES }, distance: num }),
          op('add_wall', { x1: num, y1: num, x2: num, y2: num }),
          op('remove_wall', { wall: str }),
          op('add_opening', { wall: str, kind: { type: 'string', enum: ['door', 'window'] }, offset: num, width: num }),
          op('move_opening', { opening: str, wall: str, offset: num }),
          op('resize_opening', { opening: str, width: num }),
          op('remove_opening', { opening: str }),
          op('rename_room', { room: str, name: str }),
          op('name_room_at', { x: num, y: num, name: str }),
          op('add_furniture', { kind: { type: 'string', enum: kinds }, room: str, x: num, y: num, rotation_deg: num }),
          op('move_furniture', { item: str, x: num, y: num }),
          op('rotate_furniture', { item: str, rotation_deg: num }),
          op('remove_furniture', { item: str }),
          op('clear_room', { room: str }),
          op('set_wall_height', { height: num }),
          op('cannot', { reason: str }),
        ],
      },
    },
  });
}

/** How the operations work — the part of the prompt that belongs with the applier. */
export const OPS_GUIDE = `OPERATIONS (all lengths in meters, whatever units the user typed)
- move_wall {wall, toward, distance}: slide a wall sideways toward north/south/east/west by distance. wall may list several walls that lie on one line ("W1, W2") to move a whole face of the house together; a wall moved on its own while its in-line neighbour stays gets a short return wall, so rooms stay closed. Attached walls stretch or shorten to follow, doors and windows stay where they are, furniture standing against the wall moves with it. This is how rooms are made wider, deeper or smaller: move the wall on the side that should change.
- add_wall {x1,y1,x2,y2}: a new straight wall. End it exactly on existing walls or corners so rooms close.
- remove_wall {wall}: also removes its doors and windows. Rooms on both sides merge.
- add_opening {wall, kind, offset, width}: a door or window. offset = meters from the wall's first listed endpoint to the opening's center; use -1 to center it on the wall. Typical widths: door 0.9, window 1.2. wall may be "new" for the wall added just before.
- move_opening {opening, wall, offset}: slide an opening along its wall, or move it to another wall. offset as above.
- resize_opening {opening, width} · remove_opening {opening}
- rename_room {room, name}: room is an id like R2 or the room's current name.
- name_room_at {x, y, name}: name whichever room contains the point — use it for rooms created by add_wall.
- add_furniture {kind, room, x, y, rotation_deg}: x,y is the item's center; room is the room it must end up in ("" if none). It is nudged to fit inside the room and clear of other pieces.
- move_furniture {item, x, y} · rotate_furniture {item, rotation_deg} (absolute, clockwise; 0 = front faces south) · remove_furniture {item}
- clear_room {room}: remove every piece of furniture in a room.
- set_wall_height {height}
- cannot {reason}: when the request (or part of it) cannot be expressed with these operations — a second storey, stairs, curved walls, materials. One plain sentence the user will read.
Operations run in order. Ids refer to the plan as described; something you add cannot be referenced later (except wall "new").`;

// ---------- result ----------

export interface DroppedOp {
  index: number;
  op: string;
  reason: string;
}

export interface ApplyResult {
  plan: PlanData;
  /** operations that changed the plan */
  applied: number;
  dropped: DroppedOp[];
  /** reasons from `cannot` operations */
  cannot: string[];
  /** ids of things added or moved, for selecting / highlighting */
  touched: { walls: string[]; openings: string[]; furniture: string[] };
}

class OpError extends Error {}
const fail = (reason: string): never => {
  throw new OpError(reason);
};

interface Ctx {
  refs: PlanRefs;
  /** live room key for each room ref (keys change when walls are added or removed) */
  roomKeys: Map<string, string | null>;
  lastWallId: string | null;
  newId: () => string;
  touched: ApplyResult['touched'];
}

const MAX_COORD = 2000;
const MIN_WALL = 0.1;
const JOIN = 0.002;

const near = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < JOIN && Math.abs(a.y - b.y) < JOIN;
const coord = (v: unknown, what: string): number =>
  isNum(v) && Math.abs(v) <= MAX_COORD ? v : fail(`${what} is not a usable number`);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function copyPlan(plan: PlanData): PlanData {
  return {
    ...plan,
    walls: plan.walls.map((w) => ({ id: w.id, a: { ...w.a }, b: { ...w.b } })),
    openings: plan.openings.map((o) => ({ ...o })),
    furniture: plan.furniture.map((f) => ({ ...f })),
    roomNames: { ...plan.roomNames },
    settings: { ...plan.settings },
    look: { ...plan.look },
  };
}

// ---------- room tracking ----------

/**
 * Rooms are keyed by their wall-id set, so the key changes whenever a wall is
 * added or removed. Map each room that was there before onto the room that
 * replaced it, so names (and the model's R-ids) survive structural edits.
 */
export function remapRooms(before: DetectedRoom[], after: DetectedRoom[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const afterKeys = new Set(after.map((r) => r.key));
  const probes = new Map<DetectedRoom, Point>();
  const probe = (r: DetectedRoom): Point => {
    let p = probes.get(r);
    if (!p) probes.set(r, (p = interiorPoint(r.polygon)));
    return p;
  };
  for (const o of before) {
    if (afterKeys.has(o.key)) {
      map.set(o.key, o.key);
      continue;
    }
    let best: DetectedRoom | null = null;
    let bestScore = 0;
    for (const n of after) {
      let score = 0;
      if (pointInPolygon(probe(o), n.polygon)) score += 2;
      if (pointInPolygon(probe(n), o.polygon)) score += 2;
      if (pointInPolygon(o.centroid, n.polygon)) score += 1;
      if (score === 0) continue;
      score += 1 / (1 + Math.abs(n.area - o.area));
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    map.set(o.key, best ? best.key : null);
  }
  return map;
}

/** Carry room names (and room refs) across a structural change. Mutates `plan.roomNames`. */
function retrack(before: DetectedRoom[], plan: PlanData, ctx: Ctx): void {
  const after = detectRooms(plan.walls);
  const map = remapRooms(before, after);
  const names: Record<string, string> = {};
  const claim = new Map<string, number>();
  for (const o of before) {
    const to = map.get(o.key);
    const name = plan.roomNames[o.key];
    if (!to || !name) continue;
    // When rooms merge, the larger one's name wins.
    if ((claim.get(to) ?? -1) < o.area) {
      claim.set(to, o.area);
      names[to] = name;
    }
  }
  // Names of rooms this pass knows nothing about (stale keys) are dropped: they point at nothing.
  plan.roomNames = names;
  for (const [ref, key] of ctx.roomKeys) {
    if (key !== null) ctx.roomKeys.set(ref, map.get(key) ?? null);
  }
}

function findRoom(plan: PlanData, ctx: Ctx, raw: unknown): DetectedRoom {
  const t = text(raw);
  if (!t) fail('no room given');
  const rooms = detectRooms(plan.walls);
  const lower = t.toLowerCase();
  const byRef = ctx.refs.rooms.find((r) => r.ref.toLowerCase() === lower);
  if (byRef) {
    const key = ctx.roomKeys.get(byRef.ref);
    const room = key ? rooms.find((r) => r.key === key) : undefined;
    return room ?? fail(`room ${byRef.ref} no longer exists`);
  }
  const named = rooms.filter((r) => (plan.roomNames[r.key] ?? '').toLowerCase() === lower);
  if (named.length === 1) return named[0];
  if (named.length > 1) fail(`more than one room is called "${t}"`);
  return fail(`no room "${t}"`);
}

// ---------- lookups ----------

function findWall(plan: PlanData, ctx: Ctx, raw: unknown): Wall {
  const t = text(raw);
  if (!t) fail('no wall given');
  const id = t.toLowerCase() === 'new' ? ctx.lastWallId : (ctx.refs.walls[t.toUpperCase()] ?? null);
  const wall = id ? plan.walls.find((w) => w.id === id) : undefined;
  return wall ?? fail(`no wall "${t}"`);
}

function findOpening(plan: PlanData, ctx: Ctx, raw: unknown): Opening {
  const t = text(raw);
  const id = ctx.refs.openings[t.toUpperCase()];
  const o = id ? plan.openings.find((x) => x.id === id) : undefined;
  return o ?? fail(`no opening "${t}"`);
}

function findFurniture(plan: PlanData, ctx: Ctx, raw: unknown): Furniture {
  const t = text(raw);
  const id = ctx.refs.furniture[t.toUpperCase()];
  const f = id ? plan.furniture.find((x) => x.id === id) : undefined;
  return f ?? fail(`no furniture "${t}"`);
}

// ---------- openings ----------

/** Nearest offset to `want` where an opening of `width` fits on the wall, or null. */
export function freeOffset(
  openings: Opening[],
  wall: Wall,
  want: number,
  width: number,
  ignoreId?: string,
): number | null {
  const len = dist(wall.a, wall.b);
  if (len < width + 2 * OPENING_GAP - 1e-9) return null;
  const start = clampOffset(wall, want, width);
  if (openingFits(openings, wall, start, width, ignoreId)) return r3(start);
  for (let step = 0.05; step < len; step += 0.05) {
    for (const s of [1, -1]) {
      const o = start + s * step;
      if (o !== clampOffset(wall, o, width)) continue;
      if (openingFits(openings, wall, o, width, ignoreId)) return r3(o);
    }
  }
  return null;
}

/**
 * After walls changed shape: keep every opening at the same place in the
 * world where its wall still passes, slide it if the wall got shorter, drop
 * it if it no longer fits at all.
 */
function refitOpenings(plan: PlanData, old: Map<string, Wall>): void {
  const kept: Opening[] = [];
  for (const o of plan.openings) {
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const before = old.get(wall.id);
    let offset = o.offset;
    const len = dist(wall.a, wall.b);
    if (before && (!near(before.a, wall.a) || !near(before.b, wall.b))) {
      offset = projectOnWall(wall, pointOnWall(before, o.offset));
      // The wall no longer reaches where the opening was.
      if (offset < 0 || offset > len) continue;
    }
    if (len < o.width + 2 * OPENING_GAP - 1e-9) continue;
    offset = r3(clampOffset(wall, offset, o.width));
    if (!openingFits(kept, wall, offset, o.width)) {
      const free = freeOffset(kept, wall, offset, o.width);
      if (free === null) continue;
      offset = free;
    }
    kept.push(offset === o.offset ? o : { ...o, offset });
  }
  plan.openings = kept;
}

// ---------- walls ----------

const unit = (a: Point, b: Point): Point => {
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
};
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;

function moveWall(plan: PlanData, ctx: Ctx, wall: Wall, toward: Compass, distance: number): void {
  const len = dist(wall.a, wall.b);
  if (len < 1e-6) fail('that wall has no length');
  const u = unit(wall.a, wall.b);
  let n: Point = { x: -u.y, y: u.x };
  const along = dot(n, COMPASS[toward]);
  if (Math.abs(along) < 0.3) fail(`that wall runs ${toward === 'north' || toward === 'south' ? 'north–south' : 'east–west'}, so it cannot move ${toward}`);
  if (along < 0) n = { x: -n.x, y: -n.y };
  const d = distance;
  const shift = (p: Point): Point => ({ x: r3(p.x + n.x * d), y: r3(p.y + n.y * d) });

  const old = new Map(plan.walls.map((w) => [w.id, { id: w.id, a: { ...w.a }, b: { ...w.b } }]));
  const others = plan.walls.filter((w) => w.id !== wall.id);
  const jogs: Wall[] = [];
  const gone = new Set<string>();
  const updates: { wall: Wall; end: 'a' | 'b'; to: Point }[] = [];

  for (const end of ['a', 'b'] as const) {
    const P = { ...wall[end] };
    const P2 = shift(P);
    updates.push({ wall, end, to: P2 });
    let keep = false; // something stays behind at P and must remain connected
    let covered = false; // some wall spans P → P2 after the move
    const shorten: { wall: Wall; end: 'a' | 'b' }[] = [];
    const closing: Wall[] = []; // return walls exactly as long as the move: they close up
    for (const x of others) {
      let attached = false;
      for (const xe of ['a', 'b'] as const) {
        if (!near(x[xe], P)) continue;
        attached = true;
        const far = x[xe === 'a' ? 'b' : 'a'];
        const xl = dist(P, far);
        if (xl < 1e-6) continue;
        const xu = unit(P, far);
        if (Math.abs(cross(xu, u)) < 0.05) {
          // A collinear continuation of this wall: it stays where it is.
          keep = true;
          continue;
        }
        const c = dot(xu, n);
        if (c > 0.999) {
          // Runs exactly the way the wall is moving: it gets shorter (or becomes a T-junction).
          covered = true;
          if (Math.abs(xl - d) < 0.01) closing.push(x);
          else if (xl < d + MIN_WALL) fail('that is further than the neighbouring wall is long — the room would collapse');
          else shorten.push({ wall: x, end: xe });
        } else {
          if (c < -0.999) covered = true;
          updates.push({ wall: x, end: xe, to: P2 });
        }
      }
      if (attached) continue;
      // This end abuts the middle of another wall (a T-junction).
      if (distToSegment(P, x.a, x.b) < 0.01) {
        const xu = unit(x.a, x.b);
        if (Math.abs(cross(xu, n)) < 0.05) {
          if (distToSegment(P2, x.a, x.b) > 0.01) fail('that would slide the wall off the end of the wall it joins');
          covered = true;
        } else {
          keep = true;
        }
      }
    }
    if (keep) {
      // The corner left behind must stay closed: walls ahead keep their length
      // (the moved wall now meets them mid-way), and a short return wall is
      // added if nothing else joins the old corner to the new one.
      if (!covered) jogs.push({ id: ctx.newId(), a: P, b: P2 });
    } else {
      for (const sh of shorten) updates.push({ ...sh, to: P2 });
      for (const x of closing) gone.add(x.id);
    }
  }

  // Walls that abut the middle of the moved wall follow it.
  for (const x of others) {
    for (const xe of ['a', 'b'] as const) {
      const p = x[xe];
      if (near(p, wall.a) || near(p, wall.b)) continue;
      if (distToSegment(p, wall.a, wall.b) > 0.01) continue;
      const far = x[xe === 'a' ? 'b' : 'a'];
      const xl = dist(p, far);
      if (xl > 1e-6 && dot(unit(p, far), n) > 0.999 && xl < d + MIN_WALL) {
        fail('that is further than a wall joining it is long — a room would collapse');
      }
      updates.push({ wall: x, end: xe, to: shift(p) });
    }
  }

  for (const up of updates) up.wall[up.end] = { ...up.to };
  if (gone.size) {
    plan.walls = plan.walls.filter((w) => !gone.has(w.id));
    plan.openings = plan.openings.filter((o) => !gone.has(o.wallId));
  }
  plan.walls.push(...jogs);

  for (const w of plan.walls) {
    if (dist(w.a, w.b) < MIN_WALL) fail('that would squash a wall to nothing');
  }
  for (const x of plan.walls) {
    if (x.id !== wall.id && collinearOverlap(wall, x) > 0.05) fail('that would put the wall on top of another one');
  }

  refitOpenings(plan, old);

  // Furniture standing against the wall goes with it; furniture in its path is pushed ahead.
  const before = old.get(wall.id)!;
  plan.furniture = plan.furniture.map((f) => {
    const def = defFor(plan, f.kind);
    if (!def) return f;
    const t = projectOnWall(before, f);
    if (t < -0.1 || t > len + 0.1) return f;
    const s = (f.x - before.a.x) * n.x + (f.y - before.a.y) * n.y;
    const half = Math.max(...footprint(def, f).map((c) => Math.abs((c.x - f.x) * n.x + (c.y - f.y) * n.y)));
    let by = 0;
    if (Math.abs(s) - half <= 0.3) by = d;
    else if (s > 0 && s < d + half + 0.05) by = d + half + 0.05 - s;
    if (by === 0) return f;
    ctx.touched.furniture.push(f.id);
    return { ...f, x: r3(f.x + n.x * by), y: r3(f.y + n.y * by) };
  });

  ctx.touched.walls.push(wall.id, ...jogs.map((j) => j.id));
}

/** Snap a new wall's endpoint onto the drawing: a corner, else a wall, else the centimeter. */
function snapEnd(p: Point, walls: Wall[]): Point {
  let best: Point | null = null;
  let bestD = 0.15;
  for (const w of walls) {
    for (const e of [w.a, w.b]) {
      const dd = dist(p, e);
      if (dd < bestD) {
        bestD = dd;
        best = e;
      }
    }
  }
  if (best) return { ...best };
  bestD = 0.15;
  for (const w of walls) {
    const len = dist(w.a, w.b);
    if (len < 1e-6) continue;
    const t = Math.min(len, Math.max(0, projectOnWall(w, p)));
    const q = pointOnWall(w, t);
    const dd = dist(p, q);
    if (dd < bestD) {
      bestD = dd;
      best = q;
    }
  }
  if (best) return { x: r3(best.x), y: r3(best.y) };
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

function addWall(plan: PlanData, ctx: Ctx, rawA: Point, rawB: Point): void {
  let a = snapEnd(rawA, plan.walls);
  let b = snapEnd(rawB, plan.walls);
  // Square up a wall that is a hair off horizontal / vertical after snapping.
  if (Math.abs(a.x - b.x) < 0.03 && Math.abs(a.y - b.y) > 0.2) {
    const onA = plan.walls.some((w) => distToSegment(a, w.a, w.b) < 0.005);
    if (onA) b = { x: a.x, y: b.y };
    else a = { x: b.x, y: a.y };
  } else if (Math.abs(a.y - b.y) < 0.03 && Math.abs(a.x - b.x) > 0.2) {
    const onA = plan.walls.some((w) => distToSegment(a, w.a, w.b) < 0.005);
    if (onA) b = { x: b.x, y: a.y };
    else a = { x: a.x, y: b.y };
  }
  const len = dist(a, b);
  if (len < 0.2) fail('that wall would be too short');
  const probe: Wall = { id: '', a, b };
  for (const w of plan.walls) {
    if (collinearOverlap(probe, w) > 0.05) fail('a wall is already there');
  }

  // Split where it crosses existing walls so rooms on both sides are detected.
  const u = unit(a, b);
  const cuts: number[] = [];
  for (const w of plan.walls) {
    const wl = dist(w.a, w.b);
    if (wl < 1e-6) continue;
    const wu = unit(w.a, w.b);
    const den = cross(u, wu);
    if (Math.abs(den) < 1e-9) continue;
    const ax = { x: w.a.x - a.x, y: w.a.y - a.y };
    const t = cross(ax, wu) / den;
    const s = cross(ax, u) / den;
    if (t > 0.01 && t < len - 0.01 && s > 0.01 && s < wl - 0.01) cuts.push(t);
  }
  cuts.sort((p, q) => p - q);
  let prev = a;
  let prevT = 0;
  const pieces: Wall[] = [];
  for (const t of [...cuts, len]) {
    if (t - prevT < 0.02) continue;
    const p = t === len ? b : { x: r3(a.x + u.x * t), y: r3(a.y + u.y * t) };
    pieces.push({ id: ctx.newId(), a: { ...prev }, b: { ...p } });
    prev = p;
    prevT = t;
  }
  if (pieces.length === 0) fail('that wall would be too short');
  plan.walls.push(...pieces);
  ctx.lastWallId = pieces[pieces.length - 1].id;
  ctx.touched.walls.push(...pieces.map((p) => p.id));
}

// ---------- furniture ----------

const shrinkQuad = (q: Point[], by: number): Point[] => {
  const cx = q.reduce((s, p) => s + p.x, 0) / q.length;
  const cy = q.reduce((s, p) => s + p.y, 0) / q.length;
  return q.map((p) => {
    const l = Math.hypot(p.x - cx, p.y - cy) || 1;
    const k = Math.max(0, l - by) / l;
    return { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k };
  });
};

export interface PlaceRequest {
  kind: string;
  x: number;
  y: number;
  rotation: number;
  /** the room it must end up in; null = wherever the point is */
  room: DetectedRoom | null;
  ignoreId?: string;
  /** how far (m) the piece may be nudged from the spot asked for */
  reach?: number;
  /** keep the floor in front of doors free (new pieces; things the user placed are left alone) */
  clearDoors?: boolean;
}

/**
 * Find a legal spot for a piece at or near where it was asked to go: inside
 * the room, not through a wall, clear of other furniture and of door swings.
 */
export function placeFurniture(plan: PlanData, req: PlaceRequest): Point | null {
  const def = defFor(plan, req.kind);
  if (!def) return null;
  const flat = isFlat(req.kind, def);
  const room =
    req.room ?? detectRooms(plan.walls).find((r) => pointInPolygon({ x: req.x, y: req.y }, r.polygon)) ?? null;
  const margin = plan.settings.wallThickness / 2 + 0.01;

  const obstacles: Point[][] = [];
  if (!flat) {
    for (const f of plan.furniture) {
      if (f.id === req.ignoreId) continue;
      const fd = defFor(plan, f.kind);
      if (!fd || isFlat(f.kind, fd)) continue;
      obstacles.push(footprint(fd, f));
    }
    if (room && req.clearDoors) {
      const info = analyzeRooms(plan.walls, plan.roomNames).find((r) => r.room.key === room.key);
      if (info) {
        for (const o of roomOpenings(info, plan.walls, plan.openings)) {
          if (o.opening.type === 'door') obstacles.push(clearZone(o, Math.min(0.9, o.opening.width)));
        }
      }
    }
  }

  const tryAt = (x: number, y: number, shift: number): Point | null => {
    let p: Point | null = { x: r3(x), y: r3(y) };
    if (room) {
      p = settleInside(x, y, def.w, def.d, req.rotation, room.polygon, shift, margin);
      if (!p) return null;
    }
    const quad = footprint(def, { x: p.x, y: p.y, rotation: req.rotation });
    if (room ? !fitsInside(quad, room.polygon) : crossesWall(quad, plan.walls)) return null;
    const tight = shrinkQuad(quad, 0.02);
    if (obstacles.some((q) => quadsOverlap(tight, q))) return null;
    return p;
  };

  const reach = req.reach ?? 1.2;
  const first = tryAt(req.x, req.y, Math.max(0.4, reach));
  if (first) return first;
  for (let ring = 0.15; ring <= reach + 1e-9; ring += 0.15) {
    for (let k = 0; k < 8; k++) {
      const ang = (k * Math.PI) / 4;
      const p = tryAt(req.x + Math.cos(ang) * ring, req.y + Math.sin(ang) * ring, 0.3);
      if (p) return p;
    }
  }
  return null;
}

// ---------- one operation ----------

function applyOne(plan: PlanData, ctx: Ctx, raw: Record<string, unknown>): void {
  switch (raw.op) {
    case 'move_wall': {
      // Several collinear walls ("W1, W2") move together as one face.
      const names = text(raw.wall).split(/[\s,]+/).filter(Boolean);
      if (names.length === 0 || names.length > 12) fail('no wall given');
      const walls = [...new Set(names.map((n) => findWall(plan, ctx, n)))];
      if (!isCompass(raw.toward)) fail('no direction given');
      let distance = coord(raw.distance, 'distance');
      let toward = raw.toward as Compass;
      if (distance < 0) {
        distance = -distance;
        toward = ({ north: 'south', south: 'north', east: 'west', west: 'east' } as const)[toward];
      }
      if (distance < 0.005) fail('the distance is zero');
      if (distance > 50) fail('that distance is too large');
      const before = detectRooms(plan.walls);
      for (const wall of walls) {
        // A wall may have closed up while its neighbours moved.
        const live = plan.walls.find((w) => w.id === wall.id);
        if (live) moveWall(plan, ctx, live, toward, distance);
      }
      retrack(before, plan, ctx);
      return;
    }
    case 'add_wall': {
      const a = { x: coord(raw.x1, 'x1'), y: coord(raw.y1, 'y1') };
      const b = { x: coord(raw.x2, 'x2'), y: coord(raw.y2, 'y2') };
      const before = detectRooms(plan.walls);
      addWall(plan, ctx, a, b);
      retrack(before, plan, ctx);
      return;
    }
    case 'remove_wall': {
      const wall = findWall(plan, ctx, raw.wall);
      const before = detectRooms(plan.walls);
      plan.walls = plan.walls.filter((w) => w.id !== wall.id);
      plan.openings = plan.openings.filter((o) => o.wallId !== wall.id);
      retrack(before, plan, ctx);
      return;
    }
    case 'add_opening': {
      const wall = findWall(plan, ctx, raw.wall);
      if (raw.kind !== 'door' && raw.kind !== 'window') fail('an opening is a door or a window');
      const len = dist(wall.a, wall.b);
      let width = coord(raw.width, 'width');
      if (width <= 0) width = raw.kind === 'door' ? 0.9 : 1.2;
      width = r3(Math.min(Math.max(width, 0.4), 6));
      if (len < width + 2 * OPENING_GAP) fail('that wall is too short for it');
      const want = isNum(raw.offset) && raw.offset >= 0 ? Math.min(raw.offset, len) : len / 2;
      const offset = freeOffset(plan.openings, wall, want, width);
      if (offset === null) fail('there is no free stretch of wall for it');
      const id = ctx.newId();
      plan.openings.push({ id, wallId: wall.id, type: raw.kind as 'door' | 'window', offset: offset!, width });
      ctx.touched.openings.push(id);
      return;
    }
    case 'move_opening': {
      const o = findOpening(plan, ctx, raw.opening);
      const wall = text(raw.wall) ? findWall(plan, ctx, raw.wall) : plan.walls.find((w) => w.id === o.wallId);
      if (!wall) return fail('its wall is gone');
      const len = dist(wall.a, wall.b);
      if (len < o.width + 2 * OPENING_GAP) fail('that wall is too short for it');
      const want = isNum(raw.offset) && raw.offset >= 0 ? Math.min(raw.offset, len) : len / 2;
      const offset = freeOffset(plan.openings, wall, want, o.width, o.id);
      if (offset === null) fail('there is no free stretch of wall for it');
      if (wall.id === o.wallId && Math.abs(offset! - o.offset) < 0.002) fail('it is already there');
      o.wallId = wall.id;
      o.offset = offset!;
      ctx.touched.openings.push(o.id);
      return;
    }
    case 'resize_opening': {
      const o = findOpening(plan, ctx, raw.opening);
      const wall = plan.walls.find((w) => w.id === o.wallId);
      if (!wall) return fail('its wall is gone');
      const len = dist(wall.a, wall.b);
      const width = r3(Math.min(Math.max(coord(raw.width, 'width'), 0.4), len - 2 * OPENING_GAP));
      if (width < 0.4) fail('that wall is too short');
      const offset = r3(clampOffset(wall, o.offset, width));
      if (!openingFits(plan.openings, wall, offset, width, o.id)) fail('it would run into the next opening');
      if (Math.abs(width - o.width) < 0.002) fail('it is already that wide');
      o.width = width;
      o.offset = offset;
      ctx.touched.openings.push(o.id);
      return;
    }
    case 'remove_opening': {
      const o = findOpening(plan, ctx, raw.opening);
      plan.openings = plan.openings.filter((x) => x.id !== o.id);
      return;
    }
    case 'rename_room': {
      const room = findRoom(plan, ctx, raw.room);
      const name = text(raw.name).slice(0, 40);
      if ((plan.roomNames[room.key] ?? '') === name) fail('it is already called that');
      if (name) plan.roomNames[room.key] = name;
      else delete plan.roomNames[room.key];
      return;
    }
    case 'name_room_at': {
      const p = { x: coord(raw.x, 'x'), y: coord(raw.y, 'y') };
      const room = detectRooms(plan.walls).find((r) => pointInPolygon(p, r.polygon));
      if (!room) return fail('no room at that point');
      const name = text(raw.name).slice(0, 40);
      if (name) plan.roomNames[room.key] = name;
      else delete plan.roomNames[room.key];
      return;
    }
    case 'add_furniture': {
      const def = defFor(plan, raw.kind);
      if (!def) return fail(`no furniture kind "${text(raw.kind)}"`);
      const room = text(raw.room) ? findRoom(plan, ctx, raw.room) : null;
      const rotation = degToRad(isNum(raw.rotation_deg) ? raw.rotation_deg : 0);
      let x = coord(raw.x, 'x');
      let y = coord(raw.y, 'y');
      if (room && !pointInPolygon({ x, y }, room.polygon)) {
        // Asked for a room but aimed outside it: start from the middle of the room instead.
        const c = interiorPoint(room.polygon);
        if (dist(c, { x, y }) > 1.5) {
          x = c.x;
          y = c.y;
        }
      }
      const spot = placeFurniture(plan, { kind: raw.kind as string, x, y, rotation, room, reach: 1.5, clearDoors: true });
      if (!spot) return fail(`no free spot for the ${def.label.toLowerCase()} there`);
      const id = ctx.newId();
      plan.furniture.push({ id, kind: raw.kind as FurnitureKind, x: spot.x, y: spot.y, rotation });
      ctx.touched.furniture.push(id);
      return;
    }
    case 'move_furniture': {
      const f = findFurniture(plan, ctx, raw.item);
      const x = coord(raw.x, 'x');
      const y = coord(raw.y, 'y');
      const spot = placeFurniture(plan, { kind: f.kind, x, y, rotation: f.rotation, room: null, ignoreId: f.id, reach: 1.2 });
      if (!spot) return fail('no free spot there');
      if (Math.abs(spot.x - f.x) < 0.002 && Math.abs(spot.y - f.y) < 0.002) fail('it is already there');
      f.x = spot.x;
      f.y = spot.y;
      ctx.touched.furniture.push(f.id);
      return;
    }
    case 'rotate_furniture': {
      const f = findFurniture(plan, ctx, raw.item);
      if (!isNum(raw.rotation_deg)) fail('no angle given');
      const rotation = degToRad(raw.rotation_deg as number);
      if (Math.abs(rotation - degToRad((f.rotation * 180) / Math.PI)) < 0.002) fail('it already faces that way');
      const spot = placeFurniture(plan, { kind: f.kind, x: f.x, y: f.y, rotation, room: null, ignoreId: f.id, reach: 0.6 });
      if (!spot) return fail('it does not fit turned that way');
      f.rotation = rotation;
      f.x = spot.x;
      f.y = spot.y;
      ctx.touched.furniture.push(f.id);
      return;
    }
    case 'remove_furniture': {
      const f = findFurniture(plan, ctx, raw.item);
      plan.furniture = plan.furniture.filter((x) => x.id !== f.id);
      return;
    }
    case 'clear_room': {
      const room = findRoom(plan, ctx, raw.room);
      const n = plan.furniture.length;
      plan.furniture = plan.furniture.filter((f) => !pointInPolygon({ x: f.x, y: f.y }, room.polygon));
      if (plan.furniture.length === n) fail('that room has no furniture');
      return;
    }
    case 'set_wall_height': {
      if (!isNum(raw.height) || raw.height <= 0) fail('no height given');
      const h = r3(Math.min(6, Math.max(2, raw.height as number)));
      if (Math.abs(h - plan.settings.wallHeight) < 0.002) fail('walls are already that high');
      plan.settings.wallHeight = h;
      return;
    }
    default:
      fail(`unknown operation "${text(raw.op) || '?'}"`);
  }
}

/** Structural sanity of a whole plan — the last gate before an edit is committed. */
export function planProblems(plan: PlanData): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const w of plan.walls) {
    if (![w.a.x, w.a.y, w.b.x, w.b.y].every(isNum)) problems.push('a wall has a broken coordinate');
    else if (dist(w.a, w.b) < 0.05) problems.push('a wall has no length');
    if (ids.has(w.id)) problems.push('two walls share an id');
    ids.add(w.id);
  }
  const seen: Opening[] = [];
  for (const o of plan.openings) {
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (!wall) problems.push('an opening has no wall');
    else if (!isNum(o.offset) || !isNum(o.width) || !openingFits(seen, wall, o.offset, o.width)) {
      problems.push('an opening does not fit its wall');
    }
    seen.push(o);
  }
  for (const f of plan.furniture) {
    if (!defFor(plan, f.kind)) problems.push('a piece of furniture has an unknown kind');
    else if (![f.x, f.y, f.rotation].every(isNum)) problems.push('a piece of furniture has a broken position');
  }
  return problems;
}

export interface ApplyOptions {
  newId?: () => string;
}

/**
 * Apply a list of operations to a copy of `plan`. Each operation stands
 * alone: one that cannot be applied is dropped (with a reason) and leaves the
 * plan exactly as the previous operation left it.
 */
export function applyOps(plan: PlanData, ops: unknown, refs: PlanRefs, opts: ApplyOptions = {}): ApplyResult {
  const ctx: Ctx = {
    refs,
    roomKeys: new Map(refs.rooms.map((r) => [r.ref, r.key])),
    lastWallId: null,
    newId: opts.newId ?? (() => crypto.randomUUID()),
    touched: { walls: [], openings: [], furniture: [] },
  };
  let current = copyPlan(plan);
  let applied = 0;
  const dropped: DroppedOp[] = [];
  const cannot: string[] = [];
  const list = Array.isArray(ops) ? ops.slice(0, 200) : [];

  list.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { op?: unknown }).op !== 'string') {
      dropped.push({ index, op: '?', reason: 'not an operation' });
      return;
    }
    const r = raw as Record<string, unknown>;
    const name = r.op as string;
    if (name === 'cannot') {
      const reason = text(r.reason).slice(0, 240);
      if (reason) cannot.push(reason);
      return;
    }
    const attempt = copyPlan(current);
    const saved = {
      roomKeys: new Map(ctx.roomKeys),
      lastWallId: ctx.lastWallId,
      touched: { walls: [...ctx.touched.walls], openings: [...ctx.touched.openings], furniture: [...ctx.touched.furniture] },
    };
    try {
      applyOne(attempt, ctx, r);
      const problems = planProblems(attempt);
      if (problems.length) fail(problems[0]);
      current = attempt;
      applied++;
    } catch (e) {
      ctx.roomKeys = saved.roomKeys;
      ctx.lastWallId = saved.lastWallId;
      ctx.touched = saved.touched;
      dropped.push({ index, op: name, reason: e instanceof OpError ? e.message : 'could not be applied' });
    }
  });

  // Only things that still exist are worth pointing at.
  const touched = {
    walls: [...new Set(ctx.touched.walls)].filter((id) => current.walls.some((w) => w.id === id)),
    openings: [...new Set(ctx.touched.openings)].filter((id) => current.openings.some((o) => o.id === id)),
    furniture: [...new Set(ctx.touched.furniture)].filter((id) => current.furniture.some((f) => f.id === id)),
  };
  return { plan: applied > 0 ? current : plan, applied, dropped, cannot, touched };
}
