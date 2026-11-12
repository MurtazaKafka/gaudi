/**
 * Room labels: where one sits and how much of it fits. A label is a name,
 * then the room's size, then its area; in a small room it gives up the
 * secondary lines first, then shrinks, and only then goes away — it never
 * runs into the room's own walls. Pure: no store, no DOM.
 */
import { distToSegment, pointInPolygon } from '../../geometry';
import type { Point } from '../../types';

export interface LabelText {
  name: string;
  /** "3.5 × 4.2 m" */ dims: string;
  /** "14.7 m²" */ area: string;
}

export type LabelTier = 'full' | 'dims' | 'name' | 'small' | 'tiny' | 'none';

export interface LabelFit {
  tier: LabelTier;
  /** px */ nameSize: number;
  showDims: boolean;
  showArea: boolean;
  /** px the block may be wide; longer names are cut with an ellipsis */ maxWidth: number;
}

/** Width of one character as a share of the font size: tracked caps, and the mono face. */
const NAME_CHAR = 0.71;
const MONO_CHAR = 0.6;
const SUB_SIZE = 10;
const NAME_LINE = 1.25;
const SUB_LINE = 13;
/** px kept clear of the wall faces, each way */
const PAD_X = 10;
const PAD_Y = 6;
/** m: a block that fills the room exactly is measured just inside the wall centerlines, not on them */
const ON_LINE = 1e-6;

const NONE: LabelFit = { tier: 'none', nameSize: 9, showDims: false, showArea: false, maxWidth: 0 };

/** Distance from `p` to the polygon's nearest edge. */
function clearance(p: Point, polygon: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    best = Math.min(best, distToSegment(p, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return best;
}

/**
 * A label is a wide block, so "roomy" is measured with one: `blockRoom` is the
 * half height (m) of the largest BLOCK_ASPECT : 1 box centered on `p` that
 * stays inside the polygon — the distance to the nearest edge in a metric
 * where width counts for 1 / BLOCK_ASPECT.
 */
const BLOCK_ASPECT = 3;

function blockRoom(p: Point, polygon: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const ax = (a.x - p.x) / BLOCK_ASPECT;
    const ay = a.y - p.y;
    const dx = (b.x - p.x) / BLOCK_ASPECT - ax;
    const dy = b.y - p.y - ay;
    // max(|x|, |y|) is convex along the edge: its least value is at an end, or
    // where the edge crosses an axis or a diagonal.
    let d = Math.min(Math.max(Math.abs(ax), Math.abs(ay)), Math.max(Math.abs(ax + dx), Math.abs(ay + dy)));
    d = leastAlong(d, ax, ay, dx, dy, -ax, dx);
    d = leastAlong(d, ax, ay, dx, dy, -ay, dy);
    d = leastAlong(d, ax, ay, dx, dy, ay - ax, dx - dy);
    d = leastAlong(d, ax, ay, dx, dy, -ax - ay, dx + dy);
    best = Math.min(best, d);
  }
  return best;
}

/** `d`, or max(|x|, |y|) at the point t = num / den of the edge (ax, ay) + t·(dx, dy) if that is on the edge and less. */
function leastAlong(d: number, ax: number, ay: number, dx: number, dy: number, num: number, den: number): number {
  if (Math.abs(den) < 1e-12) return d;
  const t = num / den;
  return t > 0 && t < 1 ? Math.min(d, Math.max(Math.abs(ax + dx * t), Math.abs(ay + dy * t))) : d;
}

const anchorCache = new WeakMap<Point[], Point>();

/**
 * Where a room's label goes: its centroid when a label has about as much room
 * there as anywhere, otherwise the roomiest spot for a block of text — the
 * middle of an L-shaped room's larger arm, not its elbow, a corner of it, or
 * outside it. Among equally roomy spots the one furthest from the walls wins,
 * then the one nearest the centroid.
 */
export function labelAnchor(polygon: Point[], centroid: Point): Point {
  const hit = anchorCache.get(polygon);
  if (hit) return hit;
  let anchor = centroid;
  if (polygon.length >= 3) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of polygon) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const N = 12;
    const stepX = (maxX - minX) / N;
    const stepY = (maxY - minY) / N;
    type Spot = { p: Point; room: number; clear: number };
    let spots: Spot[] = [];
    let most = 0;
    for (let i = 1; i < N; i++) {
      for (let j = 1; j < N; j++) {
        const p = { x: minX + stepX * i, y: minY + stepY * j };
        if (!pointInPolygon(p, polygon)) continue;
        const room = blockRoom(p, polygon);
        most = Math.max(most, room);
        spots.push({ p, room, clear: 0 });
      }
    }
    if (spots.length > 0) {
      // Ties are the rule, not the exception (every point along the middle of an
      // arm is as roomy as the next), so they are settled on purpose.
      const SAME = 0.99;
      spots = spots.filter((s) => s.room >= most * SAME);
      most = 0;
      for (const s of spots) {
        s.clear = clearance(s.p, polygon);
        most = Math.max(most, s.clear);
      }
      spots = spots.filter((s) => s.clear >= most * SAME);
      let best = spots[0];
      for (const s of spots) {
        if (Math.hypot(s.p.x - centroid.x, s.p.y - centroid.y) < Math.hypot(best.p.x - centroid.x, best.p.y - centroid.y)) best = s;
      }
      // The grid rarely lands on the middle of an arm: settle onto it.
      for (let k = 0, dx = stepX / 2, dy = stepY / 2; k < 8; k++, dx /= 2, dy /= 2) {
        for (const [mx, my] of [[dx, 0], [-dx, 0], [0, dy], [0, -dy]]) {
          const p = { x: best.p.x + mx, y: best.p.y + my };
          if (!pointInPolygon(p, polygon)) continue;
          const s = { p, room: blockRoom(p, polygon), clear: clearance(p, polygon) };
          const roomier = s.room > best.room * 1.001;
          const asRoomy = s.room >= best.room * 0.999;
          if (roomier || (asRoomy && s.clear > best.clear * 1.001)) best = s;
        }
      }
      const own = pointInPolygon(centroid, polygon) ? blockRoom(centroid, polygon) : -1;
      if (own < best.room * 0.85) anchor = best.p;
    }
  }
  anchorCache.set(polygon, anchor);
  return anchor;
}

