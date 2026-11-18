/**
 * Things are solid. Furniture takes up space and so do walls, so a piece
 * being moved stops against them instead of passing into them. Rule-based
 * and still — no physics, nothing tumbles or slides on by itself: this only
 * decides where the piece in hand may stand. Pure: no store, no three.js.
 *
 * What takes up space. Each part of an item's model is a block: its outline
 * seen from above (a rectangle, or an octagon round a round part) and the
 * heights it spans, standing at the height the item rests at (stacking.ts).
 * Two items collide when a block of one overlaps a block of the other from
 * above and their heights overlap by more than 2 cm; touching is not
 * colliding. So a chair slides under a table until its back meets the table
 * top, a plate on the table sits on it rather than in it, and two sofas
 * cannot share a spot. Walls are solid for their whole height wherever there
 * is wall (under a window's sill and over a door's head too: the same wall
 * pieces the 3D model is built from); a doorway is a way through. Anything
 * under 3 cm (a rug, a plate) collides with nothing.
 *
 * Only the piece in hand is ever held back: nothing already in the plan is
 * moved or flagged, however it overlaps.
 */
import { buildWallModel } from './build';
import type { FurnitureDef } from './catalog';
import { FLAT, groundFor, partBoxes, restHere, type DefOf, type Ground, type PartBox } from './stacking';
import type { Furniture, PlanData } from './types';

/** Heights must overlap by more than this to collide, m. */
const HEIGHT_SLACK = 0.02;
/** Outlines must overlap by more than this to collide (flush is fine), m. */
const TOUCH = 0.002;
/** How far the piece is pushed past flush when it is pushed out of something, m. */
const CLEAR = 0.0005;
/** Overlapping by more than this to begin with, a piece is stuck in something and free to leave it any way, m. */
const STUCK = 0.005;
/** How far from where it was asked to go a piece may be put instead, m. */
export const REACH = 0.6;

/** A block seen from above: a convex outline, the directions it can be told apart along, and its heights. */
interface Block {
  /** Outline corners, flat x, y pairs. */
  pts: number[];
  /** Unit normals of its edges, flat pairs (a centrally symmetric outline needs only half). */
  axes: number[];
  /** A circle round it, for "too far apart to touch". */
  cx: number;
  cy: number;
  r: number;
  y0: number;
  y1: number;
}

/** Something in the way: an item or a piece of wall, with a circle round all its blocks. */
interface Lump {
  cx: number;
  cy: number;
  r: number;
  blocks: Block[];
}

export interface World {
  ground: Ground;
  lumps: Lump[];
}

const OCTAGON = Array.from({ length: 8 }, (_, i) => Math.PI / 8 + (i * Math.PI) / 4);
const OCTAGON_OUT = 1 / Math.cos(Math.PI / 8);

/** Close a block: its circle and the normals of the first `axesFrom` edges. */
function finish(pts: number[], y0: number, y1: number, axesFrom: number): Block {
  const n = pts.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[2 * i] / n;
    cy += pts[2 * i + 1] / n;
  }
  let r = 0;
  for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(pts[2 * i] - cx, pts[2 * i + 1] - cy));
  const axes: number[] = [];
  for (let i = 0; i < axesFrom; i++) {
    const j = (i + 1) % n;
    const ex = pts[2 * j] - pts[2 * i];
    const ey = pts[2 * j + 1] - pts[2 * i + 1];
    const len = Math.hypot(ex, ey);
    if (len > 1e-9) axes.push(ey / len, -ex / len);
  }
  return { pts, axes, cx, cy, r, y0, y1 };
}

/** One part of an item standing at pose `f`, `lift` up, as a block on the plan. */
function partBlock(f: Pick<Furniture, 'x' | 'y' | 'rotation'>, b: PartBox, lift: number): Block | null {
  const c = Math.cos(f.rotation);
  const s = Math.sin(f.rotation);
  const cx = f.x + b.x * c - b.z * s;
  const cy = f.y + b.x * s + b.z * c;
  const a = f.rotation + b.a;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const pts: number[] = [];
  const corner = (u: number, v: number) => pts.push(cx + u * ca - v * sa, cy + u * sa + v * ca);
  if (b.round) for (const t of OCTAGON) corner(Math.cos(t) * b.hx * OCTAGON_OUT, Math.sin(t) * b.hz * OCTAGON_OUT);
  else for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) corner(u * b.hx, v * b.hz);
  if (!pts.every(Number.isFinite)) return null;
  return finish(pts, lift + b.y0, lift + b.y1, pts.length / 4);
}

/** Every block of an item: none for a rug or a plate. */
function itemBlocks(f: Furniture, def: FurnitureDef, lift: number): Block[] {
  if (!(def.h >= FLAT) || ![f.x, f.y, f.rotation, lift].every(Number.isFinite)) return [];
  const out: Block[] = [];
  for (const b of partBoxes(def)) {
    const block = partBlock(f, b, lift);
    if (block) out.push(block);
  }
  return out;
}

