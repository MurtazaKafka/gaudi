/**
 * First-person walking: a circle sliding along walls and round furniture.
 * Pure math.
 *
 * Walls are centerlines with the door openings left out (see `wallBlockers`
 * in build.ts), so a doorway is simply a gap wide enough to pass through —
 * and the only way from one side of a wall to the other: no step is ever
 * accepted that crosses a wall line. Furniture is its footprint on the floor.
 */
import type { Furniture, Point } from '../types';
import type { Segment } from '../build';
import { pointInPolygon, rectCorners } from '../geometry';

/** Eye height above the floor (m). */
export const EYE_HEIGHT = 1.6;
/** Walking speed (m/s). */
export const WALK_SPEED = 2.6;
/** The walker's own radius (m), before the wall's half thickness is added. */
export const BODY_RADIUS = 0.17;
/** How close the walker's center comes to a piece of furniture (m). */
export const FURNITURE_RADIUS = 0.14;

/** Everything the walker can bump into. */
export interface WalkWorld {
  /** Solid stretches of wall, as centerlines. */
  blockers: Segment[];
  /** Closest the walker's center comes to a wall centerline (m). */
  radius: number;
  /** Footprints of solid furniture (convex, plan meters). */
  obstacles?: Point[][];
  /** Closest the walker's center comes to a footprint (m). */
  obstacleRadius?: number;
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Do segments p→q and a→b cross or touch? */
function crosses(p: Point, q: Point, a: Point, b: Point): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(a, b, q);
  const d3 = cross(p, q, a);
  const d4 = cross(p, q, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const within = (o: Point, e: Point, r: Point): boolean =>
    Math.min(o.x, e.x) - 1e-9 <= r.x && r.x <= Math.max(o.x, e.x) + 1e-9 &&
    Math.min(o.y, e.y) - 1e-9 <= r.y && r.y <= Math.max(o.y, e.y) + 1e-9;
  return (
    (d1 === 0 && within(a, b, p)) || (d2 === 0 && within(a, b, q)) ||
    (d3 === 0 && within(p, q, a)) || (d4 === 0 && within(p, q, b))
  );
}

/** Would going straight from `from` to `to` pass through a wall? */
export function crossesWall(from: Point, to: Point, blockers: Segment[]): boolean {
  for (const s of blockers) if (crosses(from, to, s.a, s.b)) return true;
  return false;
}

/** Push `p` out of a footprint it is inside of, or closer to than `radius`. */
function clearOfPolygon(p: Point, poly: Point[], radius: number): Point | null {
  let best: Point | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const c = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (!best) return null;
  const inside = pointInPolygon(p, poly);
  if (!inside && bestDist >= radius) return null;
  // Leave through the nearest edge; from inside that means going on past it.
  let nx = inside ? best.x - p.x : p.x - best.x;
  let ny = inside ? best.y - p.y : p.y - best.y;
  let len = Math.hypot(nx, ny);
  if (len < 1e-7) {
    // On the edge itself: head away from the middle of the piece.
    let cx = 0;
    let cy = 0;
    for (const q of poly) {
      cx += q.x / poly.length;
      cy += q.y / poly.length;
    }
    nx = p.x - cx;
    ny = p.y - cy;
    len = Math.hypot(nx, ny);
    if (len < 1e-7) {
      nx = 1;
      ny = 0;
      len = 1;
    }
  }
  return { x: best.x + (nx / len) * radius, y: best.y + (ny / len) * radius };
}

/** Push `p` out of every wall and footprint it is too close to. `from` breaks ties when p sits on a wall. */
export function resolveCollisions(p: Point, world: WalkWorld, from: Point = p): Point {
  const { blockers, radius } = world;
  const obstacles = world.obstacles ?? [];
  const obstacleRadius = world.obstacleRadius ?? FURNITURE_RADIUS;
  let x = p.x;
  let y = p.y;
  for (let pass = 0; pass < 5; pass++) {
    let moved = false;
    for (const s of blockers) {
      const c = closestOnSegment({ x, y }, s.a, s.b);
      let nx = x - c.x;
      let ny = y - c.y;
      let d = Math.hypot(nx, ny);
      if (d >= radius) continue;
      if (d < 1e-7) {
        // Dead on the centerline: leave toward where we came from, else along the wall's normal.
        nx = from.x - c.x;
        ny = from.y - c.y;
        d = Math.hypot(nx, ny);
        if (d < 1e-7) {
          nx = -(s.b.y - s.a.y);
          ny = s.b.x - s.a.x;
          d = Math.hypot(nx, ny) || 1;
        }
        x = c.x + (nx / d) * radius;
        y = c.y + (ny / d) * radius;
      } else {
        x += (nx / d) * (radius - d);
        y += (ny / d) * (radius - d);
      }
      moved = true;
    }
    for (const poly of obstacles) {
      const out = clearOfPolygon({ x, y }, poly, obstacleRadius);
      if (!out) continue;
      x = out.x;
      y = out.y;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y };
}

/** Is `p` somewhere a walker can stand: clear of walls and off the furniture? */
export function isClear(p: Point, world: WalkWorld): boolean {
  const slack = 1e-4;
  for (const s of world.blockers) {
    const c = closestOnSegment(p, s.a, s.b);
    if (Math.hypot(p.x - c.x, p.y - c.y) < world.radius - slack) return false;
  }
  for (const poly of world.obstacles ?? []) if (pointInPolygon(p, poly)) return false;
  return true;
}

/**
 * Move the walker by `move`, sliding along whatever is in the way. Long moves
 * are taken in short steps, and a step that would end up through a wall or in
 * a piece of furniture is not taken at all — so the only way out of a room is
 * a doorway.
 */
export function stepWalker(pos: Point, move: Point, world: WalkWorld): Point {
  const dist = Math.hypot(move.x, move.y);
  if (!(dist > 0) || !Number.isFinite(dist)) return pos;
  const stride = Math.max(0.02, Math.min(world.radius, world.obstacleRadius ?? FURNITURE_RADIUS) * 0.5);
  const steps = Math.min(96, Math.max(1, Math.ceil(dist / stride)));
  const dx = move.x / steps;
  const dy = move.y / steps;
  // Somewhere it shouldn't be to begin with (the plan changed underfoot): let it walk out, still never through a wall.
  let strict = isClear(pos, world);
  const allowed = (from: Point, to: Point): boolean =>
    Number.isFinite(to.x) && Number.isFinite(to.y) && !crossesWall(from, to, world.blockers) && (!strict || isClear(to, world));
  let p = pos;
  for (let i = 0; i < steps; i++) {
    // The whole step, else whichever half of it still goes somewhere (sliding into a corner).
    const tries: Point[] = [
      { x: p.x + dx, y: p.y + dy },
      { x: p.x + dx, y: p.y },
      { x: p.x, y: p.y + dy },
    ];
    let next: Point | null = null;
    for (const t of tries) {
      const settled = resolveCollisions(t, world, p);
      if (allowed(p, settled)) {
        next = settled;
        break;
      }
    }
    if (!next) break;
    p = next;
    strict = strict || isClear(p, world);
  }
  return p;
}

/**
 * Where a walker stepping in at `p` actually stands: nudged clear of walls
 * and furniture, without being pushed through a wall into the next room.
 */
export function settleWalker(p: Point, world: WalkWorld): Point {
  const settled = resolveCollisions(p, world);
  if (!crossesWall(p, settled, world.blockers)) return settled;
  // The furniture pushed us through a wall: stand clear of the walls only.
  return resolveCollisions(p, { blockers: world.blockers, radius: world.radius });
}

/**
 * Movement for one frame from the held keys. `yaw` is the heading in radians
 * (0 looks toward −z / plan north, positive turns left); returns a plan-space delta.
 */
export function walkDelta(forward: number, strafe: number, yaw: number, distance: number): Point {
  const len = Math.hypot(forward, strafe);
  if (len < 1e-6) return { x: 0, y: 0 };
  const f = forward / len;
  const s = strafe / len;
  // Forward is (−sin yaw, −cos yaw) in (x, z); right is (cos yaw, −sin yaw).
  return {
    x: (-Math.sin(yaw) * f + Math.cos(yaw) * s) * distance,
    y: (-Math.cos(yaw) * f - Math.sin(yaw) * s) * distance,
  };
}

/** What `furnitureObstacles` needs to know about a piece. */
export interface SolidShape {
  /** Footprint, meters. */
  w: number;
  d: number;
  /** Lowest and highest point above the floor, meters. */
  bottom: number;
  top: number;
}

/**
 * Footprints of the furniture a walker has to go round. Rugs and anything
 * else you would step over, and things hung above head height, are left out.
 */
export function furnitureObstacles(
  furniture: Pick<Furniture, 'kind' | 'x' | 'y' | 'rotation'>[],
  shapeOf: (kind: Furniture['kind']) => SolidShape | null,
): Point[][] {
  const out: Point[][] = [];
  for (const f of furniture) {
    if (![f.x, f.y, f.rotation].every(Number.isFinite)) continue;
    let shape: SolidShape | null;
    try {
      shape = shapeOf(f.kind);
    } catch {
      continue;
    }
    if (!shape || ![shape.w, shape.d, shape.top, shape.bottom].every(Number.isFinite)) continue;
    if (shape.w < 0.02 || shape.d < 0.02) continue;
    if (shape.top <= 0.25 || shape.bottom >= 1.9) continue;
    out.push(rectCorners(f.x, f.y, shape.w, shape.d, f.rotation));
  }
  return out;
}
