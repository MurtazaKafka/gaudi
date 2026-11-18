/**
 * Walls built board by board, brick by brick — and the trim a builder would
 * add without being asked: a base course where the wall meets the ground,
 * corner boards, skirting indoors.
 *
 * Everything is laid on a wall face (a flat upright polygon). Courses are
 * measured from the ground and joints from world position, so boards run
 * unbroken past the pieces a wall is cut into around its doors and windows.
 */
import type { WallPiece } from '../build';
import { clipToBox, convexHull, hash, lightOf, polygonArea, shade, Soup } from './pieces';
import type { P2, RGB, V3 } from './pieces';

export type Siding = 'h-board' | 'v-board' | 'lap' | 'brick';

/** One upright face of a wall: where it is, which way it looks, and its outline in its own (along, up) coordinates. */
export interface WallFace {
  /** Unit direction along the face, the same for every face on one wall line. */
  dx: number;
  dz: number;
  /** Unit normal, pointing away from the wall. */
  nx: number;
  nz: number;
  /** The point of the face's line at along = 0, on the ground. */
  ox: number;
  oz: number;
  /** Outline, (along, up), convex. */
  poly: P2[];
  outer: boolean;
  /** Part of a wall cut at a height (where a shorter neighbour stops): it carries on the face below it. */
  stacked?: boolean;
}

/** A face from two plan points, a height range and a normal. */
export function uprightFace(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y0: number,
  y1: number,
  nx: number,
  nz: number,
  outer: boolean,
): WallFace | null {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-4 || !(y1 - y0 > 1e-4)) return null;
  let dx = (bx - ax) / len;
  let dz = (bz - az) / len;
  // One direction per line, whichever way this piece happens to run.
  if (dx < -1e-9 || (Math.abs(dx) < 1e-9 && dz < 0)) [dx, dz] = [-dx, -dz];
  const sa = ax * dx + az * dz;
  const sb = bx * dx + bz * dz;
  const [s0, s1] = sa < sb ? [sa, sb] : [sb, sa];
  return {
    dx,
    dz,
    nx,
    nz,
    ox: ax - dx * sa,
    oz: az - dz * sa,
    poly: [[s0, y0], [s1, y0], [s1, y1], [s0, y1]],
    outer,
  };
}

/** An upright face from its corner points (a gable end is a triangle, not a box). */
export function faceFromPoints(pts: V3[], nx: number, nz: number, outer: boolean): WallFace | null {
  const nl = Math.hypot(nx, nz);
  if (pts.length < 3 || nl < 1e-6) return null;
  let dx = -nz / nl;
  let dz = nx / nl;
  if (dx < -1e-9 || (Math.abs(dx) < 1e-9 && dz < 0)) [dx, dz] = [-dx, -dz];
  const s0 = pts[0][0] * dx + pts[0][2] * dz;
  return {
    dx,
    dz,
    nx: nx / nl,
    nz: nz / nl,
    ox: pts[0][0] - dx * s0,
    oz: pts[0][2] - dz * s0,
    poly: convexHull(pts.map((q): P2 => [q[0] * dx + q[2] * dz, q[1]])),
    outer,
  };
}

/**
 * The two long faces of a wall piece, and any end of it left standing in the
 * open above a shorter wall (not its cut ends, which are hidden or are jambs).
 */
export function wallFaces(piece: WallPiece): WallFace[] {
  const { poly, y0, y1 } = piece;
  const n = poly.length;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / n;
    cz += p.y / n;
  }
  const out: WallFace[] = [];
  for (let i = 0; i < n; i++) {
    const side = piece.sides[i];
    if (side !== 'p' && side !== 'm' && side !== 'end') continue;
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    let nx = (b.y - a.y) / len;
    let nz = -(b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - cx) + nz * ((a.y + b.y) / 2 - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const outer = side === 'p' ? piece.pOuter : side === 'm' ? piece.mOuter : piece.pOuter || piece.mOuter;
    const face = uprightFace(a.x, a.y, b.x, b.y, y0, y1, nx, nz, outer);
    if (face && piece.stacked) face.stacked = true;
    if (face) out.push(face);
  }
  return out;
}

const at = (f: WallFace, s: number, y: number, d: number): V3 => [f.ox + f.dx * s + f.nx * d, y, f.oz + f.dz * s + f.nz * d];

const lineId = (f: WallFace): number =>
  Math.floor(hash(Math.round(f.nx * 100), Math.round(f.nz * 100), Math.round((f.ox * f.nx + f.oz * f.nz) * 50)) * 1e6);