function lumpOf(blocks: Block[]): Lump | null {
  if (blocks.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of blocks) {
    x0 = Math.min(x0, b.cx - b.r);
    y0 = Math.min(y0, b.cy - b.r);
    x1 = Math.max(x1, b.cx + b.r);
    y1 = Math.max(y1, b.cy + b.r);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let r = 0;
  for (const b of blocks) r = Math.max(r, Math.hypot(b.cx - cx, b.cy - cy) + b.r);
  return { cx, cy, r, blocks };
}

export type SolidPlan = Pick<PlanData, 'furniture' | 'walls' | 'openings' | 'settings'>;

/**
 * Everything that stays put while `moving` (and whatever rides on it) is
 * moved: the other items, standing at their heights, and the walls.
 */
export function worldFor(plan: SolidPlan, defOf: DefOf, moving: ReadonlySet<string>): World {
  const ground = groundFor(plan.furniture, defOf, moving);
  const lumps: Lump[] = [];
  for (const body of ground.bodies) {
    const lump = lumpOf(itemBlocks(body.f, body.def, body.rest.lift));
    if (lump) lumps.push(lump);
  }
  try {
    for (const piece of buildWallModel(plan.walls, plan.openings, plan.settings).pieces) {
      const pts = piece.poly.flatMap((p) => [p.x, p.y]);
      if (pts.length < 6 || !pts.every(Number.isFinite)) continue;
      const lump = lumpOf([finish(pts, piece.y0, piece.y1, pts.length / 2)]);
      if (lump) lumps.push(lump);
    }
  } catch {
    // No walls to stop against.
  }
  return { ground, lumps };
}

let cached: { keys: unknown[]; world: World } | null = null;

/** `worldFor`, kept while the plan and `moving` stay the same (a placement ghost asks on every pointer move). */
export function cachedWorldFor(plan: SolidPlan & Pick<PlanData, 'customItems'>, defOf: DefOf, moving: readonly string[] = []): World {
  const keys = [plan.furniture, plan.walls, plan.openings, plan.settings, plan.customItems, defOf, moving.join('\n')];
  if (cached && cached.keys.every((k, i) => k === keys[i])) return cached.world;
  const world = worldFor(plan, defOf, new Set(moving));
  cached = { keys, world };
  return world;
}

// ---------- the piece in hand ----------

interface HandPiece {
  f: Furniture;
  def: FurnitureDef;
  /** Its blocks at its own pose, standing on the floor (the height is added where it is tried). */
  blocks: Block[];
  cx: number;
  cy: number;
  r: number;
}

/** What is being moved and has to fit: the pieces themselves (whatever rides on them is not checked). */
export interface Hand {
  pieces: HandPiece[];
}

export function handOf(pieces: { f: Furniture; def: FurnitureDef }[]): Hand {
  const out: HandPiece[] = [];
  for (const { f, def } of pieces) {
    const blocks = itemBlocks(f, def, 0);
    const lump = lumpOf(blocks);
    if (lump) out.push({ f, def, blocks, cx: lump.cx, cy: lump.cy, r: lump.r });
  }
  return { pieces: out };
}

/** A way out of an overlap: push the hand `depth` metres along (nx, ny). */
interface Push {
  depth: number;
  nx: number;
  ny: number;
}

/**
 * Do `a` (shifted by dx, dy) and `b` overlap from above by more than a touch
 * (and `slack` more)? When they do and `push` is given, it is set to the
 * shortest way out for `a`.
 */
function overlaps(a: Block, dx: number, dy: number, b: Block, push: Push | null, slack: number): boolean {
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (const axes of [a.axes, b.axes]) {
    for (let k = 0; k < axes.length; k += 2) {
      const ux = axes[k];
      const uy = axes[k + 1];
      let amin = Infinity;
      let amax = -Infinity;
      for (let i = 0; i < a.pts.length; i += 2) {
        const d = a.pts[i] * ux + a.pts[i + 1] * uy;
        if (d < amin) amin = d;
        if (d > amax) amax = d;
      }
      const shift = dx * ux + dy * uy;
      amin += shift;
      amax += shift;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (let i = 0; i < b.pts.length; i += 2) {
        const d = b.pts[i] * ux + b.pts[i + 1] * uy;
        if (d < bmin) bmin = d;
        if (d > bmax) bmax = d;
      }
      const o = Math.min(amax - bmin, bmax - amin);
      if (o <= TOUCH + slack) return false;
      if (o < best) {
        best = o;
        const away = amin + amax > bmin + bmax ? 1 : -1;
        bx = ux * away;
        by = uy * away;
      }
    }
  }
  if (push) {
    push.depth = best;
    push.nx = bx;
    push.ny = by;
  }
  return true;
}

/**
 * The overlaps of the hand moved by (dx, dy): each piece standing at
 * whatever height it would rest at there. With `deepest`, the deepest one's
 * way out is written into it; without, the first overlap is enough.
 */
function contact(world: World, hand: Hand, dx: number, dy: number, deepest: Push | null, slack = 0): boolean {
  let hit = false;
  const push: Push = { depth: 0, nx: 0, ny: 0 };
  if (deepest) deepest.depth = 0;
  for (const p of hand.pieces) {
    const lift = restHere(world.ground, { ...p.f, x: p.f.x + dx, y: p.f.y + dy }).lift;
    const pcx = p.cx + dx;
    const pcy = p.cy + dy;
    for (const lump of world.lumps) {
      const gap = p.r + lump.r + TOUCH;
      if (Math.abs(lump.cx - pcx) > gap || Math.abs(lump.cy - pcy) > gap) continue;
      for (const a of p.blocks) {
        const ay0 = a.y0 + lift;
        const ay1 = a.y1 + lift;
        for (const b of lump.blocks) {
          if (Math.min(ay1, b.y1) - Math.max(ay0, b.y0) <= HEIGHT_SLACK) continue;
          if (Math.hypot(b.cx - a.cx - dx, b.cy - a.cy - dy) > a.r + b.r + TOUCH) continue;
          if (!overlaps(a, dx, dy, b, deepest ? push : null, slack)) continue;
          if (!deepest) return true;
          hit = true;
          if (push.depth > deepest.depth) Object.assign(deepest, push);
        }
      }
    }
  }
  return hit;
}

/** Does the hand fit, moved by (dx, dy)? `slack` forgives that much more overlap. */
export function fitsAt(world: World, hand: Hand, dx: number, dy: number, slack = 0): boolean {
  return !contact(world, hand, dx, dy, null, slack);
}

export interface Spot {
  dx: number;
  dy: number;
  /** False when nothing near fits: (dx, dy) is then just where it was asked to go. */
  fits: boolean;
}

/**
 * The nearest place to (dx, dy) where the hand fits, within `reach`: pushed
 * out of whatever it is in by the shortest way, so against a wall or another
 * piece it slides along the face like a real thing pushed there; failing
 * that, the closest clear spot round about, preferring the side of `from`
 * (where it last fitted). Nothing near: `fits` is false.
 */
export function nearestFit(world: World, hand: Hand, dx: number, dy: number, opts: { reach?: number; from?: { dx: number; dy: number } } = {}): Spot {
  const reach = opts.reach ?? REACH;
  if (fitsAt(world, hand, dx, dy)) return { dx, dy, fits: true };
  // Out the shortest way, the deepest overlap first.
  const push: Push = { depth: 0, nx: 0, ny: 0 };
  let x = dx;
  let y = dy;
  for (let i = 0; i < 12; i++) {
    if (!contact(world, hand, x, y, push)) {
      if (Math.hypot(x - dx, y - dy) <= reach) return { dx: x, dy: y, fits: true };
      break;
    }
    x += push.nx * (push.depth + CLEAR);
    y += push.ny * (push.depth + CLEAR);
    if (Math.hypot(x - dx, y - dy) > reach) break;
  }
  // Round about, nearest ring first; on a ring, nearest to where it last fitted.
  const from = opts.from;
  for (let r = 0.05; r <= reach + 1e-9; r += 0.05) {
    const n = Math.min(32, Math.max(8, Math.round((Math.PI * 2 * r) / 0.06)));
    let best: Spot | null = null;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const t = (k / n) * Math.PI * 2;
      const cx = dx + Math.cos(t) * r;
      const cy = dy + Math.sin(t) * r;
      const d = from ? Math.hypot(cx - from.dx, cy - from.dy) : k;
      if (d >= bestD || !fitsAt(world, hand, cx, cy)) continue;
      best = { dx: cx, dy: cy, fits: true };
      bestD = d;
    }
    if (best) return best;
  }
  return { dx, dy, fits: false };
}

