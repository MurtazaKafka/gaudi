/**
 * Outlines: the closed loop of walls a person drew, read as a footprint that
 * rooms can be fitted into — its polygon, the rectangles it is made of, and
 * what to do when it is not made of rectangles. Also the small amount of
 * rectangle-set geometry the mask-filling engine needs. Pure — no store.
 */
import { pointInPolygon } from '../geometry';
import { detectRooms } from '../rooms';
import type { Point, Wall } from '../types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EPS = 1e-6;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** Two coordinates closer than this are the same line. */
const SAME = 0.002;
/** A step in an outline narrower than this can't hold a room. */
export const MIN_STEP = 1;

/* ------------------------------------------------------------------ */
/* Cell grids: a region as on/off cells between its own coordinates     */
/* ------------------------------------------------------------------ */

export interface Cells {
  xs: number[];
  ys: number[];
  /** on[j][i]: the cell between xs[i]..xs[i+1] and ys[j]..ys[j+1] is inside */
  on: boolean[][];
}

function uniqueSorted(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out.length === 0 || v - out[out.length - 1] > EPS) out.push(v);
  return out;
}

export function cellsFromRects(rects: readonly Rect[], extra: readonly Rect[] = []): Cells {
  const all = [...rects, ...extra];
  const xs = uniqueSorted(all.flatMap((r) => [r.x, r.x + r.w]));
  const ys = uniqueSorted(all.flatMap((r) => [r.y, r.y + r.h]));
  const on: boolean[][] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    const row: boolean[] = [];
    const cy = (ys[j] + ys[j + 1]) / 2;
    for (let i = 0; i + 1 < xs.length; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      row.push(rects.some((r) => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h));
    }
    on.push(row);
  }
  return { xs, ys, on };
}

export function cellsFromPolygon(poly: readonly Point[]): Cells {
  const xs = uniqueSorted(poly.map((p) => p.x));
  const ys = uniqueSorted(poly.map((p) => p.y));
  const pts = poly as Point[];
  const on: boolean[][] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    const row: boolean[] = [];
    for (let i = 0; i + 1 < xs.length; i++) {
      row.push(pointInPolygon({ x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 }, pts));
    }
    on.push(row);
  }
  return { xs, ys, on };
}

function transposeCells(c: Cells): Cells {
  const on: boolean[][] = [];
  for (let i = 0; i + 1 < c.xs.length; i++) {
    const row: boolean[] = [];
    for (let j = 0; j + 1 < c.ys.length; j++) row.push(c.on[j][i]);
    on.push(row);
  }
  return { xs: c.ys, ys: c.xs, on };
}

/**
 * Cut a region into rectangles with horizontal cuts only (`horizontal`) or
 * vertical cuts only: runs of cells in each band, joined to the run in the
 * next band when they span exactly the same range.
 */
export function slabs(cells: Cells, horizontal = true): Rect[] {
  if (!horizontal) return slabs(transposeCells(cells), true).map((r) => ({ x: r.y, y: r.x, w: r.h, h: r.w }));
  const out: Rect[] = [];
  let open = new Map<string, Rect>();
  for (let j = 0; j < cells.on.length; j++) {
    const next = new Map<string, Rect>();
    const row = cells.on[j];
    let i = 0;
    while (i < row.length) {
      if (!row[i]) {
        i++;
        continue;
      }
      let k = i;
      while (k < row.length && row[k]) k++;
      const x0 = cells.xs[i];
      const x1 = cells.xs[k];
      const key = `${i}|${k}`;
      const above = open.get(key);
      if (above) {
        above.h = r3(cells.ys[j + 1] - above.y);
        next.set(key, above);
      } else {
        const rect = { x: x0, y: cells.ys[j], w: r3(x1 - x0), h: r3(cells.ys[j + 1] - cells.ys[j]) };
        out.push(rect);
        next.set(key, rect);
      }
      i = k;
    }
    open = next;
  }
  return out;
}

/** Cut a region into rectangles by taking the largest one that fits, again and again. */
export function largestFirst(cells: Cells): Rect[] {
  const rows = cells.on.length;
  const cols = rows ? cells.on[0].length : 0;
  const free = cells.on.map((r) => r.slice());
  const out: Rect[] = [];
  for (let guard = 0; guard < 64; guard++) {
    let best: { i0: number; i1: number; j0: number; j1: number; area: number } | null = null;
    for (let j0 = 0; j0 < rows; j0++) {
      // widest run of free cells in every column range, grown row by row
      const ok = new Array<boolean>(cols).fill(true);
      for (let j1 = j0; j1 < rows; j1++) {
        for (let i = 0; i < cols; i++) ok[i] = ok[i] && free[j1][i];
        let i = 0;
        while (i < cols) {
          if (!ok[i]) {
            i++;
            continue;
          }
          let k = i;
          while (k < cols && ok[k]) k++;
          const area = (cells.xs[k] - cells.xs[i]) * (cells.ys[j1 + 1] - cells.ys[j0]);
          if (!best || area > best.area + EPS) best = { i0: i, i1: k, j0, j1: j1 + 1, area };
          i = k;
        }
      }
    }
    if (!best) break;
    for (let j = best.j0; j < best.j1; j++) for (let i = best.i0; i < best.i1; i++) free[j][i] = false;
    out.push({
      x: cells.xs[best.i0],
      y: cells.ys[best.j0],
      w: r3(cells.xs[best.i1] - cells.xs[best.i0]),
      h: r3(cells.ys[best.j1] - cells.ys[best.j0]),
    });
  }
  return out;
}

