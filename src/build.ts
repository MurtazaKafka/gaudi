/**
 * Plan → solid pieces. Pure geometry (no three.js, no store): the 3D scene,
 * the GLB exporter and walk-mode collision all read the same description.
 *
 * Openings never use CSG: each wall splits into side pieces, lintels and
 * sills. Wall ends are mitred against their neighbours so corners close.
 */
import type { Opening, OpeningType, PlanSettings, Point, Wall } from './types';
import { pointInPolygon, wallAngle, wallLength } from './geometry';

/** Top of a door opening above the floor (m), where the wall is tall enough. */
export const DOOR_HEAD = 2.1;
/** Bottom of a window opening above the floor (m). */
export const WINDOW_SILL = 0.9;
/** Top of a window opening above the floor (m). */
export const WINDOW_HEAD = 2.1;
/** Wall always left above an opening (m). */
const HEAD_CLEARANCE = 0.15;
const MIN_PIECE = 0.01;
/** A mitre never reaches further than this many half-thicknesses past the joint. */
const MITRE_LIMIT = 4;

/** Vertical extent of an opening for a given wall height. */
export function openingHeights(type: OpeningType, wallHeight: number): { y0: number; y1: number } {
  const H = Math.max(0.2, wallHeight);
  const head = Math.max(0.1, Math.min(type === 'door' ? DOOR_HEAD : WINDOW_HEAD, H - HEAD_CLEARANCE));
  if (type === 'door') return { y0: 0, y1: head };
  return { y0: Math.max(0, Math.min(WINDOW_SILL, head - 0.3)), y1: head };
}

/** One axis-aligned box in a wall's local frame (square ends — see `buildWallModel` for mitred pieces). */
export interface WallBox {
  key: string;
  /** world center */ x: number;
  y: number;
  z: number;
  /** along the wall */ length: number;
  height: number;
  thickness: number;
  rotY: number;
}

/** A span of wall: [start, end] along the segment, [y0, y1] vertically. */
interface Span {
  start: number;
  end: number;
  y0: number;
  y1: number;
}

/** An opening as actually cut into its wall (clamped to the wall and its neighbours). */
interface Cut {
  opening: Opening;
  left: number;
  right: number;
  y0: number;
  y1: number;
}

function wallCuts(wall: Wall, openings: Opening[], len: number, settings: PlanSettings): Cut[] {
  const mine = openings
    .filter((o) => o.wallId === wall.id && Number.isFinite(o.offset) && Number.isFinite(o.width))
    .sort((a, b) => a.offset - b.offset);
  const cuts: Cut[] = [];
  let cursor = 0;
  for (const o of mine) {
    const half = o.width / 2;
    const left = Math.max(cursor, o.offset - half);
    const right = Math.min(len, o.offset + half);
    if (right - left < MIN_PIECE) continue;
    cuts.push({ opening: o, left, right, ...openingHeights(o.type, settings.wallHeight) });
    cursor = right;
  }
  return cuts;
}

function spansFromCuts(cuts: Cut[], len: number, H: number): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.left - cursor > MIN_PIECE) spans.push({ start: cursor, end: c.left, y0: 0, y1: H });
    if (c.y0 > MIN_PIECE) spans.push({ start: c.left, end: c.right, y0: 0, y1: c.y0 });
    if (H - c.y1 > MIN_PIECE) spans.push({ start: c.left, end: c.right, y0: c.y1, y1: H });
    cursor = c.right;
  }
  if (len - cursor > MIN_PIECE) spans.push({ start: cursor, end: len, y0: 0, y1: H });
  return spans;
}

/** Walls (+ openings) as plain boxes. Kept for callers that want simple blocks. */
export function buildWallBoxes(walls: Wall[], openings: Opening[], settings: PlanSettings): WallBox[] {
  const boxes: WallBox[] = [];
  for (const wall of walls) {
    const len = wallLength(wall);
    if (!(len >= MIN_PIECE)) continue;
    const angle = wallAngle(wall);
    const dx = (wall.b.x - wall.a.x) / len;
    const dy = (wall.b.y - wall.a.y) / len;
    const spans = spansFromCuts(wallCuts(wall, openings, len, settings), len, settings.wallHeight);
    spans.forEach((s, i) => {
      const mid = (s.start + s.end) / 2;
      boxes.push({
        key: `${wall.id}:${i}`,
        x: wall.a.x + dx * mid,
        y: (s.y0 + s.y1) / 2,
        z: wall.a.y + dy * mid,
        length: s.end - s.start,
        height: s.y1 - s.y0,
        thickness: settings.wallThickness,
        rotY: -angle,
      });
    });
  }
  return boxes;
}

