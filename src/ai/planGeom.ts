/**
 * Store-free plan geometry shared by "Ask Gaudí" edits and the furnisher:
 * room analysis (edges, sides, neighbours), opening fit rules, furniture
 * footprints and "does it fit in this room" tests. Everything takes plain
 * PlanData pieces, so it runs (and is tested) outside the browser.
 */
import { dist, distToSegment, pointInPolygon, rectCorners } from '../geometry';
import { detectRooms, type DetectedRoom } from '../rooms';
import { FURNITURE, customId, isBuiltinKind, isCustomKind, type FurnitureDef } from '../catalog';
import type { Furniture, Opening, PlanData, Point, Wall } from '../types';

/** Margin kept between openings and wall ends / each other (mirrors store.ts). */
export const OPENING_GAP = 0.05;

export const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Clamp an opening's center so it sits fully on the wall. */
export function clampOffset(wall: Wall, offset: number, width: number): number {
  const len = dist(wall.a, wall.b);
  const half = width / 2 + OPENING_GAP;
  return Math.min(Math.max(offset, half), Math.max(half, len - half));
}

export function openingFits(
  openings: Opening[],
  wall: Wall,
  offset: number,
  width: number,
  ignoreId?: string,
): boolean {
  const len = dist(wall.a, wall.b);
  if (offset - width / 2 < -1e-9 || offset + width / 2 > len + 1e-9) return false;
  return openings.every(
    (o) =>
      o.wallId !== wall.id ||
      o.id === ignoreId ||
      Math.abs(o.offset - offset) >= (o.width + width) / 2 + OPENING_GAP - 1e-9,
  );
}

/** World position of a point `offset` meters along a wall from endpoint A. */
export function pointOnWall(wall: Wall, offset: number): Point {
  const len = dist(wall.a, wall.b);
  if (len < 1e-9) return { ...wall.a };
  const t = offset / len;
  return { x: wall.a.x + (wall.b.x - wall.a.x) * t, y: wall.a.y + (wall.b.y - wall.a.y) * t };
}

/** Distance along the wall (from A) of the point on its line nearest to `p`. Not clamped. */
export function projectOnWall(wall: Wall, p: Point): number {
  const len = dist(wall.a, wall.b);
  if (len < 1e-9) return 0;
  return ((p.x - wall.a.x) * (wall.b.x - wall.a.x) + (p.y - wall.a.y) * (wall.b.y - wall.a.y)) / len;
}

/** Resolve a furniture kind against the catalog and a plan's own custom items. */
export function defFor(plan: Pick<PlanData, 'customItems'>, kind: unknown): FurnitureDef | null {
  if (isBuiltinKind(kind)) return FURNITURE[kind];
  if (isCustomKind(kind)) {
    const id = customId(kind);
    return Object.hasOwn(plan.customItems, id) ? plan.customItems[id] : null;
  }
  return null;
}

/** Rugs and other floor-flat pieces: other furniture may stand on them. */
export function isFlat(kind: string, def: FurnitureDef): boolean {
  return kind === 'rug' || def.h <= 0.06;
}

export function footprint(def: FurnitureDef, f: Pick<Furniture, 'x' | 'y' | 'rotation'>): Point[] {
  return rectCorners(f.x, f.y, def.w, def.d, f.rotation);
}

/** Degrees (clockwise) → radians, normalized to [0, 2π) and squared up when nearly orthogonal. */
export function degToRad(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  const q = Math.round(d / 90) * 90;
  if (Math.abs(d - q) < 3) d = q % 360;
  return r3((d * Math.PI) / 180);
}

export const radToDeg = (rad: number): number => {
  const d = Math.round((rad * 180) / Math.PI) % 360;
  return d < 0 ? d + 360 : d;
};

// ---------- compass ----------

export type Compass = 'north' | 'south' | 'east' | 'west';

export const COMPASS: Record<Compass, Point> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

export const isCompass = (v: unknown): v is Compass =>
  typeof v === 'string' && Object.hasOwn(COMPASS, v);

export function compassOf(v: Point): Compass {
  if (Math.abs(v.x) > Math.abs(v.y)) return v.x > 0 ? 'east' : 'west';
  return v.y > 0 ? 'south' : 'north';
}

// ---------- polygons ----------

export function nearestOnBoundary(p: Point, poly: Point[]): { q: Point; d: number } {
  let best: Point = poly[0] ?? p;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return { q: best, d: bestD };
}