/** The stretch of the line `axis = value` that is inside the polygon and contains `at`, as [lo, hi]; null if `at` is outside there. */
function span(polygon: Point[], horizontal: boolean, value: number, at: number): [number, number] | null {
  const hits: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const a1 = horizontal ? a.y : a.x;
    const b1 = horizontal ? b.y : b.x;
    if (a1 > value === b1 > value) continue;
    const a2 = horizontal ? a.x : a.y;
    const b2 = horizontal ? b.x : b.y;
    hits.push(a2 + ((value - a1) / (b1 - a1)) * (b2 - a2));
  }
  hits.sort((p, q) => p - q);
  for (let i = 0; i + 1 < hits.length; i += 2) {
    if (hits[i] <= at && at <= hits[i + 1]) return [hits[i], hits[i + 1]];
  }
  return null;
}

/**
 * Room available to a block centered on `at`: how wide it may be (m) if it is
 * `2·halfOther` tall (horizontal = true), or how tall if it is that wide.
 * Measured to the wall centerlines.
 */
export function clearExtent(polygon: Point[], at: Point, horizontal: boolean, halfOther: number): number {
  const across = horizontal ? at.y : at.x;
  const along = horizontal ? at.x : at.y;
  let lo = -Infinity;
  let hi = Infinity;
  for (const v of [across - halfOther, across, across + halfOther]) {
    const s = span(polygon, horizontal, v, along);
    if (!s) return 0;
    lo = Math.max(lo, s[0]);
    hi = Math.min(hi, s[1]);
  }
  return Math.max(0, 2 * Math.min(along - lo, hi - along));
}

/** Estimated width of the name at `size` px (tracked capitals). */
export const nameWidth = (name: string, size: number): number => name.length * size * NAME_CHAR;
const subWidth = (text: string): number => text.length * SUB_SIZE * MONO_CHAR;

/**
 * How much of a label fits in a room at this zoom. `scale` is px per meter,
 * `thickness` the wall thickness in meters (the label keeps off the wall
 * faces, not the centerlines).
 */
export function fitRoomLabel(
  polygon: Point[],
  at: Point,
  scale: number,
  thickness: number,
  text: LabelText,
): LabelFit {
  if (!(scale > 0) || polygon.length < 3) return NONE;
  const wallPx = Math.max(thickness * scale, 2);
  /**
   * px free for a block w × h centered on the anchor. Measured along the edges
   * of the block with its margins on, so a wall that turns a corner beside the
   * label (the elbow of an L) is kept off as well as the walls facing it.
   */
  const room = (w: number, h: number) => ({
    w: clearExtent(polygon, at, true, (h + wallPx + PAD_Y) / 2 / scale - ON_LINE) * scale - wallPx - PAD_X,
    h: clearExtent(polygon, at, false, (w + wallPx + PAD_X) / 2 / scale - ON_LINE) * scale - wallPx - PAD_Y,
  });
  const tiers: { tier: LabelTier; size: number; dims: boolean; area: boolean }[] = [
    { tier: 'full', size: 12, dims: true, area: true },
    { tier: 'dims', size: 12, dims: true, area: false },
    { tier: 'name', size: 12, dims: false, area: false },
    { tier: 'small', size: 10.5, dims: false, area: false },
    { tier: 'small', size: 9, dims: false, area: false },
  ];
  for (const t of tiers) {
    const w = Math.max(nameWidth(text.name, t.size), t.dims ? subWidth(text.dims) : 0, t.area ? subWidth(text.area) : 0);
    const h = t.size * NAME_LINE + (t.dims ? SUB_LINE : 0) + (t.area ? SUB_LINE : 0);
    const free = room(w, h);
    if (w <= free.w && h <= free.h) {
      return { tier: t.tier, nameSize: t.size, showDims: t.dims, showArea: t.area, maxWidth: Math.floor(free.w) };
    }
  }
  // Last resort: the name at its smallest, cut short to what the room allows.
  const h = 9 * NAME_LINE;
  const w = room(0, h).w;
  if (w >= 24 && room(Math.min(w, nameWidth(text.name, 9)), h).h >= h) {
    return { tier: 'tiny', nameSize: 9, showDims: false, showArea: false, maxWidth: Math.floor(w) };
  }
  return NONE;
}