export const rectArea = (r: Rect): number => r.w * r.h;
export const rectsArea = (rects: readonly Rect[]): number => rects.reduce((s, r) => s + r.w * r.h, 0);

/** Area two rectangles have in common. */
export function rectOverlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > EPS && h > EPS ? w * h : 0;
}

/** How much of `r` (m²) lies outside a region given as disjoint rectangles. */
export function areaOutside(r: Rect, region: readonly Rect[]): number {
  let inside = 0;
  for (const m of region) inside += rectOverlap(r, m);
  return Math.max(0, r.w * r.h - inside);
}

/** `region` minus `holes`, as horizontal slabs. */
export function subtractRects(region: readonly Rect[], holes: readonly Rect[]): Rect[] {
  if (holes.length === 0) return slabs(cellsFromRects(region));
  const cells = cellsFromRects(region, holes);
  for (let j = 0; j < cells.on.length; j++) {
    const cy = (cells.ys[j] + cells.ys[j + 1]) / 2;
    for (let i = 0; i < cells.on[j].length; i++) {
      if (!cells.on[j][i]) continue;
      const cx = (cells.xs[i] + cells.xs[i + 1]) / 2;
      if (holes.some((h) => cx > h.x && cx < h.x + h.w && cy > h.y && cy < h.y + h.h)) cells.on[j][i] = false;
    }
  }
  return slabs(cells);
}

/** Signed area: positive for a loop that runs clockwise on screen (y down). */
export function polygonArea(poly: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** Drop repeated points and points in the middle of a straight run (or at the tip of a zero-width spike). */
export function tidyPolygon(poly: readonly Point[]): Point[] {
  let pts = poly.map((p) => ({ x: p.x, y: p.y }));
  for (let guard = 0; guard < 200; guard++) {
    let changed = false;
    const next: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = next.length ? next[next.length - 1] : pts[(i - 1 + pts.length) % pts.length];
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const same = Math.abs(p.x - prev.x) < SAME && Math.abs(p.y - prev.y) < SAME;
      const cross = (p.x - prev.x) * (q.y - p.y) - (p.y - prev.y) * (q.x - p.x);
      const scale = Math.hypot(p.x - prev.x, p.y - prev.y) * Math.hypot(q.x - p.x, q.y - p.y);
      if (same || Math.abs(cross) < 1e-7 + 1e-6 * scale) {
        changed = true;
        continue;
      }
      next.push(p);
    }
    pts = next;
    if (!changed || pts.length < 3) break;
  }
  return pts;
}

/**
 * The boundary of a cell region as loops of corner points. Outer boundaries
 * run clockwise on screen (positive `polygonArea`), holes the other way.
 */
export function boundaryLoops(cells: Cells): Point[][] {
  interface Edge {
    ax: number; ay: number; bx: number; by: number; used: boolean;
  }
  const rows = cells.on.length;
  const cols = rows ? cells.on[0].length : 0;
  const on = (i: number, j: number) => j >= 0 && j < rows && i >= 0 && i < cols && cells.on[j][i];
  const edges: Edge[] = [];
  const from = new Map<string, Edge[]>();
  const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const e = { ax, ay, bx, by, used: false };
    edges.push(e);
    const k = key(ax, ay);
    const list = from.get(k);
    if (list) list.push(e);
    else from.set(k, [e]);
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!cells.on[j][i]) continue;
      const x0 = cells.xs[i], x1 = cells.xs[i + 1], y0 = cells.ys[j], y1 = cells.ys[j + 1];
      // Directed so the inside is on the right-hand side.
      if (!on(i, j - 1)) add(x0, y0, x1, y0);
      if (!on(i + 1, j)) add(x1, y0, x1, y1);
      if (!on(i, j + 1)) add(x1, y1, x0, y1);
      if (!on(i - 1, j)) add(x0, y1, x0, y0);
    }
  }
  const loops: Point[][] = [];
  for (const start of edges) {
    if (start.used) continue;
    const pts: Point[] = [];
    let e: Edge | undefined = start;
    let guard = edges.length + 2;
    while (e && !e.used && guard-- > 0) {
      e.used = true;
      pts.push({ x: e.ax, y: e.ay });
      const dx = e.bx - e.ax;
      const dy = e.by - e.ay;
      const options: Edge[] = (from.get(key(e.bx, e.by)) ?? []).filter((o) => !o.used);
      // Where two cells touch only at a corner, turn right to stay with the same cell.
      let best: Edge | undefined;
      let bestTurn = -Infinity;
      for (const o of options) {
        const turn = dx * (o.by - o.ay) - dy * (o.bx - o.ax);
        if (turn > bestTurn) {
          bestTurn = turn;
          best = o;
        }
      }
      e = best;
    }
    const tidy = tidyPolygon(pts);
    if (tidy.length >= 4) loops.push(tidy);
  }
  return loops;
}

