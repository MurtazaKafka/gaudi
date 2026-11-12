/**
 * The ground a roof has to cover: the union of the roofed rooms as clean
 * outlines (with holes for courtyards), and the rectangle maths the roof
 * builders share. Pure numbers — no three.js, no store.
 *
 * Plan space throughout: x east, y south. Outer loops come out with positive
 * shoelace area (the same sense as detected rooms), holes negative.
 */
import type { Point } from '../types';
import { pointInPolygon } from '../geometry';
import { roomKindFromName } from '../roomTypes';

/** One connected piece of footprint. */
export interface Region {
  outer: Point[];
  holes: Point[][];
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Points closer than this are the same point (m). */
const WELD = 1.5e-3;

export function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

const finitePoint = (p: Point | undefined | null): p is Point =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/** Drop repeated points and points lying on a straight run (or at the tip of a zero-width spike). */
export function simplifyLoop(loop: Point[]): Point[] {
  const pts = loop.filter(finitePoint);
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length >= 3; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const ax = cur.x - prev.x;
      const ay = cur.y - prev.y;
      const bx = next.x - cur.x;
      const by = next.y - cur.y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < WELD || lb < WELD || Math.abs(ax * by - ay * bx) <= 1e-6 * la * lb + 1e-9) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts.length >= 3 ? pts : [];
}

export function pointInRegion(p: Point, region: Region): boolean {
  return pointInPolygon(p, region.outer) && !region.holes.some((h) => pointInPolygon(p, h));
}

export function pointInRegions(p: Point, regions: Region[]): boolean {
  return regions.some((r) => pointInRegion(p, r));
}

export function regionArea(region: Region): number {
  return Math.abs(signedArea(region.outer)) - region.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
}

// ---------- union ----------

/**
 * The union of polygons that meet edge to edge (rooms of one plan, cells of a
 * grid): edges two polygons share cancel, what is left is chained into loops.
 * Polygons that only touch at a corner stay separate regions.
 */
export function unionRegions(polys: Point[][]): Region[] {
  const weld: Point[] = [];
  const idOf = (p: Point): number => {
    for (let i = 0; i < weld.length; i++) {
      if (Math.abs(weld[i].x - p.x) < WELD && Math.abs(weld[i].y - p.y) < WELD) return i;
    }
    weld.push({ x: p.x, y: p.y });
    return weld.length - 1;
  };

  const loops: number[][] = [];
  for (const raw of polys) {
    const pts = (raw ?? []).filter(finitePoint);
    if (pts.length < 3) continue;
    let ids = pts.map(idOf);
    ids = ids.filter((id, i) => id !== ids[(i + 1) % ids.length]);
    if (ids.length < 3) continue;
    const area = signedArea(ids.map((i) => weld[i]));
    if (Math.abs(area) < 1e-6) continue;
    if (area < 0) ids.reverse();
    loops.push(ids);
  }

  // Directed edges, split wherever another polygon's corner lies on them, so
  // a long wall shared with two shorter ones still cancels.
  const edges = new Map<string, [number, number]>();
  for (const ids of loops) {
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      const A = weld[a];
      const B = weld[b];
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      const ux = (B.x - A.x) / len;
      const uy = (B.y - A.y) / len;
      const on: { t: number; id: number }[] = [];
      for (let k = 0; k < weld.length; k++) {
        if (k === a || k === b) continue;
        const P = weld[k];
        const t = (P.x - A.x) * ux + (P.y - A.y) * uy;
        if (t <= WELD || t >= len - WELD) continue;
        if (Math.abs((P.x - A.x) * uy - (P.y - A.y) * ux) < WELD) on.push({ t, id: k });
      }
      on.sort((p, q) => p.t - q.t);
      const chain = [a, ...on.map((o) => o.id), b];
      for (let k = 0; k < chain.length - 1; k++) {
        const p = chain[k];
        const q = chain[k + 1];
        if (p === q) continue;
        if (edges.delete(`${q}>${p}`)) continue;
        edges.set(`${p}>${q}`, [p, q]);
      }
    }
  }

  const outgoing = new Map<number, [number, number][]>();
  for (const e of edges.values()) {
    const list = outgoing.get(e[0]);
    if (list) list.push(e);
    else outgoing.set(e[0], [e]);
  }
  const keyOf = (e: [number, number]): string => `${e[0]}>${e[1]}`;
  const TWO_PI = Math.PI * 2;

  const used = new Set<string>();
  const outers: Point[][] = [];
  const holes: Point[][] = [];
  for (const start of edges.values()) {
    if (used.has(keyOf(start))) continue;
    const loop: number[] = [];
    let cur: [number, number] | undefined = start;
    let closed = false;
    for (let guard = 0; cur && guard <= edges.size; guard++) {
      used.add(keyOf(cur));
      loop.push(cur[0]);
      const from = weld[cur[0]];
      const at = weld[cur[1]];
      // Where several loops pinch together, keep hugging this one's interior.
      const back = Math.atan2(from.y - at.y, from.x - at.x);
      let best: [number, number] | undefined;
      let bestDelta = Infinity;
      for (const c of outgoing.get(cur[1]) ?? []) {
        const to = weld[c[1]];
        let delta = (back - Math.atan2(to.y - at.y, to.x - at.x)) % TWO_PI;
        if (delta < 0) delta += TWO_PI;
        if (delta < 1e-9) delta = TWO_PI;
        if (delta < bestDelta) {
          bestDelta = delta;
          best = c;
        }
      }
      if (best === start) {
        closed = true;
        break;
      }
      if (!best || used.has(keyOf(best))) break;
      cur = best;
    }
    if (!closed || loop.length < 3) continue;
    const raw = loop.map((i) => weld[i]);
    const pts = simplifyLoop(raw);
    if (pts.length < 3) continue;
    const area = signedArea(pts);
    if (area > 1e-4) outers.push(pts);
    else if (area < -1e-4) holes.push(pts);
  }

  const regions: Region[] = outers.map((outer) => ({ outer, holes: [] }));
  for (const hole of holes) {
    const probe = pointInside(hole);
    let home: Region | null = null;
    let homeArea = Infinity;
    for (const r of regions) {
      const a = Math.abs(signedArea(r.outer));
      if (a < homeArea && pointInPolygon(probe, r.outer)) {
        home = r;
        homeArea = a;
      }
    }
    home?.holes.push(hole);
  }
  return regions;
}

