/**
 * Plan symbols drawn from an item's 3D parts: a top-down view of what it is
 * made of. Boxes become (rotated) rectangles, upright round parts become
 * circles and ellipses, anything tilted becomes the outline of its shadow.
 * Parts hidden under taller parts are left out, as on a drawn plan. Works for
 * the built-in catalog and for custom items alike. Pure.
 *
 * Symbol frame: meters, item center at (0,0), x right, y toward the item's
 * front — i.e. part (x, z).
 */
import type { FurnitureDef, Part } from '../../catalog';
import { partHalfExtents, rotatePartOffset } from '../../customItems';
import { plannedColor, plannedEdge } from './look';

interface Paint {
  /** the part's colour as it sits on the plan */ fill: string;
  /** hairline around it */ edge: string;
  /** 0..1, for glass */ opacity: number;
  /** outline only (the inside of a ring) */ hole?: boolean;
}

export type PlanShape =
  | ({ kind: 'poly'; /** closed outline, flat [x0, y0, x1, y1, …], clockwise on screen */ points: number[] } & Paint)
  | ({ kind: 'ellipse'; x: number; y: number; rx: number; ry: number; /** degrees, clockwise on screen */ rotation: number } & Paint);

const MAX_SHAPES = 48;
const MIN_SIZE = 0.012;
const RING = 16;

type P2 = [number, number];
type V3 = [number, number, number];

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

const isZeroTurn = (deg: number): boolean => Math.abs(((deg % 360) + 360) % 360) < 1e-6 ||
  Math.abs((((deg % 360) + 360) % 360) - 360) < 1e-6;

/** The part's own vertical axis still points up (only turned about it, if at all). */
function upright(p: Part): boolean {
  return !p.rot || (isZeroTurn(p.rot[0]) && isZeroTurn(p.rot[2]));
}

function cross(o: P2, a: P2, b: P2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain. Returns the hull counter-clockwise (in a y-up reading). */
export function convexHull(points: P2[]): P2[] {
  const pts = points
    .slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, i, arr) => i === 0 || Math.abs(p[0] - arr[i - 1][0]) > 1e-9 || Math.abs(p[1] - arr[i - 1][1]) > 1e-9);
  if (pts.length < 3) return pts;
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

/** True when `p` is inside (or within `tol` of) the convex polygon `hull` (counter-clockwise). */
function insideConvex(p: P2, hull: P2[], tol: number): boolean {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    if (cross(a, b, p) / len < -tol) return false;
  }
  return true;
}

function ring(radius: number, y: number, n = RING): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([Math.cos(t) * radius, y, Math.sin(t) * radius]);
  }
  return out;
}

/** Points on the part's surface (own frame, before rotation) whose shadow spans its silhouette. */
function surfaceSamples(p: Part): V3[] {
  const [hx, hy, hz] = partHalfExtents(p);
  switch (p.shape) {
    case 'box':
    case 'rbox': {
      const out: V3[] = [];
      const bevel = p.shape === 'rbox' ? Math.min(p.bevel ?? 0, hx, hz) : 0;
      if (bevel > 0.004) {
        // Rounded corners, seen from above.
        for (const sy of [-1, 1]) {
          for (const [cx, cz, from] of [
            [hx - bevel, hz - bevel, 0],
            [-(hx - bevel), hz - bevel, 1],
            [-(hx - bevel), -(hz - bevel), 2],
            [hx - bevel, -(hz - bevel), 3],
          ]) {
            for (let i = 0; i <= 4; i++) {
              const t = (from + i / 4) * (Math.PI / 2);
              out.push([cx + Math.cos(t) * bevel, sy * hy, cz + Math.sin(t) * bevel]);
            }
          }
        }
        return out;
      }
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push([sx * hx, sy * hy, sz * hz]);
      return out;
    }
    case 'cylinder':
      return [...ring(p.r ?? 0, -hy), ...ring(p.r2 ?? p.r ?? 0, hy)];
    case 'cone':
      return [...ring(p.r ?? 0, -hy), [0, hy, 0]];
    case 'sphere': {
      const out: V3[] = [[0, hy, 0], [0, -hy, 0]];
      for (const lat of [-0.5, 0, 0.5]) {
        const k = Math.cos(lat * (Math.PI / 2) * 1.2);
        const y = Math.sin(lat * (Math.PI / 2) * 1.2) * hy;
        for (let i = 0; i < RING; i++) {
          const t = (i / RING) * Math.PI * 2;
          out.push([Math.cos(t) * hx * k, y, Math.sin(t) * hz * k]);
        }
      }
      return out;
    }
    case 'torus': {
      const R = p.r ?? 0;
      const tube = p.r2 ?? 0;
      return [...ring(R + tube, 0), ...ring(R, tube), ...ring(R, -tube)];
    }
  }
}