// ---------- labels on doors and windows ----------

/** An upright box in plan meters: its center and half its width and height. */
export interface LabelBox {
  x: number;
  y: number;
  hw: number;
  hh: number;
}

/** px of air a label keeps around itself */
const BOX_PAD = 3;
/** The opening label's face: 13 px mono (see OpeningShape). */
export const OPENING_LABEL_SIZE = 13;
/** px between an opening's label and what it stands clear of (wall face, door swing, entrance marker) */
const OPENING_LABEL_GAP = 5;

/** The box a room's label fills at this zoom, for other labels to keep out of; null when it shows nothing. */
export function roomLabelBox(at: Point, fit: LabelFit, text: LabelText, scale: number): LabelBox | null {
  if (fit.tier === 'none' || !(scale > 0)) return null;
  const w = Math.min(
    Math.max(nameWidth(text.name, fit.nameSize), fit.showDims ? subWidth(text.dims) : 0, fit.showArea ? subWidth(text.area) : 0),
    Math.max(fit.maxWidth, 0),
  );
  const h = fit.nameSize * NAME_LINE + (fit.showDims ? SUB_LINE : 0) + (fit.showArea ? SUB_LINE : 0);
  return { x: at.x, y: at.y, hw: (w / 2 + BOX_PAD) / scale, hh: (h / 2 + BOX_PAD) / scale };
}

const boxesOverlap = (a: LabelBox, b: LabelBox): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh;

export interface OpeningLabelSpec {
  text: string;
  /** On the wall's centerline. */
  center: Point;
  /** Unit vector along the wall, A → B. */
  dir: Point;
  /** m */ width: number;
  /** A door has a leaf, drawn swinging to the side `dir` turns to anticlockwise on screen. */
  door: boolean;
  /** The entrance marker outside this door, if it carries one: its tip and its length (m). */
  marker?: { at: Point; size: number } | null;
}

/**
 * Where the label of a door or window is centered, or null when there is
 * nowhere good for it at this zoom. On an outside wall it stands outside the
 * house — past the door's swing and the entrance marker if they are on that
 * side — never in the room; on an inside wall it takes the side the door does
 * not swing into, or failing that the far side of the swing. It is never put
 * on top of a room's label (`avoid`).
 */
export function openingLabelSpot(
  o: OpeningLabelSpec,
  ctx: { /** px per m */ scale: number; /** wall thickness, m */ thickness: number; rooms: Point[][]; avoid: LabelBox[] },
): Point | null {
  const { scale } = ctx;
  if (!o.text || !(scale > 0)) return null;
  const hw = (o.text.length * OPENING_LABEL_SIZE * MONO_CHAR) / 2 / scale;
  const hh = OPENING_LABEL_SIZE / 2 / scale;
  const face = Math.max(Math.max(0, ctx.thickness) / 2, 1 / scale);
  // The side the leaf swings to.
  const n = { x: o.dir.y, y: -o.dir.x };
  const roomAt = (side: number): boolean => {
    const p = { x: o.center.x + n.x * side * (face + 0.15), y: o.center.y + n.y * side * (face + 0.15) };
    return ctx.rooms.some((r) => pointInPolygon(p, r));
  };
  /** The first clear place on one side, trying up to `lines` positions each a line of text further from the wall. */
  const spot = (side: number, lines = 1): Point | null => {
    let reach = face + (o.door && side === 1 ? o.width : 0);
    if (o.marker) {
      const along = (o.marker.at.x - o.center.x) * n.x * side + (o.marker.at.y - o.center.y) * n.y * side;
      if (along > 0) reach = Math.max(reach, along + o.marker.size);
    }
    // The label stays upright, so how far its box reaches toward the wall depends on which way the wall runs.
    const near = reach + OPENING_LABEL_GAP / scale + Math.abs(n.x) * hw + Math.abs(n.y) * hh;
    for (let k = 0; k < lines; k++) {
      const t = near + (k * (OPENING_LABEL_SIZE + OPENING_LABEL_GAP)) / scale;
      const p = { x: o.center.x + n.x * side * t, y: o.center.y + n.y * side * t };
      const box = { x: p.x, y: p.y, hw: hw + BOX_PAD / scale, hh: hh + BOX_PAD / scale };
      if (!ctx.avoid.some((b) => boxesOverlap(box, b))) return p;
    }
    return null;
  };
  const swingSide = roomAt(1);
  const otherSide = roomAt(-1);
  // An outside wall: the outside or nothing. A door set back between two wings has their labels
  // beside it, so there the label may stand a little further out.
  if (swingSide !== otherSide) return spot(swingSide ? -1 : 1, 4);
  return o.door ? (spot(-1) ?? spot(1)) : (spot(1) ?? spot(-1));
}
