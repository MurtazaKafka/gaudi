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