/**
 * How far the hand gets toward (dx, dy) in a straight line before it meets
 * something (a nudge stops at an obstacle rather than passing into it), and
 * stops just short of it. A hand already well into something is not held
 * back: it can always be moved out. One resting a hair too deep (rounding)
 * still slides along what it touches.
 */
export function sweepFit(world: World, hand: Hand, dx: number, dy: number): { dx: number; dy: number } {
  const start: Push = { depth: 0, nx: 0, ny: 0 };
  const already = contact(world, hand, 0, 0, start) ? start.depth : 0;
  if (already > STUCK) return { dx, dy };
  const slack = already > 0 ? already - TOUCH + CLEAR : 0;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / 0.02));
  let good = 0;
  let bad = -1;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (fitsAt(world, hand, dx * t, dy * t, slack)) good = t;
    else {
      bad = t;
      break;
    }
  }
  if (bad < 0) return { dx, dy };
  for (let i = 0; i < 12; i++) {
    const t = (good + bad) / 2;
    if (fitsAt(world, hand, dx * t, dy * t, slack)) good = t;
    else bad = t;
  }
  // Back off the touch allowance, so it comes to rest flush rather than a hair inside.
  const k = len > 0 ? Math.max(0, good - (TOUCH + CLEAR) / len) : 0;
  return { dx: dx * k, dy: dy * k };
}