interface Outline {
  shape: PlanShape;
  /** convex outline used for the hidden-part test */
  hull: P2[];
  top: number;
  extra?: PlanShape;
}

function outlineOf(p: Part): Outline | null {
  const [hx, hy, hz] = partHalfExtents(p);
  const samples = surfaceSamples(p).map((v) => rotatePartOffset(v, p.rot));
  const top = p.y + Math.max(...samples.map((v) => v[1]), -hy);
  const hull = convexHull(samples.map((v): P2 => [p.x + v[0], p.z + v[2]]));
  if (hull.length < 3) return null;
  const xs = hull.map((q) => q[0]);
  const ys = hull.map((q) => q[1]);
  if (Math.max(...xs) - Math.min(...xs) < MIN_SIZE && Math.max(...ys) - Math.min(...ys) < MIN_SIZE) return null;

  const paint: Paint = {
    fill: plannedColor(p.color),
    edge: plannedEdge(p.color),
    opacity: typeof p.opacity === 'number' && p.opacity < 1 ? Math.max(0.25, p.opacity) : 1,
  };
  const round = p.shape === 'cylinder' || p.shape === 'cone' || p.shape === 'sphere' || p.shape === 'torus';
  const isBall = p.shape === 'sphere' && !(p.w !== undefined && p.h !== undefined && p.d !== undefined);
  if (round && (upright(p) || isBall)) {
    const shape: PlanShape = {
      kind: 'ellipse',
      x: r4(p.x),
      y: r4(p.z),
      rx: r4(hx),
      ry: r4(hz),
      // A turn of +θ about the vertical axis reads as −θ in the y-down plan frame.
      rotation: Math.abs(hx - hz) < 1e-6 ? 0 : -(p.rot?.[1] ?? 0),
      ...paint,
    };
    const out: Outline = { shape, hull, top };
    if (p.shape === 'torus' && (p.r ?? 0) - (p.r2 ?? 0) > MIN_SIZE) {
      const inner = r4((p.r ?? 0) - (p.r2 ?? 0));
      out.extra = { kind: 'ellipse', x: shape.x, y: shape.y, rx: inner, ry: inner, rotation: 0, ...paint, hole: true };
    }
    return out;
  }
  return { shape: { kind: 'poly', points: hull.flatMap((q) => [r4(q[0]), r4(q[1])]), ...paint }, hull, top };
}

/** The hull's corners, the middles of its edges and its center: enough to tell "covered" from "corners covered". */
function probes(hull: P2[]): P2[] {
  const out: P2[] = [];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    out.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    cx += a[0];
    cy += a[1];
  }
  out.push([cx / hull.length, cy / hull.length]);
  return out;
}

const cache = new WeakMap<FurnitureDef, PlanShape[]>();

/** A definition seen from above: its visible parts, lowest first (tallest drawn last, on top). */
export function planShapes(def: FurnitureDef): PlanShape[] {
  const hit = cache.get(def);
  if (hit) return hit;

  const outlines: Outline[] = [];
  for (const part of def.parts ?? []) {
    const o = outlineOf(part);
    if (o) outlines.push(o);
  }

  // Leave out anything that sits wholly under taller parts (table legs under
  // the top, a lamp's pole under its shade). Ties keep the earlier part.
  const visible = outlines.filter((o, i) => {
    const above = outlines.filter((q, j) => {
      if (i === j) return false;
      return q.top > o.top + 1e-4 || (Math.abs(q.top - o.top) <= 1e-4 && j < i);
    });
    if (above.length === 0) return true;
    return !probes(o.hull).every((pt) => above.some((q) => insideConvex(pt, q.hull, 0.002)));
  });

  visible.sort((a, b) => a.top - b.top);
  const shapes: PlanShape[] = [];
  for (const o of visible.slice(-MAX_SHAPES)) {
    shapes.push(o.shape);
    if (o.extra) shapes.push(o.extra);
  }
  cache.set(def, shapes);
  return shapes;
}

/** Trace every solid shape into one canvas path (sub-paths all wind the same way, so they union). */
export function traceShapes(ctx: CanvasRenderingContext2D, shapes: PlanShape[]): void {
  ctx.beginPath();
  for (const s of shapes) {
    if (s.hole) continue;
    traceShape(ctx, s);
  }
}

/** Add one shape to the current path as a closed sub-path. */
export function traceShape(ctx: CanvasRenderingContext2D, s: PlanShape): void {
  if (s.kind === 'poly') {
    const p = s.points;
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
  } else {
    ctx.moveTo(
      s.x + Math.cos((s.rotation * Math.PI) / 180) * s.rx,
      s.y + Math.sin((s.rotation * Math.PI) / 180) * s.rx,
    );
    ctx.ellipse(s.x, s.y, s.rx, s.ry, (s.rotation * Math.PI) / 180, 0, Math.PI * 2);
    ctx.closePath();
  }
}