/** Some point strictly inside a simple polygon. */
export function pointInside(poly: Point[]): Point {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const nx = (-(b.y - a.y) / len) * 4e-3;
    const ny = ((b.x - a.x) / len) * 4e-3;
    for (const s of [1, -1]) {
      const p = { x: mx + nx * s, y: my + ny * s };
      if (pointInPolygon(p, poly)) return p;
    }
  }
  return poly[0] ?? { x: 0, y: 0 };
}

// ---------- which rooms are under the roof ----------

/**
 * Rooms that are open to the sky: anything named as an outdoor space (patio,
 * courtyard, deck…), and an unnamed space closed in on every side by named
 * rooms — the court a generated courtyard house wraps around.
 */
export function openAirRooms(
  rooms: { key: string; polygon: Point[] }[],
  roomNames: Record<string, string> | undefined | null,
): Set<string> {
  const names = roomNames ?? {};
  const open = new Set<string>();
  const nameOf = (key: string): string => (typeof names[key] === 'string' ? names[key].trim() : '');
  for (const r of rooms) if (nameOf(r.key) && roomKindFromName(nameOf(r.key)) === 'outdoor') open.add(r.key);

  const unnamed = rooms.filter((r) => !nameOf(r.key));
  if (unnamed.length === 0 || unnamed.length === rooms.length) return open;

  // Corner-to-corner sides of every room, to see who is on the other side of each.
  const sides: { room: number; a: Point; b: Point }[] = [];
  rooms.forEach((r, room) => {
    const sign = signedArea(r.polygon) >= 0 ? 1 : -1;
    const pts = sign > 0 ? r.polygon : r.polygon.slice().reverse();
    pts.forEach((a, i) => sides.push({ room, a, b: pts[(i + 1) % pts.length] }));
  });
  const neighbourAt = (room: number, p: Point, nx: number, ny: number): number => {
    // Just across the wall line, whose room is it?
    const q = { x: p.x + nx * 0.02, y: p.y + ny * 0.02 };
    for (let i = 0; i < rooms.length; i++) if (i !== room && pointInPolygon(q, rooms[i].polygon)) return i;
    return -1;
  };

  for (const r of unnamed) {
    const index = rooms.indexOf(r);
    let enclosed = true;
    for (const s of sides) {
      if (s.room !== index) continue;
      const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      if (len < 0.05) continue;
      // Outward normal for a positively wound loop in y-down plan space.
      const nx = (s.b.y - s.a.y) / len;
      const ny = -(s.b.x - s.a.x) / len;
      const steps = Math.max(1, Math.min(24, Math.ceil(len / 0.5)));
      for (let k = 0; k < steps && enclosed; k++) {
        const t = (k + 0.5) / steps;
        const p = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
        const other = neighbourAt(index, p, nx, ny);
        if (other < 0 || !nameOf(rooms[other].key)) enclosed = false;
      }
      if (!enclosed) break;
    }
    if (enclosed) open.add(r.key);
  }
  return open;
}

