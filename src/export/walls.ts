/**
 * Walls as drawn on paper and in CAD: the true-thickness wall body.
 *
 * The centerlines become a planar graph (split where walls tee into or cross
 * each other). Around every joint the body is divided like a pie — each wall
 * arm owns the wedge between its two mitre lines — so the pieces tile the body
 * exactly: no notches, no overlaps, whatever the angle. Openings cut real gaps.
 * From the tiles come (a) the outline loops, for poché fills and CAD
 * polylines, and (b) one footprint per wall, for BIM solids.
 *
 * Pure: no store, no DOM.
 */
import type { Opening, OpeningType, Point, Wall } from '../types';

const MIN_LEN = 0.01;
/** Endpoints closer than this are one joint (m). */
const NODE_TOL = 0.012;
/** A sharp outside corner is cut off (bevelled) past this many half-thicknesses. */
const MITRE_LIMIT = 4;
/** Openings keep this clear of a joint's mitre (m). */
const JOINT_CLEAR = 0.005;
/**
 * Most joints made where walls cross. n walls can cross n²/4 times (2,000 walls: a million
 * joints, gigabytes of tiles), far beyond any building; past this many the rest simply
 * overlap un-jointed, which fills the same and only loses the tidy outline (`clean` is false).
 */
const MAX_CROSSINGS = 20_000;

export type EdgeKind = 'side' | 'jamb' | 'free' | 'bevel' | 'mitre';

/** One piece of wall body. `kinds[i]` describes the edge poly[i] → poly[i+1]; 'mitre' edges are internal. */
export interface WallTile {
  wallId: string;
  poly: Point[];
  kinds: EdgeKind[];
}

/** An opening as actually cut. */
export interface WallGap {
  id: string;
  wallId: string;
  type: OpeningType;
  label?: string;
  /** On the wall's centerline. */
  center: Point;
  /** Unit vector along the wall, A → B. */
  dir: Point;
  /** Unit normal: `dir` turned a quarter clockwise on screen. */
  normal: Point;
  width: number;
  /** Extent along the wall, measured from end A (m). */
  left: number;
  right: number;
}

/** A wall's whole footprint, openings ignored — mitred into its joints. */
export interface WallRun {
  wallId: string;
  poly: Point[];
  origin: Point;
  dir: Point;
  /** Stretch of the wall this footprint covers, from end A (m). */
  s0: number;
  s1: number;
}

export interface WallGraph {
  nodes: Point[];
  edges: { a: number; b: number; wallId: string }[];
}

export interface WallBody {
  thickness: number;
  tiles: WallTile[];
  /**
   * Closed outlines of the body, consistently wound (fill with the non-zero
   * rule). When `clean` is false these are the tiles themselves.
   */
  loops: Point[][];
  /** The outline chained into proper loops (always, except for degenerate joints). */
  clean: boolean;
  gaps: WallGap[];
  runs: WallRun[];
  graph: WallGraph;
}

interface Arm {
  node: number;
  /** Unit direction away from the joint. */
  u: Point;
  angle: number;
  /** Corner on the +90° side of `u`, and how far along the arm it sits. */
  cl: Point;
  sl: number;
  /** Corner on the −90° side. */
  cr: Point;
  sr: number;
  /** Set when the left corner is bevelled: the far end of the bevel (the next arm's right corner). */
  bevelPt: Point | null;
  free: boolean;
}

interface GEdge {
  wallId: string;
  n0: number;
  n1: number;
  /** Position along the parent wall (from its end A). */
  s0: number;
  s1: number;
  len: number;
  d: Point;
  arm0: Arm;
  arm1: Arm;
}

const finitePt = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
const samePt = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/** Signed area in plan coordinates (y down). */
export function loopArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** Drop repeated and collinear vertices of a closed loop. */
export function simplifyLoop(poly: Point[]): Point[] {
  let pts = poly.filter((p, i) => !samePt(p, poly[(i + 1) % poly.length]));
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const out: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (Math.abs(cross) < 1e-9 && dot > 0) changed = true;
      else out.push(b);
    }
    pts = out;
  }
  return pts;
}