// ---------- mitred wall pieces ----------

/**
 * A wall piece as a vertical prism. `poly` is its plan footprint (convex).
 * `sides[i]` says what the edge from poly[i] to poly[i+1] is:
 *  'p' / 'm' — the wall's two long faces (+normal / −normal side),
 *  'cap'     — an end (a free end, a door jamb, or a mitre hidden in a joint).
 */
export interface WallPiece {
  key: string;
  wallId: string;
  poly: Point[];
  sides: ('p' | 'm' | 'cap')[];
  y0: number;
  y1: number;
  /** The +normal long face looks outdoors (gets cladding). */
  pOuter: boolean;
  /** The −normal long face looks outdoors. */
  mOuter: boolean;
}

/** A door or window as cut, positioned for the frame/leaf/glass builders. */
export interface PlacedOpening {
  id: string;
  wallId: string;
  type: OpeningType;
  /** Center on the wall's axis, plan meters. */
  x: number;
  y: number;
  /** Wall direction in plan radians (A → B). */
  angle: number;
  /** Clear width as cut (m). */
  width: number;
  y0: number;
  y1: number;
  thickness: number;
  label?: string;
}

export interface WallModel {
  pieces: WallPiece[];
  openings: PlacedOpening[];
}

const NODE_GRID = 1e-3;
const nodeKey = (p: Point): string => `${Math.round(p.x / NODE_GRID)},${Math.round(p.y / NODE_GRID)}`;

interface Arm {
  wallId: string;
  /** direction away from the joint, radians */ angle: number;
}

/**
 * How far along the wall (from the joint, into the wall) each long edge's
 * corner sits: positive = pulled back, negative = pushed past the joint.
 * `left` is the edge on the +90° side of the direction pointing away from the joint.
 */
function joinAt(arms: Arm[], wallId: string, h: number): { left: number; right: number; joined: boolean } {
  const me = arms.find((a) => a.wallId === wallId);
  if (!me || arms.length < 2) return { left: 0, right: 0, joined: false };
  const TWO_PI = Math.PI * 2;
  let ccw = Infinity;
  let cw = Infinity;
  for (const a of arms) {
    if (a === me) continue;
    let d = (a.angle - me.angle) % TWO_PI;
    if (d < 0) d += TWO_PI;
    if (d < 0.02 || d > TWO_PI - 0.02) continue; // lying on top of this wall — ignore
    ccw = Math.min(ccw, d);
    cw = Math.min(cw, TWO_PI - d);
  }
  if (!Number.isFinite(ccw)) return { left: 0, right: 0, joined: false };
  const corner = (gap: number): number => {
    const t = Math.tan(gap / 2);
    if (Math.abs(t) < 1e-6) return 0;
    const s = h / t;
    return Math.max(-MITRE_LIMIT * h, Math.min(MITRE_LIMIT * h, s));
  };
  return { left: corner(ccw), right: corner(cw), joined: true };
}

/**
 * For a wall end at `end` that lands on the interior of another wall: how far
 * each long edge (p = +normal side, m = −normal side) must pull back along
 * `away` (the unit direction from the joint into this wall) to sit flush on
 * the other wall's near face. Null when the end isn't a T-junction.
 */
function teeTrim(
  walls: Wall[],
  wall: Wall,
  end: Point,
  awayX: number,
  awayY: number,
  nx: number,
  ny: number,
  h: number,
): { p: number; m: number } | null {
  for (const other of walls) {
    if (other.id === wall.id) continue;
    const olen = wallLength(other);
    const ux = (other.b.x - other.a.x) / olen;
    const uy = (other.b.y - other.a.y) / olen;
    const t = (end.x - other.a.x) * ux + (end.y - other.a.y) * uy;
    if (t <= 0.02 || t >= olen - 0.02) continue;
    const vx = -uy;
    const vy = ux;
    if (Math.abs((end.x - other.a.x) * vx + (end.y - other.a.y) * vy) > 0.01) continue;
    const dv = awayX * vx + awayY * vy;
    if (Math.abs(dv) < 0.25) continue; // nearly parallel — leave the end square
    const face = Math.sign(dv) * h;
    const nv = nx * vx + ny * vy;
    const limit = MITRE_LIMIT * h;
    const at = (off: number): number => Math.max(0, Math.min(limit, (face - off * nv) / dv));
    return { p: at(h), m: at(-h) };
  }
  return null;
}