/** The footprint under the roof: every room that is not open to the sky, as one outline per building. */
export function roofFootprint(
  rooms: { key?: string; polygon: Point[] }[],
  open?: ReadonlySet<string> | null,
): Region[] {
  return unionRegions(rooms.filter((r) => !(r.key !== undefined && open?.has(r.key))).map((r) => r.polygon));
}

// ---------- rectilinear footprints ----------

const rotate = (p: Point, c: number, s: number): Point => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });

export function rotateLoop(loop: Point[], angle: number): Point[] {
  if (angle === 0) return loop;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return loop.map((p) => rotate(p, c, s));
}

export function rotateRegions(regions: Region[], angle: number): Region[] {
  if (angle === 0) return regions;
  return regions.map((r) => ({ outer: rotateLoop(r.outer, angle), holes: r.holes.map((h) => rotateLoop(h, angle)) }));
}

/**
 * If every edge runs along one of two perpendicular directions, the angle
 * (radians, −45°…45°) of that frame; null when the outline has angled walls.
 */
export function gridAngle(regions: Region[]): number | null {
  const QUARTER = Math.PI / 2;
  const fold = (a: number): number => {
    let r = a % QUARTER;
    if (r > QUARTER / 2) r -= QUARTER;
    if (r <= -QUARTER / 2) r += QUARTER;
    return r;
  };
  let longest = 0;
  let angle = 0;
  const edges: number[] = [];
  for (const region of regions) {
    for (const loop of [region.outer, ...region.holes]) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 0.02) continue;
        const f = fold(Math.atan2(b.y - a.y, b.x - a.x));
        edges.push(f);
        if (len > longest) {
          longest = len;
          angle = f;
        }
      }
    }
  }
  if (edges.length === 0) return null;
  const TOLERANCE = 0.006;
  for (const f of edges) {
    let d = Math.abs(f - angle);
    if (d > QUARTER / 2) d = QUARTER - d;
    if (d > TOLERANCE) return null;
  }
  return Math.abs(angle) < 1e-4 ? 0 : angle;
}

/** A rectilinear shape as cells between sorted coordinates: `inside[row][col]`. */
export interface Grid {
  xs: number[];
  ys: number[];
  inside: boolean[][];
}

function sortedUnique(values: number[]): number[] {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out.length === 0 || v - out[out.length - 1] > WELD) out.push(v);
  return out;
}

function gridOf(xs: number[], ys: number[], test: (p: Point) => boolean): Grid {
  const inside: boolean[][] = [];
  for (let r = 0; r < ys.length - 1; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < xs.length - 1; c++) {
      row.push(test({ x: (xs[c] + xs[c + 1]) / 2, y: (ys[r] + ys[r + 1]) / 2 }));
    }
    inside.push(row);
  }
  return { xs, ys, inside };
}

/** Cells of an axis-aligned footprint. */
export function regionGrid(regions: Region[]): Grid {
  const pts = regions.flatMap((r) => [r.outer, ...r.holes].flat());
  return gridOf(sortedUnique(pts.map((p) => p.x)), sortedUnique(pts.map((p) => p.y)), (p) => pointInRegions(p, regions));
}