/** A point guaranteed to be inside the polygon (the centroid of an L-shaped room may not be). */
export function interiorPoint(poly: Point[]): Point {
  const c = {
    x: poly.reduce((s, p) => s + p.x, 0) / Math.max(1, poly.length),
    y: poly.reduce((s, p) => s + p.y, 0) / Math.max(1, poly.length),
  };
  if (pointInPolygon(c, poly) && nearestOnBoundary(c, poly).d > 0.05) return c;
  let best: Point | null = null;
  let bestD = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = dist(a, b);
    if (len < 1e-6) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n = { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
    for (const s of [1, -1]) {
      for (const step of [0.5, 0.2, 0.05]) {
        const q = { x: m.x + n.x * step * s, y: m.y + n.y * step * s };
        if (!pointInPolygon(q, poly)) continue;
        const d = nearestOnBoundary(q, poly).d;
        if (d > bestD) {
          bestD = d;
          best = q;
        }
      }
    }
  }
  return best ?? c;
}

function shrink(corners: Point[], k: number): Point[] {
  const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
  const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
  return corners.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
}

/** True when a footprint lies inside the polygon (corners may touch the boundary within `tol`). */
export function fitsInside(corners: Point[], poly: Point[], tol = 0.01): boolean {
  for (const c of corners) {
    if (!pointInPolygon(c, poly) && nearestOnBoundary(c, poly).d > tol) return false;
  }
  const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
  const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
  if (!pointInPolygon({ x: cx, y: cy }, poly)) return false;
  // A concave corner of the room poking into the footprint.
  const inner = shrink(corners, 0.96);
  return !poly.some((v) => pointInPolygon(v, inner));
}

/**
 * Find the nearest position where a w×d footprint sits inside the polygon
 * with `margin` to the boundary (walls are drawn on their centerlines, so a
 * flush piece needs half a wall thickness). Returns null if it would have to
 * move more than `maxShift` — i.e. it was not really meant for this spot.
 */
export function settleInside(
  x: number,
  y: number,
  w: number,
  d: number,
  rot: number,
  poly: Point[],
  maxShift = 0.4,
  margin = 0.05,
): Point | null {
  let cx = x;
  let cy = y;
  for (let i = 0; i < 24; i++) {
    const corners = rectCorners(cx, cy, w, d, rot);
    let worst = 0;
    let push: Point | null = null;
    for (const c of corners) {
      const { q, d: bd } = nearestOnBoundary(c, poly);
      const inside = pointInPolygon(c, poly);
      const deficit = inside ? margin - bd : margin + bd;
      if (deficit <= 0.004 || deficit <= worst) continue;
      // Direction into the room: toward the boundary when outside, away from it when inside.
      let dir: Point;
      if (bd > 1e-6) {
        dir = inside ? { x: (c.x - q.x) / bd, y: (c.y - q.y) / bd } : { x: (q.x - c.x) / bd, y: (q.y - c.y) / bd };
      } else {
        const len = Math.hypot(cx - c.x, cy - c.y) || 1;
        dir = { x: (cx - c.x) / len, y: (cy - c.y) / len };
      }
      worst = deficit;
      push = { x: dir.x * deficit, y: dir.y * deficit };
    }
    if (!push) {
      if (fitsInside(corners, poly)) return { x: r3(cx), y: r3(cy) };
      // All corners are in, but a concave room corner pokes into the piece: back away from it.
      const v = poly.find((p) => pointInPolygon(p, corners));
      if (!v) return null;
      const len = Math.hypot(cx - v.x, cy - v.y) || 1;
      push = { x: ((cx - v.x) / len) * 0.1, y: ((cy - v.y) / len) * 0.1 };
    }
    cx += push.x;
    cy += push.y;
    if (Math.hypot(cx - x, cy - y) > maxShift) break;
  }
  // No room for the margin (a piece that only just fits): accept the spot asked for if it is inside at all.
  return fitsInside(rectCorners(x, y, w, d, rot), poly) ? { x: r3(x), y: r3(y) } : null;
}

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/** True when a wall passes through the body of a footprint (touching its edge doesn't count). */
export function crossesWall(corners: Point[], walls: Wall[]): boolean {
  const inner = shrink(corners, 0.9);
  for (const w of walls) {
    if (pointInPolygon(w.a, inner) || pointInPolygon(w.b, inner)) return true;
    for (let i = 0; i < inner.length; i++) {
      if (segmentsCross(w.a, w.b, inner[i], inner[(i + 1) % inner.length])) return true;
    }
  }
  return false;
}

/** Length two walls overlap along a shared line (0 unless they are collinear). */
export function collinearOverlap(a: Wall, b: Wall): number {
  const la = dist(a.a, a.b);
  const lb = dist(b.a, b.b);
  if (la < 1e-6 || lb < 1e-6) return 0;
  const ux = (a.b.x - a.a.x) / la;
  const uy = (a.b.y - a.a.y) / la;
  const off = (p: Point) => Math.abs((p.x - a.a.x) * uy - (p.y - a.a.y) * ux);
  if (off(b.a) > 0.02 || off(b.b) > 0.02) return 0;
  const t1 = (b.a.x - a.a.x) * ux + (b.a.y - a.a.y) * uy;
  const t2 = (b.b.x - a.a.x) * ux + (b.b.y - a.a.y) * uy;
  return Math.max(0, Math.min(Math.max(t1, t2), la) - Math.max(Math.min(t1, t2), 0));
}