/** The single outer boundary of a set of rectangles, or null if they make several pieces or leave a hole. */
export function unionOutline(rects: readonly Rect[]): Point[] | null {
  const loops = boundaryLoops(cellsFromRects(rects));
  return loops.length === 1 && polygonArea(loops[0]) > 0 ? loops[0] : null;
}

/* ------------------------------------------------------------------ */
/* Reading an outline off the canvas                                    */
/* ------------------------------------------------------------------ */

export interface Outline {
  /** Corner points, clockwise on screen, to the millimetre, no point mid-wall. */
  polygon: Point[];
  /** m² */
  area: number;
  box: Rect;
  /** The rectangles it is made of (horizontal cuts). Empty unless `issue` is null. */
  rects: Rect[];
  /**
   * Why rooms can't be fitted as it stands: 'angled' — a wall runs neither
   * north–south nor east–west; 'fine' — a step narrower than a room.
   */
  issue: 'angled' | 'fine' | null;
  /** Changes whenever the shape does. */
  key: string;
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Pull coordinates that are the same line (within 2 mm) onto one value. */
function canon(values: number[]): (v: number) => number {
  const sorted = values.slice().sort((a, b) => a - b);
  const groups: number[] = [];
  for (const v of sorted) if (groups.length === 0 || v - groups[groups.length - 1] > SAME) groups.push(v);
  return (v) => {
    let best = groups[0];
    for (const g of groups) if (Math.abs(g - v) < Math.abs(best - v)) best = g;
    return Math.abs(best - v) <= SAME * 1.01 ? best : v;
  };
}

export function isRectilinear(poly: readonly Point[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (Math.abs(p.x - q.x) > SAME && Math.abs(p.y - q.y) > SAME) return false;
  }
  return poly.length >= 4;
}

function boxOf(poly: readonly Point[]): Rect {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: r3(Math.max(...xs) - x), h: r3(Math.max(...ys) - y) };
}

/** Describe a closed polygon as an outline (works out whether rooms can be fitted into it). */
export function outlineFromPolygon(raw: readonly Point[]): Outline | null {
  let polygon = tidyPolygon(raw.map((p) => ({ x: r3(p.x), y: r3(p.y) })));
  if (polygon.length < 3) return null;
  if (polygonArea(polygon) < 0) polygon = polygon.slice().reverse();
  const area = polygonArea(polygon);
  if (area < 1) return null;
  const key = polygon.map((p) => `${p.x},${p.y}`).join(' ');
  if (!isRectilinear(polygon)) return { polygon, area, box: boxOf(polygon), rects: [], issue: 'angled', key };
  const cx = canon(polygon.map((p) => p.x));
  const cy = canon(polygon.map((p) => p.y));
  polygon = tidyPolygon(polygon.map((p) => ({ x: cx(p.x), y: cy(p.y) })));
  if (polygon.length < 4) return null;
  const cells = cellsFromPolygon(polygon);
  const rects = slabs(cells, true);
  const cross = slabs(cells, false);
  const thin = [...rects, ...cross].some((r) => Math.min(r.w, r.h) < MIN_STEP - EPS);
  return {
    polygon,
    area: polygonArea(polygon),
    box: boxOf(polygon),
    rects: thin ? [] : rects,
    issue: thin ? 'fine' : null,
    key,
  };
}

/**
 * The outline on the canvas, if that is all there is: walls forming exactly
 * one closed loop, with no wall inside it, hanging off it or standing apart.
 */
export function readOutline(walls: readonly Wall[]): Outline | null {
  if (walls.length < 3 || walls.length > 80) return null;
  const rooms = detectRooms(walls as Wall[]);
  if (rooms.length !== 1) return null;
  const poly = rooms[0].polygon;
  if (poly.length < 3) return null;
  const onBoundary = (p: Point) => {
    for (let i = 0; i < poly.length; i++) {
      if (distToSeg(p, poly[i], poly[(i + 1) % poly.length]) < 0.005) return true;
    }
    return false;
  };
  for (const w of walls) {
    const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    if (!onBoundary(w.a) || !onBoundary(w.b) || !onBoundary(mid)) return null;
  }
  return outlineFromPolygon(poly);
}