/** Openings on one wall as [left, right] cuts, clamped to the wall and to each other. */
function wallCuts(wall: Wall, openings: Opening[], len: number): { o: Opening; left: number; right: number }[] {
  const mine = openings
    .filter((o) => o.wallId === wall.id && Number.isFinite(o.offset) && Number.isFinite(o.width) && o.width > 0)
    .sort((a, b) => a.offset - b.offset);
  const cuts: { o: Opening; left: number; right: number }[] = [];
  let cursor = 0;
  for (const o of mine) {
    const left = Math.max(cursor, o.offset - o.width / 2);
    const right = Math.min(len, o.offset + o.width / 2);
    if (right - left < MIN_LEN) continue;
    cuts.push({ o, left, right });
    cursor = right;
  }
  return cuts;
}

export function buildWallBody(walls: Wall[], openings: Opening[], thickness: number): WallBody {
  const h = Math.max(0.005, (Number.isFinite(thickness) ? thickness : 0.1) / 2);
  const usable = walls.filter(
    (w) => finitePt(w.a) && finitePt(w.b) && Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) >= MIN_LEN,
  );

  // ----- joints -----
  const nodes: Point[] = [];
  // Joints are kept on a grid of NODE_TOL cells, so finding the one at a point looks at the
  // few cells around it rather than at every joint (a plan of crossing walls has n² of them).
  const cells = new Map<number, Map<number, number[]>>();
  const cellOf = (v: number): number => Math.floor(v / NODE_TOL);
  /** The joint at `p`; a new one if there is none — or -1 when `create` is false. */
  const nodeAt = (p: Point, create = true): number => {
    const x1 = cellOf(p.x + NODE_TOL);
    const y1 = cellOf(p.y + NODE_TOL);
    let found = -1;
    // k: the range is three cells wide; the count keeps it so when a coordinate is too large to step by one
    for (let cx = cellOf(p.x - NODE_TOL), k = 0; cx <= x1 && k < 4; cx++, k++) {
      const column = cells.get(cx);
      if (!column) continue;
      for (let cy = cellOf(p.y - NODE_TOL), m = 0; cy <= y1 && m < 4; cy++, m++) {
        for (const i of column.get(cy) ?? []) {
          // the earliest joint within reach, as a scan in order would find
          if ((found < 0 || i < found) && Math.hypot(nodes[i].x - p.x, nodes[i].y - p.y) < NODE_TOL) found = i;
        }
      }
    }
    if (found >= 0 || !create) return found;
    nodes.push({ x: p.x, y: p.y });
    const cx = cellOf(p.x);
    const cy = cellOf(p.y);
    let column = cells.get(cx);
    if (!column) cells.set(cx, (column = new Map()));
    const cell = column.get(cy);
    if (cell) cell.push(nodes.length - 1);
    else column.set(cy, [nodes.length - 1]);
    return nodes.length - 1;
  };
  const frames = usable.map((w) => {
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    return {
      wall: w,
      len,
      d: { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len },
      nA: nodeAt(w.a),
      nB: nodeAt(w.b),
      cuts: [] as { s: number; node: number }[],
      /** The joints already in `cuts`. */
      cutAt: new Set<number>(),
    };
  });
  const endpointCount = nodes.length;

  // Tees: another wall's end landing on this wall's run.
  for (const f of frames) {
    for (let k = 0; k < endpointCount; k++) {
      if (k === f.nA || k === f.nB) continue;
      const p = nodes[k];
      const s = (p.x - f.wall.a.x) * f.d.x + (p.y - f.wall.a.y) * f.d.y;
      if (s <= MIN_LEN || s >= f.len - MIN_LEN) continue;
      const off = Math.abs((p.x - f.wall.a.x) * f.d.y - (p.y - f.wall.a.y) * f.d.x);
      if (off < 0.01) {
        f.cuts.push({ s, node: k });
        f.cutAt.add(k);
      }
    }
  }
  // Crossings: two walls drawn through each other.
  let crowded = false;
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const f = frames[i];
      const g = frames[j];
      const den = f.d.x * g.d.y - f.d.y * g.d.x;
      if (Math.abs(den) < 1e-6) continue;
      const wx = g.wall.a.x - f.wall.a.x;
      const wy = g.wall.a.y - f.wall.a.y;
      const s = (wx * g.d.y - wy * g.d.x) / den;
      const t = (wx * f.d.y - wy * f.d.x) / den;
      if (s <= MIN_LEN || s >= f.len - MIN_LEN || t <= MIN_LEN || t >= g.len - MIN_LEN) continue;
      const node = nodeAt({ x: f.wall.a.x + f.d.x * s, y: f.wall.a.y + f.d.y * s }, nodes.length - endpointCount < MAX_CROSSINGS);
      if (node < 0) {
        crowded = true;
        continue;
      }
      if (node !== f.nA && node !== f.nB && !f.cutAt.has(node)) {
        f.cuts.push({ s, node });
        f.cutAt.add(node);
      }
      if (node !== g.nA && node !== g.nB && !g.cutAt.has(node)) {
        g.cuts.push({ s: t, node });
        g.cutAt.add(node);
      }
    }
  }

  // ----- graph edges -----
  const edges: GEdge[] = [];
  const edgesOf = new Map<string, GEdge[]>();
  const taken = new Set<string>();
  const armsAt = new Map<number, Arm[]>();
  const newArm = (node: number, u: Point): Arm => {
    const arm: Arm = {
      node,
      u,
      angle: Math.atan2(u.y, u.x),
      cl: nodes[node],
      sl: 0,
      cr: nodes[node],
      sr: 0,
      bevelPt: null,
      free: true,
    };
    const list = armsAt.get(node);
    if (list) list.push(arm);
    else armsAt.set(node, [arm]);
    return arm;
  };
  for (const f of frames) {
    f.cuts.sort((a, b) => a.s - b.s);
    const stops = [{ s: 0, node: f.nA }, ...f.cuts, { s: f.len, node: f.nB }];
    const mine: GEdge[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      if (from.node === to.node) continue;
      const key = from.node < to.node ? `${from.node}|${to.node}` : `${to.node}|${from.node}`;
      if (taken.has(key)) continue; // a wall lying on top of another
      const a = nodes[from.node];
      const b = nodes[to.node];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-3) continue;
      taken.add(key);
      const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const edge: GEdge = {
        wallId: f.wall.id,
        n0: from.node,
        n1: to.node,
        s0: from.s,
        s1: to.s,
        len,
        d,
        arm0: newArm(from.node, d),
        arm1: newArm(to.node, { x: -d.x, y: -d.y }),
      };
      edges.push(edge);
      mine.push(edge);
    }
    edgesOf.set(f.wall.id, mine);
  }

  // ----- corners around every joint -----
  const TWO_PI = Math.PI * 2;
  for (const [node, arms] of armsAt) {
    const N = nodes[node];
    const side = (arm: Arm, s: number, off: number): Point => ({
      x: N.x + arm.u.x * s - arm.u.y * off,
      y: N.y + arm.u.y * s + arm.u.x * off,
    });
    if (arms.length === 1) {
      arms[0].cl = side(arms[0], 0, h);
      arms[0].cr = side(arms[0], 0, -h);
      continue;
    }
    arms.sort((a, b) => a.angle - b.angle);
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % arms.length];
      let gap = b.angle - a.angle;
      if (i === arms.length - 1) gap += TWO_PI;
      let s = gap < 1e-6 ? 1e6 : gap > TWO_PI - 1e-6 ? -1e6 : h / Math.tan(gap / 2);
      a.free = false;
      b.free = false;
      if (s < -MITRE_LIMIT * h) {
        s = -MITRE_LIMIT * h;
        a.cl = side(a, s, h);
        const far = side(b, s, -h);
        a.bevelPt = far;
        b.cr = far;
      } else {
        const c = side(a, s, h);
        a.cl = c;
        b.cr = c;
      }
      a.sl = s;
      b.sr = s;
    }
  }

  // ----- tiles -----
  const tiles: WallTile[] = [];
  let clean = !crowded;
  const cutsOf = new Map<string, ReturnType<typeof wallCuts>>();
  for (const f of frames) cutsOf.set(f.wall.id, wallCuts(f.wall, openings, f.len));
  const gapExtent = new Map<string, { left: number; right: number }>();

  // Pass 1: where each edge's long faces start and stop, and which openings land on it.
  interface Shape {
    e: GEdge;
    pStart: Point;
    pEnd: Point;
    mStart: Point;
    mEnd: Point;
    gaps: { l: number; r: number }[];
  }
  const shapes: Shape[] = [];
  /** An opening is cut into one edge only — the one that holds most of it. */
  const winner = new Map<string, { shape: Shape; l: number; r: number }>();
  for (const e of edges) {
    const A = nodes[e.n0];
    const at = (t: number, off: number): Point => ({
      x: A.x + e.d.x * t - e.d.y * off,
      y: A.y + e.d.y * t + e.d.x * off,
    });
    let pa = e.arm0.sl;
    let ma = e.arm0.sr;
    let pb = e.arm1.sr;
    let mb = e.arm1.sl;
    let pStart = e.arm0.cl;
    let mStart = e.arm0.cr;
    let pEnd = e.arm1.cr;
    let mEnd = e.arm1.cl;
    // Corners that would pass each other on a very short edge meet in the middle instead.
    const room = e.len - 0.002;
    if (pa + pb > room) {
      clean = false;
      if (pa > 0 && pb > 0) {
        const t = (e.len * pa) / (pa + pb);
        pStart = pEnd = at(t, h);
        pa = t;
        pb = e.len - t;
      } else if (pa > 0) {
        pStart = pEnd;
        pa = e.len - pb;
      } else {
        pEnd = pStart;
        pb = e.len - pa;
      }
    }
    if (ma + mb > room) {
      clean = false;
      if (ma > 0 && mb > 0) {
        const t = (e.len * ma) / (ma + mb);
        mStart = mEnd = at(t, -h);
        ma = t;
        mb = e.len - t;
      } else if (ma > 0) {
        mStart = mEnd;
        ma = e.len - mb;
      } else {
        mEnd = mStart;
        mb = e.len - ma;
      }
    }
    const shape: Shape = { e, pStart, pEnd, mStart, mEnd, gaps: [] };
    shapes.push(shape);

    // Openings that fall on the straight part of this edge.
    const lo = Math.max(pa, ma, 0) + JOINT_CLEAR;
    const hi = e.len - Math.max(pb, mb, 0) - JOINT_CLEAR;
    for (const c of cutsOf.get(e.wallId) ?? []) {
      const l = Math.max(lo, c.left - e.s0);
      const r = Math.min(hi, c.right - e.s0);
      if (r - l < MIN_LEN) continue;
      const best = winner.get(c.o.id);
      if (!best || r - l > best.r - best.l) winner.set(c.o.id, { shape, l, r });
    }
  }
  for (const [id, w] of winner) {
    w.shape.gaps.push({ l: w.l, r: w.r });
    gapExtent.set(id, { left: w.l + w.shape.e.s0, right: w.r + w.shape.e.s0 });
  }

  // Pass 2: the tiles.
  for (const { e, pStart, pEnd, mStart, mEnd, gaps } of shapes) {
    gaps.sort((a, b) => a.l - b.l);
    const A = nodes[e.n0];
    const at = (t: number, off: number): Point => ({
      x: A.x + e.d.x * t - e.d.y * off,
      y: A.y + e.d.y * t + e.d.x * off,
    });

    const cap = (arm: Arm, cr: Point, cl: Point, pts: Point[], kinds: EdgeKind[]) => {
      // Travelling from the arm's right corner to its left one, around the joint.
      pts.push(cr);
      if (arm.free) {
        kinds.push('free');
      } else {
        kinds.push('mitre');
        pts.push(nodes[arm.node]);
        kinds.push('mitre');
        if (arm.bevelPt) {
          pts.push(arm.bevelPt);
          kinds.push('bevel');
        }
      }
      pts.push(cl);
    };

    for (let k = 0; k <= gaps.length; k++) {
      const first = k === 0;
      const last = k === gaps.length;
      const pts: Point[] = [];
      const kinds: EdgeKind[] = [];
      // + face, towards the far end
      pts.push(first ? pStart : at(gaps[k - 1].r, h));
      kinds.push('side');
      if (last) {
        cap(e.arm1, pEnd, mEnd, pts, kinds);
      } else {
        pts.push(at(gaps[k].l, h));
        kinds.push('jamb');
        pts.push(at(gaps[k].l, -h));
      }
      // − face, coming back
      kinds.push('side');
      if (first) {
        cap(e.arm0, mStart, pStart, pts, kinds);
        pts.pop(); // closes onto the first point
      } else {
        pts.push(at(gaps[k - 1].r, -h));
        kinds.push('jamb');
      }
      tiles.push({ wallId: e.wallId, poly: pts, kinds });
    }
  }

  // ----- outline: chain every non-internal edge into loops -----
  interface Seg {
    a: Point;
    b: Point;
    used: boolean;
  }
  const segs: Seg[] = [];
  const byStart = new Map<Point, Seg[]>();
  for (const t of tiles) {
    for (let i = 0; i < t.poly.length; i++) {
      if (t.kinds[i] === 'mitre') continue;
      const a = t.poly[i];
      const b = t.poly[(i + 1) % t.poly.length];
      if (a === b) continue;
      const seg: Seg = { a, b, used: false };
      segs.push(seg);
      const list = byStart.get(a);
      if (list) list.push(seg);
      else byStart.set(a, [seg]);
    }
  }
  const loops: Point[][] = [];
  if (clean) {
    for (const start of segs) {
      if (start.used) continue;
      const pts: Point[] = [];
      let cur: Seg | undefined = start;
      while (cur && !cur.used) {
        cur.used = true;
        pts.push(cur.a);
        if (cur.b === start.a) break;
        cur = byStart.get(cur.b)?.find((s) => !s.used);
      }
      if (!cur || cur.b !== start.a) {
        clean = false;
        break;
      }
      const loop = simplifyLoop(pts);
      if (loop.length >= 3) loops.push(loop);
    }
  }
  if (!clean) {
    loops.length = 0;
    for (const t of tiles) {
      const loop = simplifyLoop(t.poly);
      if (loop.length >= 3) loops.push(loop);
    }
  }

  // ----- openings as cut -----
  const gaps: WallGap[] = [];
  for (const f of frames) {
    for (const c of cutsOf.get(f.wall.id) ?? []) {
      const ext = gapExtent.get(c.o.id);
      if (!ext) continue;
      const mid = (ext.left + ext.right) / 2;
      gaps.push({
        id: c.o.id,
        wallId: f.wall.id,
        type: c.o.type,
        ...(c.o.label ? { label: c.o.label } : {}),
        center: { x: f.wall.a.x + f.d.x * mid, y: f.wall.a.y + f.d.y * mid },
        dir: f.d,
        normal: { x: -f.d.y, y: f.d.x },
        width: ext.right - ext.left,
        left: ext.left,
        right: ext.right,
      });
    }
  }

  // ----- one footprint per wall (per unbroken stretch of it) -----
  const runs: WallRun[] = [];
  for (const f of frames) {
    const mine = edgesOf.get(f.wall.id) ?? [];
    let i = 0;
    while (i < mine.length) {
      let j = i;
      while (j + 1 < mine.length && mine[j + 1].n0 === mine[j].n1) j++;
      const part = mine.slice(i, j + 1);
      const pts: Point[] = [part[0].arm0.cl];
      const around = (arm: Arm) => {
        if (!arm.free) pts.push(nodes[arm.node]);
        if (arm.bevelPt) pts.push(arm.bevelPt);
        pts.push(arm.cl);
      };
      for (let k = 0; k < part.length; k++) {
        pts.push(part[k].arm1.cr);
        if (k < part.length - 1 && part[k].arm1.cr !== part[k + 1].arm0.cl) around(part[k + 1].arm0);
      }
      around(part[part.length - 1].arm1);
      for (let k = part.length - 1; k >= 0; k--) {
        pts.push(part[k].arm0.cr);
        if (k > 0 && part[k].arm0.cr !== part[k - 1].arm1.cl) around(part[k - 1].arm1);
      }
      around(part[0].arm0);
      const poly = simplifyLoop(pts);
      if (poly.length >= 3) {
        runs.push({ wallId: f.wall.id, poly, origin: { ...f.wall.a }, dir: f.d, s0: part[0].s0, s1: part[part.length - 1].s1 });
      }
      i = j + 1;
    }
  }

  return {
    thickness: h * 2,
    tiles,
    loops,
    clean,
    gaps,
    runs,
    graph: {
      nodes,
      edges: edges.map((e) => ({ a: e.n0, b: e.n1, wallId: e.wallId })),
    },
  };
}