export interface CellRect extends Rect {
  /** Inclusive cell ranges in the grid it came from. */
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** Every rectangle of inside cells that cannot grow in any direction. */
export function maximalRects(grid: Grid): CellRect[] {
  const { xs, ys, inside } = grid;
  const rows = inside.length;
  const cols = rows > 0 ? inside[0].length : 0;
  const out: CellRect[] = [];
  const full = (r: number, c0: number, c1: number): boolean => {
    for (let c = c0; c <= c1; c++) if (!inside[r][c]) return false;
    return true;
  };
  for (let r0 = 0; r0 < rows; r0++) {
    const ok: boolean[] = new Array<boolean>(cols).fill(true);
    for (let r1 = r0; r1 < rows; r1++) {
      let any = false;
      for (let c = 0; c < cols; c++) {
        ok[c] = ok[c] && inside[r1][c];
        any = any || ok[c];
      }
      if (!any) break;
      let c = 0;
      while (c < cols) {
        if (!ok[c]) {
          c++;
          continue;
        }
        const c0 = c;
        while (c < cols && ok[c]) c++;
        const c1 = c - 1;
        const up = r0 > 0 && full(r0 - 1, c0, c1);
        const down = r1 < rows - 1 && full(r1 + 1, c0, c1);
        if (!up && !down) out.push({ x0: xs[c0], x1: xs[c1 + 1], y0: ys[r0], y1: ys[r1 + 1], r0, r1, c0, c1 });
      }
    }
  }
  return out;
}

/** The union of axis-aligned rectangles as clean outlines. */
export function rectsToRegions(rects: Rect[]): Region[] {
  const good = rects.filter((r) => r.x1 - r.x0 > WELD && r.y1 - r.y0 > WELD);
  if (good.length === 0) return [];
  const xs = sortedUnique(good.flatMap((r) => [r.x0, r.x1]));
  const ys = sortedUnique(good.flatMap((r) => [r.y0, r.y1]));
  const grid = gridOf(xs, ys, (p) => good.some((r) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1));
  const strips: Point[][] = [];
  grid.inside.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < row.length && row[c]) c++;
      strips.push([
        { x: xs[c0], y: ys[r] },
        { x: xs[c], y: ys[r] },
        { x: xs[c], y: ys[r + 1] },
        { x: xs[c0], y: ys[r + 1] },
      ]);
    }
  });
  return unionRegions(strips);
}

/** Grow an axis-aligned footprint by `d` on every side, corners kept square. Narrow gaps close up. */
export function growRegions(regions: Region[], d: number): Region[] {
  const rects = maximalRects(regionGrid(regions));
  return rectsToRegions(rects.map((r) => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d })));
}

// ---------- free-angle outlines ----------

/**
 * Grow (d > 0) or shrink a simple polygon by `d`, keeping corners sharp, one
 * output corner per input corner. Very sharp corners are capped so a spike
 * can't shoot off.
 */
export function offsetLoop(poly: Point[], d: number): Point[] {
  const n = poly.length;
  if (n < 3) return poly.slice();
  const sign = signedArea(poly) >= 0 ? 1 : -1;
  const normal = (a: Point, b: Point): Point => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (sign * (b.y - a.y)) / len, y: (-sign * (b.x - a.x)) / len };
  };
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const n1 = normal(prev, cur);
    const n2 = normal(cur, next);
    const k = Math.max(0.3, 1 + n1.x * n2.x + n1.y * n2.y);
    out.push({ x: cur.x + ((n1.x + n2.x) * d) / k, y: cur.y + ((n1.y + n2.y) * d) / k });
  }
  return out;
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** No edge crosses another. */
export function isSimpleLoop(poly: Point[]): boolean {
  const n = poly.length;
  if (n < 3 || !poly.every(finitePoint)) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * `offsetLoop`, but never returns a tangle: the distance is backed off until
 * the result is a clean loop wound the same way (at worst, the input itself).
 */
export function safeOffset(poly: Point[], d: number): Point[] {
  const sign = Math.sign(signedArea(poly));
  for (const k of [1, 0.6, 0.35, 0.15]) {
    const out = offsetLoop(poly, d * k);
    if (out.length === poly.length && isSimpleLoop(out) && Math.sign(signedArea(out)) === sign) return out;
  }
  return poly.slice();
}
