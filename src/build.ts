/**
 * Plan → solid pieces. Pure geometry (no three.js, no store): the 3D scene,
 * the GLB exporter and walk-mode collision all read the same description.
 *
 * Openings never use CSG: each wall splits into side pieces, lintels and
 * sills. Wall ends are mitred against their neighbours so corners close.
 *
 * A wall may rise several levels (levels.ts). It is built to its full height
 * with its windows repeated on every level; a door stays on the ground with
 * solid wall above it. Where walls of different heights meet, each keeps its
 * own height: the joint is worked out band by band, so above a shorter wall
 * the taller one's corner still closes, and the parts of a wall that stand
 * above a lower neighbour's roof face outdoors.
 */
import type { Opening, OpeningType, PlanSettings, Point, Wall } from './types';
import { wallAngle, wallLength } from './geometry';
import { levelsOf, MAX_LEVELS, planLevels, roomLocator } from './levels';

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

/**
 * The solid stretches of a wall `H` high around its openings. A window is
 * cut again on each of `levels` levels, `pitch` apart, at the same sill and
 * head; a door only on the ground, with solid wall above it all the way up.
 */
function spansFromCuts(cuts: Cut[], len: number, H: number, pitch = H, levels = 1): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.left - cursor > MIN_PIECE) spans.push({ start: cursor, end: c.left, y0: 0, y1: H });
    if (c.y0 > MIN_PIECE) spans.push({ start: c.left, end: c.right, y0: 0, y1: c.y0 });
    const rows = c.opening.type === 'window' ? levels : 1;
    // Between one level's window head and the sill of the window above it.
    for (let k = 1; k < rows; k++) {
      const y0 = c.y1 + (k - 1) * pitch;
      const y1 = c.y0 + k * pitch;
      if (y1 - y0 > MIN_PIECE) spans.push({ start: c.left, end: c.right, y0, y1 });
    }
    const head = c.y1 + (rows - 1) * pitch;
    if (H - head > MIN_PIECE) spans.push({ start: c.left, end: c.right, y0: head, y1: H });
    cursor = c.right;
  }
  if (len - cursor > MIN_PIECE) spans.push({ start: cursor, end: len, y0: 0, y1: H });
  return spans;
}