/** One piece: the part of a box (along × up) that lies on the face, standing `depth(y)` proud of it. */
function piece(
  soup: Soup,
  f: WallFace,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  depth: (y: number) => number,
  color: RGB,
): P2[] {
  const q = clipToBox(f.poly, s0, s1, y0, y1);
  if (q.length < 3 || polygonArea(q) < 1e-4) return [];
  soup.poly(q.map(([s, y]) => at(f, s, y, depth(y))), color, [f.nx, 0, f.nz]);
  return q;
}

/** A level strip between the wall and a piece's edge (the underside of a lapped board, the top of a base course). */
function ledge(soup: Soup, f: WallFace, q: P2[], y: number, depth: number, color: RGB, up: boolean): void {
  const on = q.filter((p) => Math.abs(p[1] - y) < 1e-6);
  if (on.length < 2) return;
  const s0 = Math.min(...on.map((p) => p[0]));
  const s1 = Math.max(...on.map((p) => p[0]));
  soup.poly([at(f, s0, y, 0), at(f, s1, y, 0), at(f, s1, y, depth), at(f, s0, y, depth)], color, [0, up ? 1 : -1, 0]);
}

function bounds(f: WallFace): [number, number, number, number] {
  const ss = f.poly.map((p) => p[0]);
  const ys = f.poly.map((p) => p[1]);
  return [Math.min(...ss), Math.max(...ss), Math.min(...ys), Math.max(...ys)];
}

/**
 * Lay a face with boards or bricks. `from`, when given, is the height upright
 * boards start at (over a door or window: the top of its drip cap), so they
 * stand on the trim rather than run behind it.
 */
export function laySiding(soup: Soup, f: WallFace, siding: Siding, colorHex: string, from?: number): void {
  const base = lightOf(colorHex);
  const lid = lineId(f);
  const [sa, sb, ya0, yb] = bounds(f);

  if (siding === 'v-board') {
    // Board and batten: wide upright boards, a narrow strip over every joint.
    const ya = from !== undefined && from > ya0 ? from : ya0;
    if (yb - ya < 0.01) return;
    const w = 0.3;
    for (let j = Math.floor(sa / w); j * w < sb; j++) {
      const color = shade(base, 1 + (hash(lid, j, 21) - 0.5) * 0.16);
      piece(soup, f, j * w + 0.004, (j + 1) * w - 0.004, ya, yb, () => 0.012, color);
      const q = piece(soup, f, j * w - 0.022, j * w + 0.022, ya, yb, () => 0.034, shade(base, 0.97));
      if (q.length === 0) continue;
      const ys = q.map((p) => p[1]);
      const [b0, b1] = [Math.min(...ys), Math.max(...ys)];
      for (const [s, sign] of [[j * w - 0.022, -1], [j * w + 0.022, 1]] as const) {
        if (s <= sa || s >= sb) continue;
        soup.poly([at(f, s, b0, 0.012), at(f, s, b1, 0.012), at(f, s, b1, 0.034), at(f, s, b0, 0.034)], shade(base, 0.7), [
          f.dx * sign,
          0,
          f.dz * sign,
        ]);
      }
    }
    return;
  }
  const ya = ya0;

  if (siding === 'brick') {
    const course = 0.075;
    const length = 0.225;
    const mortar = 0.01;
    for (let k = Math.floor(ya / course); k * course < yb; k++) {
      const off = k & 1 ? length / 2 : 0;
      for (let j = Math.floor((sa - off) / length); j * length + off < sb; j++) {
        const h = hash(lid + k * 131, j, 31);
        // Mostly one clay, some fired harder.
        const burnt = hash(lid + k * 17, j, 37) < 0.07 ? 0.72 : 1;
        const t = (1 + (h - 0.5) * 0.26) * burnt;
        const warm = (hash(lid + k, j * 3, 41) - 0.5) * 0.1;
        piece(
          soup,
          f,
          j * length + off + mortar / 2,
          (j + 1) * length + off - mortar / 2,
          k * course + mortar / 2,
          (k + 1) * course - mortar / 2,
          () => 0.012,
          [base[0] * t * (1 + warm), base[1] * t, base[2] * t * (1 - warm)],
        );
      }
    }
    return;
  }

  // Horizontal boards. Shiplap sits flat with a shadow gap; lap siding tilts, each board over the one below.
  const lap = siding === 'lap';
  const h = lap ? 0.15 : 0.165;
  const gap = lap ? 0 : 0.012;
  // Long boards, butted only over a stud: joints fall on a 600 mm grid, never just anywhere.
  const stud = 0.6;
  const run = 4.8;
  // What shows in a joint is the boards' own colour in shade, not a black crack.
  piece(soup, f, sa, sb, ya, yb, () => 0.004, shade(base, 0.7));
  for (let k = Math.floor(ya / h); k * h < yb; k++) {
    const y0 = k * h + gap / 2;
    const y1 = (k + 1) * h - gap / 2;
    const off = stud * Math.floor(hash(lid, k, 51) * (run / stud));
    for (let j = Math.floor((sa - off) / run); j * run + off < sb; j++) {
      const color = shade(base, 1 + (hash(lid + k * 131, j, 53) - 0.5) * (lap ? 0.14 : 0.22));
      const depth = lap ? (y: number) => 0.008 + 0.024 * (1 - (y - y0) / (y1 - y0)) : () => 0.016;
      const s0 = j * run + off + 0.001;
      const s1 = (j + 1) * run + off - 0.001;
      // A lapped board's thick lower edge reads as a fine dark line along every course.
      const lip = lap ? 0.012 : 0;
      const low = lap ? piece(soup, f, s0, s1, y0, y0 + lip, depth, shade(color, 0.72)) : [];
      piece(soup, f, s0, s1, y0 + lip, y1, depth, color);
      if (low.length > 0) ledge(soup, f, low, y0, 0.032, shade(base, 0.45), false);
    }
  }
}