/**
 * Walls + openings as mitred prisms, plus each opening's placement. `rooms`
 * (detected room polygons) decide which faces count as exterior; without any
 * rooms every face is interior.
 */
export function buildWallModel(
  walls: Wall[],
  openings: Opening[],
  settings: PlanSettings,
  rooms: { polygon: Point[] }[] = [],
): WallModel {
  const H = settings.wallHeight;
  const h = settings.wallThickness / 2;
  const pieces: WallPiece[] = [];
  const placed: PlacedOpening[] = [];

  const usable = walls.filter(
    (w) =>
      Number.isFinite(w.a.x) && Number.isFinite(w.a.y) && Number.isFinite(w.b.x) && Number.isFinite(w.b.y) &&
      wallLength(w) >= MIN_PIECE,
  );

  // Which walls meet at each endpoint.
  const nodes = new Map<string, Arm[]>();
  const addArm = (p: Point, arm: Arm) => {
    const k = nodeKey(p);
    const list = nodes.get(k);
    if (list) list.push(arm);
    else nodes.set(k, [arm]);
  };
  for (const w of usable) {
    const ang = wallAngle(w);
    addArm(w.a, { wallId: w.id, angle: ang });
    addArm(w.b, { wallId: w.id, angle: ang + Math.PI });
  }

  const outdoors = (p: Point): boolean =>
    rooms.length > 0 && !rooms.some((r) => pointInPolygon(p, r.polygon));

  for (const wall of usable) {
    const len = wallLength(wall);
    const dx = (wall.b.x - wall.a.x) / len;
    const dy = (wall.b.y - wall.a.y) / len;
    // +normal ("p") side.
    const nx = -dy;
    const ny = dx;
    const at = (s: number, off: number): Point => ({
      x: wall.a.x + dx * s + nx * off,
      y: wall.a.y + dy * s + ny * off,
    });

    const cuts = wallCuts(wall, openings, len, settings);
    for (const c of cuts) {
      const mid = (c.left + c.right) / 2;
      const p = at(mid, 0);
      placed.push({
        id: c.opening.id,
        wallId: wall.id,
        type: c.opening.type,
        x: p.x,
        y: p.y,
        angle: Math.atan2(dy, dx),
        width: c.right - c.left,
        y0: c.y0,
        y1: c.y1,
        thickness: settings.wallThickness,
        ...(c.opening.label ? { label: c.opening.label } : {}),
      });
    }

    // Other walls' endpoints landing on this wall's interior (T-junctions):
    // the exterior test can change across them.
    const tees: number[] = [];
    for (const other of usable) {
      if (other.id === wall.id) continue;
      for (const q of [other.a, other.b]) {
        const s = (q.x - wall.a.x) * dx + (q.y - wall.a.y) * dy;
        if (s <= 0.02 || s >= len - 0.02) continue;
        const off = Math.abs((q.x - wall.a.x) * nx + (q.y - wall.a.y) * ny);
        if (off < 0.01) tees.push(s);
      }
    }
    tees.sort((a, b) => a - b);

    const probe = h + 0.06;
    const classify = (s0: number, s1: number): { p: boolean; m: boolean } => {
      const mid = (s0 + s1) / 2;
      return { p: outdoors(at(mid, probe)), m: outdoors(at(mid, -probe)) };
    };

    // Split full-height runs at T-junctions, then merge neighbours that classify alike.
    const spans: (Span & { p: boolean; m: boolean })[] = [];
    for (const s of spansFromCuts(cuts, len, H)) {
      const full = s.y0 <= MIN_PIECE && s.y1 >= H - MIN_PIECE;
      const breaks = full ? tees.filter((t) => t > s.start + 0.02 && t < s.end - 0.02) : [];
      const stops = [s.start, ...breaks, s.end];
      let run: (Span & { p: boolean; m: boolean }) | null = null;
      for (let i = 0; i < stops.length - 1; i++) {
        const cls = classify(stops[i], stops[i + 1]);
        if (run && run.p === cls.p && run.m === cls.m) run.end = stops[i + 1];
        else {
          if (run) spans.push(run);
          run = { start: stops[i], end: stops[i + 1], y0: s.y0, y1: s.y1, ...cls };
        }
      }
      if (run) spans.push(run);
    }

    const joinA = joinAt(nodes.get(nodeKey(wall.a)) ?? [], wall.id, h);
    const joinB = joinAt(nodes.get(nodeKey(wall.b)) ?? [], wall.id, h);
    // An end that butts into the middle of another wall stops flush with that
    // wall's face — also when a second wall carries straight on from the far side.
    const loose = (j: { left: number; right: number; joined: boolean }): boolean =>
      !j.joined || (Math.abs(j.left) < 1e-6 && Math.abs(j.right) < 1e-6);
    const teeA = loose(joinA) ? teeTrim(usable, wall, wall.a, dx, dy, nx, ny, h) : null;
    const teeB = loose(joinB) ? teeTrim(usable, wall, wall.b, -dx, -dy, nx, ny, h) : null;

    spans.forEach((s, i) => {
      const room = Math.max(0, s.end - s.start - 0.004);
      const poly: Point[] = [];
      const sides: WallPiece['sides'] = [];
      const firstPiece = s.start <= MIN_PIECE;
      const lastPiece = s.end >= len - MIN_PIECE;
      const atA = firstPiece && joinA.joined && !teeA;
      const atB = lastPiece && joinB.joined && !teeB;
      const trim = (v: number): number => Math.max(0, Math.min(v, room));

      // At end A the direction away from the joint is +d, so "left" is the p side.
      const aP = atA ? Math.min(joinA.left, room) : firstPiece && teeA ? trim(teeA.p) : 0;
      const aM = atA ? Math.min(joinA.right, room) : firstPiece && teeA ? trim(teeA.m) : 0;
      // At end B it is −d, so "left" is the m side.
      const bM = atB ? Math.min(joinB.left, room) : lastPiece && teeB ? trim(teeB.m) : 0;
      const bP = atB ? Math.min(joinB.right, room) : lastPiece && teeB ? trim(teeB.p) : 0;

      // Walk the outline: p edge A→B, end B, m edge B→A, end A.
      poly.push(at(s.start + aP, h));
      sides.push('p');
      poly.push(at(s.end - bP, h));
      sides.push('cap');
      if (atB) {
        poly.push(at(s.end, 0));
        sides.push('cap');
      }
      poly.push(at(s.end - bM, -h));
      sides.push('m');
      poly.push(at(s.start + aM, -h));
      sides.push('cap');
      if (atA) {
        poly.push(at(s.start, 0));
        sides.push('cap');
      }

      pieces.push({
        key: `${wall.id}:${i}`,
        wallId: wall.id,
        poly,
        sides,
        y0: s.y0,
        y1: s.y1,
        pOuter: s.p,
        mOuter: s.m,
      });
    });
  }

  return { pieces, openings: placed };
}

// ---------- walk-mode blockers ----------

export interface Segment {
  a: Point;
  b: Point;
}

/** The solid stretches of every wall (door openings left out) as centerline segments. */
export function wallBlockers(walls: Wall[], openings: Opening[], settings: PlanSettings): Segment[] {
  const out: Segment[] = [];
  for (const wall of walls) {
    const len = wallLength(wall);
    if (!(len >= MIN_PIECE)) continue;
    const dx = (wall.b.x - wall.a.x) / len;
    const dy = (wall.b.y - wall.a.y) / len;
    const at = (s: number): Point => ({ x: wall.a.x + dx * s, y: wall.a.y + dy * s });
    let cursor = 0;
    for (const c of wallCuts(wall, openings, len, settings)) {
      if (c.opening.type !== 'door') continue;
      if (c.left - cursor > MIN_PIECE) out.push({ a: at(cursor), b: at(c.left) });
      cursor = c.right;
    }
    if (len - cursor > MIN_PIECE) out.push({ a: at(cursor), b: at(len) });
  }
  return out;
}
