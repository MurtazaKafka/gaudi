import type { Point, Wall } from './types';

export const EPS = 1e-6;

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function ptEq(a: Point, b: Point, eps = EPS): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

export function snapToGrid(p: Point, grid: number): Point {
  return {
    x: Math.round(p.x / grid) * grid,
    y: Math.round(p.y / grid) * grid,
  };
}

export interface SnapResult {
  p: Point;
  kind: 'endpoint' | 'grid';
}

/**
 * Snap a raw point: existing wall endpoints win within `radius` (m),
 * otherwise fall back to the grid. `exclude` skips endpoints (e.g. the
 * junction currently being dragged).
 */
export function snapPoint(
  raw: Point,
  walls: Wall[],
  grid: number,
  radius: number,
  exclude?: (wallId: string, end: 'a' | 'b') => boolean,
): SnapResult {
  let best: Point | null = null;
  let bestD = radius;
  for (const w of walls) {
    for (const end of ['a', 'b'] as const) {
      if (exclude && exclude(w.id, end)) continue;
      const e = w[end];
      const d = dist(raw, e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  if (best) return { p: { ...best }, kind: 'endpoint' };
  return { p: snapToGrid(raw, grid), kind: 'grid' };
}

export interface WallHit {
  wallId: string;
  /** distance from wall endpoint A along the wall, m */
  offset: number;
  /** perpendicular distance from the query point, m */
  dist: number;
}

/** Nearest point on any wall segment (for placing openings). */
export function nearestWallPoint(p: Point, walls: Wall[]): WallHit | null {
  let best: WallHit | null = null;
  for (const w of walls) {
    const len = dist(w.a, w.b);
    if (len < EPS) continue;
    const dx = (w.b.x - w.a.x) / len;
    const dy = (w.b.y - w.a.y) / len;
    const t = Math.min(len, Math.max(0, (p.x - w.a.x) * dx + (p.y - w.a.y) * dy));
    const proj = { x: w.a.x + dx * t, y: w.a.y + dy * t };
    const d = dist(p, proj);
    if (!best || d < best.dist) best = { wallId: w.id, offset: t, dist: d };
  }
  return best;
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const len = dist(a, b);
  if (len < EPS) return dist(p, a);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len)));
  return dist(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
}

/** Corners of a w×d rectangle centered at (cx,cy), rotated by `rot` radians. */
export function rectCorners(cx: number, cy: number, w: number, d: number, rot: number): Point[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const hw = w / 2;
  const hd = d / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ].map((p) => ({ x: cx + p.x * c - p.y * s, y: cy + p.x * s + p.y * c }));
}

/** Separating-axis overlap test for two convex quads. */
export function quadsOverlap(a: Point[], b: Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const axis = { x: p2.y - p1.y, y: p1.x - p2.x };
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of a) {
        const proj = p.x * axis.x + p.y * axis.y;
        minA = Math.min(minA, proj);
        maxA = Math.max(maxA, proj);
      }
      for (const p of b) {
        const proj = p.x * axis.x + p.y * axis.y;
        minB = Math.min(minB, proj);
        maxB = Math.max(maxB, proj);
      }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function wallLength(w: Wall): number {
  return dist(w.a, w.b);
}

export function wallAngle(w: Wall): number {
  return Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
}

export function formatMeters(m: number): string {
  return `${m.toFixed(2)} m`;
}