/** Walls (+ openings) as plain boxes, each wall at its own levels. Kept for callers that want simple blocks. */
export function buildWallBoxes(walls: Wall[], openings: Opening[], settings: PlanSettings): WallBox[] {
  const boxes: WallBox[] = [];
  for (const wall of walls) {
    const len = wallLength(wall);
    if (!(len >= MIN_PIECE)) continue;
    const angle = wallAngle(wall);
    const dx = (wall.b.x - wall.a.x) / len;
    const dy = (wall.b.y - wall.a.y) / len;
    const levels = levelsOf(wall);
    const H = levels * settings.wallHeight;
    const spans = spansFromCuts(wallCuts(wall, openings, len, settings), len, H, settings.wallHeight, levels);
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
 *  'cap'     — an end (a free end, a door jamb, or a mitre hidden in a joint),
 *  'end'     — a wall's end standing in the open above a shorter wall it
 *              meets: finished like the faces either side of it.
 */
export interface WallPiece {
  key: string;
  wallId: string;
  poly: Point[];
  sides: ('p' | 'm' | 'cap' | 'end')[];
  y0: number;
  y1: number;
  /** The +normal long face looks outdoors (gets cladding). */
  pOuter: boolean;
  /** The −normal long face looks outdoors. */
  mOuter: boolean;
  /**
   * The piece stands on another piece of the same stretch of wall, cut where
   * a neighbour's roof or a shorter wall stops. Which side of the wall is
   * indoors is read from the pieces on the ground, not from these.
   */
  stacked?: boolean;
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
  /** The ground level's sill and head. */
  y0: number;
  y1: number;
  thickness: number;
  label?: string;
  /** A window on a wall of several levels: how many rows of it there are, one per level (absent = 1)… */
  levels?: number;
  /** …and how far apart they are (m): the plan's wall height. */
  pitch?: number;
}

export interface WallModel {
  pieces: WallPiece[];
  openings: PlacedOpening[];
}

/** How far above the ground row each row of an opening stands (m): just [0] for a door or a one-level wall. */
export function openingRows(o: Pick<PlacedOpening, 'levels' | 'pitch'>): number[] {
  const n = o.levels ?? 1;
  const pitch = o.pitch ?? 0;
  if (!(n > 1) || !(pitch > 0)) return [0];
  return Array.from({ length: Math.min(n, MAX_LEVELS) }, (_, k) => k * pitch);
}

const NODE_GRID = 1e-3;
const nodeKey = (p: Point): string => `${Math.round(p.x / NODE_GRID)},${Math.round(p.y / NODE_GRID)}`;

interface Arm {
  wallId: string;
  /** direction away from the joint, radians */ angle: number;
  /** how high this wall stands (m) */ top: number;
}

interface Join {
  left: number;
  right: number;
  joined: boolean;
}

/**
 * How far along the wall (from the joint, into the wall) each long edge's
 * corner sits: positive = pulled back, negative = pushed past the joint.
 * `left` is the edge on the +90° side of the direction pointing away from the joint.
 */
function joinAt(arms: Arm[], wallId: string, h: number): Join {
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

interface Tee {
  p: number;
  m: number;
  /** How high the wall it butts into stands (m). */
  top: number;
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
  topOf: (w: Wall) => number,
): Tee | null {
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
    return { p: at(h), m: at(-h), top: topOf(other) };
  }
  return null;
}

/**
 * How one end of a piece is finished: where its p and m edges stop (pulled
 * back along the wall from the end), whether it is mitred to a point on the
 * joint, and whether the end face is left standing in the open.
 */
interface End {
  p: number;
  m: number;
  centre: boolean;
  open: boolean;
}

const PLAIN: End = { p: 0, m: 0, centre: false, open: false };

/**
 * Walls + openings as mitred prisms, plus each opening's placement. `rooms`
 * (detected room polygons) decide which faces count as exterior; without any
 * rooms every face is interior. They also carry walls up where a taller roof
 * needs closing in (levels.ts).
 */
export function buildWallModel(
  walls: Wall[],
  openings: Opening[],
  settings: PlanSettings,
  rooms: { polygon: Point[] }[] = [],
): WallModel {
  /** One level. */
  const P = settings.wallHeight;
  const h = settings.wallThickness / 2;
  const pieces: WallPiece[] = [];
  const placed: PlacedOpening[] = [];

  const usable = walls.filter(
    (w) =>
      Number.isFinite(w.a.x) && Number.isFinite(w.a.y) && Number.isFinite(w.b.x) && Number.isFinite(w.b.y) &&
      wallLength(w) >= MIN_PIECE,
  );

  const locate = roomLocator(rooms);
  const levels = planLevels(usable, rooms, settings.wallThickness, locate);
  const topOf = (w: Wall): number => levels.wall(w) * P;

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
    const top = topOf(w);
    addArm(w.a, { wallId: w.id, angle: ang, top });
    addArm(w.b, { wallId: w.id, angle: ang + Math.PI, top });
  }

  /** How high the roof over a point stands: 0 outdoors. With no rooms at all, every face counts as indoors. */
  const roofOver = (p: Point): number => {
    if (rooms.length === 0) return Infinity;
    const i = locate(p);
    return i < 0 ? 0 : levels.rooms[i] * P;
  };

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
    const lv = levels.wall(wall);
    const H = lv * P;

    const cuts = wallCuts(wall, openings, len, settings);
    for (const c of cuts) {
      const mid = (c.left + c.right) / 2;
      const p = at(mid, 0);
      const rows = c.opening.type === 'window' ? lv : 1;
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
        ...(rows > 1 ? { levels: rows, pitch: P } : {}),
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

    // What stands over each side: from this height up, that face is outdoors.
    const probe = h + 0.06;
    const classify = (s0: number, s1: number): { p: number; m: number } => {
      const mid = (s0 + s1) / 2;
      return { p: roofOver(at(mid, probe)), m: roofOver(at(mid, -probe)) };
    };

    // Split full-height runs at T-junctions, then merge neighbours that classify alike.
    const spans: (Span & { p: number; m: number })[] = [];
    for (const s of spansFromCuts(cuts, len, H, P, lv)) {
      const full = s.y0 <= MIN_PIECE && s.y1 >= H - MIN_PIECE;
      const breaks = full ? tees.filter((t) => t > s.start + 0.02 && t < s.end - 0.02) : [];
      const stops = [s.start, ...breaks, s.end];
      let run: (Span & { p: number; m: number }) | null = null;
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

    const armsA = nodes.get(nodeKey(wall.a)) ?? [];
    const armsB = nodes.get(nodeKey(wall.b)) ?? [];
    const joinA = joinAt(armsA, wall.id, h);
    const joinB = joinAt(armsB, wall.id, h);
    // An end that butts into the middle of another wall stops flush with that
    // wall's face — also when a second wall carries straight on from the far side.
    const loose = (j: Join): boolean => !j.joined || (Math.abs(j.left) < 1e-6 && Math.abs(j.right) < 1e-6);
    const teeA = loose(joinA) ? teeTrim(usable, wall, wall.a, dx, dy, nx, ny, h, topOf) : null;
    const teeB = loose(joinB) ? teeTrim(usable, wall, wall.b, -dx, -dy, nx, ny, h, topOf) : null;

    /**
     * One end of the band of a piece that starts `b0` up. `leftIsP`: at end A
     * the direction away from the joint is +d, so "left" is the p side; at B it is −d.
     */
    const endOf = (arms: Arm[], join: Join, tee: Tee | null, b0: number, room: number, leftIsP: boolean): End => {
      const mitre = (j: Join): End => {
        const [p, m] = leftIsP ? [j.left, j.right] : [j.right, j.left];
        return { p: Math.min(p, room), m: Math.min(m, room), centre: true, open: false };
      };
      // The walls of this joint that still stand at this height.
      const here = arms.length >= 2 ? arms.filter((a) => a.wallId === wall.id || a.top > b0 + 1e-6) : arms;
      if (here.length < arms.length) {
        const j = joinAt(here, wall.id, h);
        if (j.joined) return mitre(j);
        // Above every other wall here: a square end reaching out to the joint's outer corner,
        // so the corner stays closed where the shorter wall stops.
        const reach = Math.min(Math.max(-2 * h, Math.min(join.left, join.right)), room);
        return { p: reach, m: reach, centre: false, open: true };
      }
      if (join.joined && !tee) return mitre(join);
      if (tee) {
        const trim = (v: number): number => Math.max(0, Math.min(v, room));
        return { p: trim(tee.p), m: trim(tee.m), centre: false, open: b0 >= tee.top - 1e-6 };
      }
      return PLAIN;
    };

    spans.forEach((s, i) => {
      const room = Math.max(0, s.end - s.start - 0.004);
      const firstPiece = s.start <= MIN_PIECE;
      const lastPiece = s.end >= len - MIN_PIECE;

      // Cut the piece where a neighbour's roof stops (above it, that face is outdoors) and, at the
      // wall's ends, where a shorter wall it meets stops (above it, the joint is a different one).
      const heights: number[] = [s.p, s.m];
      const ends: [boolean, Arm[], Tee | null][] = [
        [firstPiece, armsA, teeA],
        [lastPiece, armsB, teeB],
      ];
      for (const [on, arms, tee] of ends) {
        if (!on) continue;
        if (arms.length >= 2) for (const a of arms) if (a.wallId !== wall.id) heights.push(a.top);
        if (tee) heights.push(tee.top);
      }
      const stops = [s.y0];
      for (const y of heights.filter((y) => y > s.y0 + MIN_PIECE && y < s.y1 - MIN_PIECE).sort((a, b) => a - b)) {
        if (y - stops[stops.length - 1] > 1e-4) stops.push(y);
      }
      stops.push(s.y1);

      for (let j = 0; j < stops.length - 1; j++) {
        const b0 = stops[j];
        const b1 = stops[j + 1];
        const a = firstPiece ? endOf(armsA, joinA, teeA, b0, room, true) : PLAIN;
        const b = lastPiece ? endOf(armsB, joinB, teeB, b0, room, false) : PLAIN;
        const poly: Point[] = [];
        const sides: WallPiece['sides'] = [];

        // Walk the outline: p edge A→B, end B, m edge B→A, end A.
        poly.push(at(s.start + a.p, h));
        sides.push('p');
        poly.push(at(s.end - b.p, h));
        sides.push(b.open ? 'end' : 'cap');
        if (b.centre) {
          poly.push(at(s.end, 0));
          sides.push('cap');
        }
        poly.push(at(s.end - b.m, -h));
        sides.push('m');
        poly.push(at(s.start + a.m, -h));
        sides.push(a.open ? 'end' : 'cap');
        if (a.centre) {
          poly.push(at(s.start, 0));
          sides.push('cap');
        }

        pieces.push({
          key: j === 0 ? `${wall.id}:${i}` : `${wall.id}:${i}.${j}`,
          wallId: wall.id,
          poly,
          sides,
          y0: b0,
          y1: b1,
          pOuter: b0 >= s.p - 1e-6,
          mOuter: b0 >= s.m - 1e-6,
          ...(j > 0 ? { stacked: true } : {}),
        });
      }
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