/* ------------------------------------------------------------------ */
/* Squaring an outline off                                              */
/* ------------------------------------------------------------------ */

const GRID = 0.5;
const snapG = (v: number) => Math.round(v / GRID) * GRID;

function validSquare(poly: readonly Point[]): boolean {
  if (poly.length < 4 || !isRectilinear(poly)) return false;
  const area = polygonArea(poly);
  if (area < 4) return false;
  const cells = cellsFromPolygon(poly);
  const loops = boundaryLoops(cells);
  if (loops.length !== 1) return false;
  const rects = slabs(cells, true);
  if (Math.abs(rectsArea(rects) - area) > 1e-4) return false;
  return ![...rects, ...slabs(cells, false)].some((r) => Math.min(r.w, r.h) < MIN_STEP - EPS);
}

/** Slide walls shorter than a room's width out of a square-cornered outline, one at a time. */
function collapseShort(poly: Point[]): Point[] {
  let pts = tidyPolygon(poly);
  for (let guard = 0; guard < 120; guard++) {
    const n = pts.length;
    if (n < 4) return pts;
    let pick = -1;
    let shortest = MIN_STEP - EPS;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (len < shortest) {
        shortest = len;
        pick = i;
      }
    }
    if (pick < 0) return pts;
    const i0 = (pick - 1 + n) % n;
    const i1 = pick;
    const i2 = (pick + 1) % n;
    const i3 = (pick + 2) % n;
    const len = (p: Point, q: Point) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
    const next = pts.map((p) => ({ ...p }));
    const horizontal = Math.abs(pts[i1].y - pts[i2].y) < SAME;
    // Move whichever neighbouring wall is shorter (it changes the shape least).
    if (len(pts[i0], pts[i1]) <= len(pts[i2], pts[i3])) {
      if (horizontal) next[i0].x = next[i1].x = pts[i2].x;
      else next[i0].y = next[i1].y = pts[i2].y;
    } else if (horizontal) next[i2].x = next[i3].x = pts[i1].x;
    else next[i2].y = next[i3].y = pts[i1].y;
    pts = tidyPolygon(next);
  }
  return pts;
}

/**
 * A square-cornered version of any outline, on the half-metre grid: each
 * angled wall becomes a corner (cut inside the outline where there is a
 * choice) and steps too small for a room are straightened. Falls back to the
 * bounding rectangle when the shape can't be kept.
 */
export function squareOff(raw: readonly Point[]): Point[] {
  let poly = tidyPolygon(raw);
  if (polygonArea(poly) < 0) poly = poly.slice().reverse();
  const stepped: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    stepped.push(p);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    if (Math.abs(dx) <= SAME || Math.abs(dy) <= SAME) continue;
    // A long slope becomes a few steps (each wide enough for a room), a short one a single corner.
    const steps = Math.min(4, Math.max(1, Math.floor(Math.min(Math.abs(dx), Math.abs(dy)) / 3)));
    const at = (t: number): Point => ({ x: p.x + dx * t, y: p.y + dy * t });
    const b1 = at(1 / steps);
    const inside = (c: Point) => pointInPolygon({ x: (p.x + b1.x + c.x) / 3, y: (p.y + b1.y + c.y) / 3 }, poly);
    // Stepping inside the outline keeps the result within what was drawn.
    const xFirst = inside({ x: b1.x, y: p.y }) || !inside({ x: p.x, y: b1.y });
    for (let k = 0; k < steps; k++) {
      const a = at(k / steps);
      const b = at((k + 1) / steps);
      if (k > 0) stepped.push(a);
      stepped.push(xFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    }
  }
  const snapped = collapseShort(stepped.map((p) => ({ x: snapG(p.x), y: snapG(p.y) })));
  let out = snapped;
  if (polygonArea(out) < 0) out = out.slice().reverse();
  if (validSquare(out)) return out.map((p) => ({ x: r3(p.x), y: r3(p.y) }));
  const b = boxOf(poly);
  const x0 = snapG(b.x);
  const y0 = snapG(b.y);
  const x1 = Math.max(x0 + 3, snapG(b.x + b.w));
  const y1 = Math.max(y0 + 3, snapG(b.y + b.h));
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** The wall segments of a closed polygon, corner to corner. */
export function outlineSegments(poly: readonly Point[]): { a: Point; b: Point }[] {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return { a: { x: p.x, y: p.y }, b: { x: q.x, y: q.y } };
  });
}
