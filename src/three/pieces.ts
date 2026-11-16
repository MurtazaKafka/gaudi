/**
 * Surfaces made of pieces. A roof is tiles, a wall is boards or bricks: each
 * one its own small bit of geometry with its own shade, instead of one
 * photograph stretched over a box. That is what makes a model look built
 * rather than wrapped.
 *
 * Everything here ends up as plain triangles with a colour per vertex, merged
 * into one mesh per wall piece or roof — no instancing, no shaders — so the
 * live view, the path tracer and exported files all see the same thing.
 */
import * as THREE from 'three';

export type P2 = [number, number];
export type V3 = [number, number, number];
export type RGB = [number, number, number];

/** A repeatable 0…1 for a cell: the same piece is the same shade on every rebuild. */
export function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A hex colour as the light it reflects (what vertex colours hold). */
export function lightOf(hex: string): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** Convex hull, counter-clockwise. */
export function convexHull(points: P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** The part of a polygon inside an axis-aligned box (Sutherland–Hodgman). */
export function clipToBox(poly: P2[], u0: number, u1: number, v0: number, v1: number): P2[] {
  let out = poly;
  const cut = (axis: 0 | 1, limit: number, keepBelow: boolean): void => {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[(i + 1) % src.length];
      const ain = keepBelow ? a[axis] <= limit : a[axis] >= limit;
      const bin = keepBelow ? b[axis] <= limit : b[axis] >= limit;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = (limit - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  };
  cut(0, u0, false);
  if (out.length >= 3) cut(0, u1, true);
  if (out.length >= 3) cut(1, v0, false);
  if (out.length >= 3) cut(1, v1, true);
  return out.length >= 3 ? out : [];
}

export function polygonArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Loose, flat-shaded, coloured triangles being collected into one mesh. */
export class Soup {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  get empty(): boolean {
    return this.positions.length === 0;
  }

  /** A flat convex polygon, wound so that it faces along `toward`. */
  poly(pts: V3[], color: RGB, toward: V3): void {
    if (pts.length < 3) return;
    // Newell's normal: steady even when the first corners are nearly in line.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    if (nx * nx + ny * ny + nz * nz < 1e-16) return;
    const flip = nx * toward[0] + ny * toward[1] + nz * toward[2] < 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[0];
      const b = flip ? pts[i + 1] : pts[i];
      const c = flip ? pts[i] : pts[i + 1];
      this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      for (let k = 0; k < 3; k++) this.colors.push(color[0], color[1], color[2], 1);
    }
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.empty || !this.positions.every((v) => Number.isFinite(v))) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    // Four components: the path tracer merges colours as RGBA and mangles three-component ones.
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 4));
    // Loose triangles: every face flat, every edge crisp.
    geo.computeVertexNormals();
    return geo;
  }
}

export const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function unit(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