// ---------- rooms ----------

export interface RoomEdge {
  a: Point;
  b: Point;
  length: number;
  /** The wall this stretch of boundary lies on, if it could be identified. */
  wallId: string | null;
  /** Unit normal pointing out of the room. */
  out: Point;
  side: Compass;
  /** Index (into the same room list) of the room across this edge; -1 for outside. */
  neighbour: number;
}

export interface RoomInfo {
  index: number;
  room: DetectedRoom;
  name: string | undefined;
  wallIds: string[];
  edges: RoomEdge[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The wall ids a detected room's key was built from. */
export function roomWallIds(room: DetectedRoom): string[] {
  return room.key.split('#')[0].split('|').filter(Boolean);
}

/** Detect rooms and work out, edge by edge, which wall bounds them and what lies beyond. */
export function analyzeRooms(walls: Wall[], roomNames: Record<string, string>): RoomInfo[] {
  const rooms = detectRooms(walls);
  const byId = new Map(walls.map((w) => [w.id, w]));
  return rooms.map((room, index) => {
    const wallIds = roomWallIds(room);
    const own = wallIds.map((id) => byId.get(id)).filter((w): w is Wall => !!w);
    const poly = room.polygon;
    const edges: RoomEdge[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const length = dist(a, b);
      if (length < 0.02) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const n = { x: (b.y - a.y) / length, y: -(b.x - a.x) / length };
      const probe = Math.min(0.1, length / 4);
      const inN = pointInPolygon({ x: m.x + n.x * probe, y: m.y + n.y * probe }, poly);
      const out = inN ? { x: -n.x, y: -n.y } : n;
      const beyond = { x: m.x + out.x * 0.15, y: m.y + out.y * 0.15 };
      const neighbour = rooms.findIndex((r, j) => j !== index && pointInPolygon(beyond, r.polygon));
      const onWall = (w: Wall) => distToSegment(a, w.a, w.b) < 0.01 && distToSegment(b, w.a, w.b) < 0.01;
      const wall = own.find(onWall) ?? walls.find(onWall);
      edges.push({ a, b, length, wallId: wall?.id ?? null, out, side: compassOf(out), neighbour });
    }
    return {
      index,
      room,
      name: roomNames[room.key],
      wallIds,
      edges,
      minX: Math.min(...poly.map((p) => p.x)),
      maxX: Math.max(...poly.map((p) => p.x)),
      minY: Math.min(...poly.map((p) => p.y)),
      maxY: Math.max(...poly.map((p) => p.y)),
    };
  });
}

export interface RoomOpening {
  opening: Opening;
  wall: Wall;
  center: Point;
  /** Unit vector from the opening into the room. */
  inward: Point;
  /** Index of the room on the other side, -1 for outside. */
  beyond: number;
}

/** Doors and windows that sit on a room's boundary. */
export function roomOpenings(info: RoomInfo, walls: Wall[], openings: Opening[]): RoomOpening[] {
  const out: RoomOpening[] = [];
  const byId = new Map(walls.map((w) => [w.id, w]));
  for (const o of openings) {
    const wall = byId.get(o.wallId);
    if (!wall) continue;
    const center = pointOnWall(wall, o.offset);
    const edge = info.edges.find((e) => distToSegment(center, e.a, e.b) < 0.05);
    if (!edge) continue;
    out.push({ opening: o, wall, center, inward: { x: -edge.out.x, y: -edge.out.y }, beyond: edge.neighbour });
  }
  return out;
}

/** Furniture whose center lies in a room. */
export function furnitureInRoom(furniture: Furniture[], room: DetectedRoom): Furniture[] {
  return furniture.filter((f) => pointInPolygon({ x: f.x, y: f.y }, room.polygon));
}

/**
 * The floor in front of an opening that must stay clear: as wide as the
 * opening (plus a little) and `depth` meters into the room.
 */
export function clearZone(o: RoomOpening, depth: number): Point[] {
  const len = dist(o.wall.a, o.wall.b) || 1;
  const u = { x: (o.wall.b.x - o.wall.a.x) / len, y: (o.wall.b.y - o.wall.a.y) / len };
  const half = o.opening.width / 2 + 0.05;
  const c = o.center;
  const n = o.inward;
  return [
    { x: c.x - u.x * half, y: c.y - u.y * half },
    { x: c.x + u.x * half, y: c.y + u.y * half },
    { x: c.x + u.x * half + n.x * depth, y: c.y + u.y * half + n.y * depth },
    { x: c.x - u.x * half + n.x * depth, y: c.y - u.y * half + n.y * depth },
  ];
}
