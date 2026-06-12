import type { Point, Wall } from './types';
import { dist } from './geometry';

export interface DetectedRoom {
  /** Stable across endpoint drags: hash of the boundary wall-id set. */
  key: string;
  polygon: Point[];
  /** m² */ area: number;
  centroid: Point;
}

const COORD_EPS = 1e-4;

function nodeKey(p: Point): string {
  return `${Math.round(p.x / COORD_EPS)},${Math.round(p.y / COORD_EPS)}`;
}

interface Edge {
  wallId: string;
  a: Point;
  b: Point;
}

/**
 * Split walls at T-junctions: any other wall's endpoint lying strictly inside
 * a segment becomes a graph node so rooms separated by abutting walls resolve.
 */
function splitAtJunctions(walls: Wall[]): Edge[] {
  const endpoints: Point[] = walls.flatMap((w) => [w.a, w.b]);
  const edges: Edge[] = [];

  for (const w of walls) {
    const len = dist(w.a, w.b);
    if (len < COORD_EPS) continue;
    const dx = (w.b.x - w.a.x) / len;
    const dy = (w.b.y - w.a.y) / len;

    // Parametric positions of endpoints that sit on this wall's interior.
    const cuts: number[] = [];
    for (const p of endpoints) {
      const t = (p.x - w.a.x) * dx + (p.y - w.a.y) * dy;
      if (t <= 0.01 || t >= len - 0.01) continue;
      const off = Math.abs((p.x - w.a.x) * dy - (p.y - w.a.y) * dx);
      if (off < 0.01) cuts.push(t);
    }
    cuts.sort((p, q) => p - q);

    let prev = w.a;
    let prevT = 0;
    for (const t of cuts) {
      if (t - prevT < 0.01) continue;
      const pt = { x: w.a.x + dx * t, y: w.a.y + dy * t };
      edges.push({ wallId: w.id, a: prev, b: pt });
      prev = pt;
      prevT = t;
    }
    edges.push({ wallId: w.id, a: prev, b: w.b });
  }
  return edges;
}

interface HalfEdge {
  edge: Edge;
  from: Point;
  to: Point;
  fromKey: string;
  toKey: string;
  id: number;
  /** Filled in after node sort: the half-edge chosen by the face-walk rule. */
  next?: HalfEdge;
}

function shoelace(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** Remove zero-width spurs (u→v→u backtracks from dangling walls). */
function removeSpurs(poly: Point[]): Point[] {
  const pts = poly.slice();
  let changed = true;
  while (changed && pts.length > 2) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const next = pts[(i + 1) % pts.length];
      if (nodeKey(prev) === nodeKey(next)) {
        // pts[i] is the tip of a spur: drop it and one duplicate neighbor.
        pts.splice(i, 1);
        pts.splice(i % pts.length, 1);
        changed = true;
        break;
      }
    }
  }
  // Collapse consecutive duplicates.
  return pts.filter((p, i) => nodeKey(p) !== nodeKey(pts[(i + 1) % pts.length]));
}

function polygonCentroid(poly: Point[]): Point {
  const a = shoelace(poly);
  if (Math.abs(a) < 1e-9) return poly[0] ?? { x: 0, y: 0 };
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/**
 * Detect closed rooms in the wall graph via planar face traversal:
 * at every node take the next edge clockwise from the reversed incoming
 * direction. Interior faces come out with positive shoelace area in
 * y-down plan coordinates; the unbounded face is negative.
 */
export function detectRooms(walls: Wall[]): DetectedRoom[] {
  const edges = splitAtJunctions(walls);

  const halves: HalfEdge[] = [];
  edges.forEach((edge) => {
    halves.push({
      edge,
      from: edge.a,
      to: edge.b,
      fromKey: nodeKey(edge.a),
      toKey: nodeKey(edge.b),
      id: halves.length,
    });
    halves.push({
      edge,
      from: edge.b,
      to: edge.a,
      fromKey: nodeKey(edge.b),
      toKey: nodeKey(edge.a),
      id: halves.length,
    });
  });

  // Group outgoing half-edges per node.
  const outgoing = new Map<string, HalfEdge[]>();
  for (const h of halves) {
    const list = outgoing.get(h.fromKey);
    if (list) list.push(h);
    else outgoing.set(h.fromKey, [h]);
  }

  // Link each half-edge to its successor: arriving at `to`, leave via the
  // edge with the smallest clockwise turn from the reversed direction;
  // straight-back is a last resort (dead ends).
  const TWO_PI = Math.PI * 2;
  for (const h of halves) {
    const candidates = outgoing.get(h.toKey) ?? [];
    const revAngle = Math.atan2(h.from.y - h.to.y, h.from.x - h.to.x);
    let best: HalfEdge | undefined;
    let bestDelta = Infinity;
    for (const c of candidates) {
      const outAngle = Math.atan2(c.to.y - c.from.y, c.to.x - c.from.x);
      let delta = (revAngle - outAngle) % TWO_PI;
      if (delta < 0) delta += TWO_PI;
      if (delta < 1e-9) delta = TWO_PI; // going straight back
      if (delta < bestDelta) {
        bestDelta = delta;
        best = c;
      }
    }
    h.next = best;
  }

  // Walk faces.
  const visited = new Set<number>();
  const rooms: DetectedRoom[] = [];
  const usedKeys = new Map<string, number>();

  for (const start of halves) {
    if (visited.has(start.id)) continue;
    const polygon: Point[] = [];
    const wallIds = new Set<string>();
    let h: HalfEdge | undefined = start;
    let ok = true;
    while (h && !visited.has(h.id)) {
      visited.add(h.id);
      polygon.push(h.from);
      wallIds.add(h.edge.wallId);
      h = h.next;
      if (!h) ok = false;
    }
    if (!ok || h?.id !== start.id) continue; // open chain, not a face

    const area = shoelace(polygon);
    if (area < 0.05) continue; // outer face (negative) or degenerate

    const cleaned = removeSpurs(polygon);
    if (cleaned.length < 3) continue;

    let key = [...wallIds].sort().join('|');
    // Two faces can share a wall set in exotic plans; disambiguate.
    const n = usedKeys.get(key) ?? 0;
    usedKeys.set(key, n + 1);
    if (n > 0) key = `${key}#${n}`;

    rooms.push({
      key,
      polygon: cleaned,
      area,
      centroid: polygonCentroid(cleaned),
    });
  }

  return rooms;
}