/** The base course: a low band of stone the wall stands on. */
export function layPlinth(soup: Soup, f: WallFace, colorHex: string): void {
  const [sa, sb, ya] = bounds(f);
  if (ya > 0.01) return;
  const color = lightOf(colorHex);
  const q = piece(soup, f, sa, sb, 0, 0.15, () => 0.05, color);
  if (q.length > 0) ledge(soup, f, q, 0.15, 0.05, shade(color, 1.12), true);
}

/** Skirting along the foot of an indoor wall. It stops where the wall does, so doorways stay clear. */
export function laySkirting(soup: Soup, f: WallFace, colorHex: string): void {
  const [sa, sb, ya] = bounds(f);
  if (ya > 0.01) return;
  const color = lightOf(colorHex);
  const q = piece(soup, f, sa, sb, 0, 0.085, () => 0.014, color);
  if (q.length > 0) ledge(soup, f, q, 0.085, 0.014, shade(color, 0.92), true);
}

/** Corner boards: an upright board each way wherever two outside walls meet at an outward corner. */
export function layCornerBoards(soup: Soup, faces: WallFace[], colorHex: string): void {
  const color = lightOf(colorHex);
  interface End {
    f: WallFace;
    /** The face's end at this corner, and the way the face runs away from it (±1 along). */
    s: number;
    away: number;
    y0: number;
    y1: number;
  }
  const corners = new Map<string, End[]>();
  for (const f of faces) {
    if (!f.outer) continue;
    const [sa, sb, ya, yb] = bounds(f);
    for (const [s, away] of [[sa, 1], [sb, -1]] as const) {
      const p = at(f, s, 0, 0);
      const k = `${Math.round(p[0] * 200)},${Math.round(p[2] * 200)}`;
      corners.set(k, [...(corners.get(k) ?? []), { f, s, away, y0: ya, y1: yb }]);
    }
  }
  const width = 0.09;
  const proud = 0.045;
  for (const ends of corners.values()) {
    for (const a of ends) {
      const turns = ends.some((b) => {
        if (b === a || Math.abs(a.f.nx * b.f.nx + a.f.nz * b.f.nz) > 0.95) return false;
        // Outward corner: this wall runs off behind the other one's face.
        return a.away * (a.f.dx * b.f.nx + a.f.dz * b.f.nz) < -0.01;
      });
      // From the ground up; a piece cut off a taller wall carries its board on up.
      if (!turns || (a.y0 > 0.01 && !a.f.stacked)) continue;
      const f = a.f;
      // From just past the corner (to meet the other board) to a hand's width along the wall.
      const [s0, s1] = [a.s - a.away * proud, a.s + a.away * width];
      const pts = (d: number): V3[] => [at(f, s0, a.y0, d), at(f, s1, a.y0, d), at(f, s1, a.y1, d), at(f, s0, a.y1, d)];
      soup.poly(pts(proud), color, [f.nx, 0, f.nz]);
      soup.poly([at(f, s1, a.y0, 0), at(f, s1, a.y1, 0), at(f, s1, a.y1, proud), at(f, s1, a.y0, proud)], shade(color, 0.75), [
        f.dx * a.away,
        0,
        f.dz * a.away,
      ]);
    }
  }
}
