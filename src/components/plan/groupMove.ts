/**
 * Moving part of a plan as one piece — dragging a selection, or nudging it
 * with the arrow keys. Pure: plain data in, plain data out.
 *
 * The selected walls all move by the same amount. Where one meets a wall that
 * is not selected, the two stay joined and both stay straight:
 *
 *  - The wall that stays keeps its angle. Its end slides along its own line to
 *    where that line meets the moved wall's line.
 *  - A moved wall whose end met one straight run of walls that stay slides its
 *    end along that run the same way. So a wall between two corners can't
 *    poke past them, and a partition can't poke through the wall it stands on.
 *  - Where the two are close to parallel there is no useful meeting point, and
 *    a short wall at a right angle bridges the step.
 *
 * Doors and windows that are not selected stay exactly where they are; those
 * on moved walls move with them. A move that would shrink a wall to nothing,
 * leave a door or window no room, pull a wall off one it stands on, or land
 * one wall on another is refused whole: nothing is ever deleted or bent.
 */
import { dist, distToSegment } from '../../geometry';
import { detectRooms, type DetectedRoom } from '../../rooms';
import type { Opening, PlanData, Point, Wall } from '../../types';
import { MIN_WALL, OPENING_GAP, slideOpening } from './drafting';

/** Points closer than this are one corner, as room detection sees them (rooms.ts). */
const NODE = 1e-4;
/**
 * Room detection counts an end within a centimetre of a wall as on it, and one
 * within a centimetre of a wall's corner as at that corner (rooms.ts).
 */
const NEAR = 0.01;
/** Lines meeting at less than 20° are treated as parallel: bridged, not met. */
const PARALLEL = Math.sin((20 * Math.PI) / 180);

type End = 'a' | 'b';
const ENDS: readonly End[] = ['a', 'b'];

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const pt = (x: number, y: number): Point => ({ x: r6(x), y: r6(y) });
const near = (p: Point, q: Point): boolean => Math.abs(p.x - q.x) < NODE && Math.abs(p.y - q.y) < NODE;
const cross = (u: Point, v: Point): number => u.x * v.y - u.y * v.x;
const keyOf = (id: string, end: End): string => `${id}:${end}`;

/** A line through `o` along the unit vector `u`. */
interface Line {
  o: Point;
  u: Point;
}

function dirOf(w: Wall): Point {
  const len = dist(w.a, w.b);
  return { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len };
}

const lineOf = (w: Wall): Line => ({ o: w.a, u: dirOf(w) });

/** Where two lines cross, or null when they are parallel. */
function meet(l: Line, m: Line): Point | null {
  const d = cross(l.u, m.u);
  if (Math.abs(d) < 1e-12) return null;
  const t = cross({ x: m.o.x - l.o.x, y: m.o.y - l.o.y }, m.u) / d;
  return pt(l.o.x + l.u.x * t, l.o.y + l.u.y * t);
}

/** The point of `l` nearest to `p`. */
function foot(p: Point, l: Line): Point {
  const t = (p.x - l.o.x) * l.u.x + (p.y - l.o.y) * l.u.y;
  return pt(l.o.x + l.u.x * t, l.o.y + l.u.y * t);
}

/**
 * Do two walls run along each other, or cross where neither of them ends?
 * Meeting end to end, or one's end on the other's body, is how walls join.
 */
function clash(a: Wall, b: Wall): boolean {
  const la = dist(a.a, a.b);
  const lb = dist(b.a, b.b);
  if (la < 1e-9 || lb < 1e-9) return false;
  const u = { x: (a.b.x - a.a.x) / la, y: (a.b.y - a.a.y) / la };
  const v = { x: (b.b.x - b.a.x) / lb, y: (b.b.y - b.a.y) / lb };
  const off = (p: Point) => (p.x - a.a.x) * u.y - (p.y - a.a.y) * u.x;
  if (Math.abs(off(b.a)) < NODE && Math.abs(off(b.b)) < NODE) {
    const t = (p: Point) => (p.x - a.a.x) * u.x + (p.y - a.a.y) * u.y;
    const lo = Math.min(t(b.a), t(b.b));
    const hi = Math.max(t(b.a), t(b.b));
    return Math.min(hi, la) - Math.max(lo, 0) > 0.01;
  }
  const d = cross(u, v);
  if (Math.abs(d) < 1e-12) return false;
  const w = { x: b.a.x - a.a.x, y: b.a.y - a.a.y };
  const t = cross(w, v) / d;
  const s = cross(w, u) / d;
  return t > NODE && t < la - NODE && s > NODE && s < lb - NODE;
}

/**
 * Is `p` neither joined to the wall nor clear of it? Within a centimetre of
 * it but not on it, or on it but within a centimetre of its corner without
 * being at the corner: room detection would join what the plan doesn't, or
 * miss a join the plan has.
 */
function limbo(p: Point, w: Wall): boolean {
  const d = distToSegment(p, w.a, w.b);
  if (d >= NEAR) return false;
  if (d >= NODE) return true;
  const e = Math.min(dist(p, w.a), dist(p, w.b));
  return e >= NODE && e < NEAR + 1e-6;
}

/** Is `p` on the wall's body — on it, and not at either end? */
const onBody = (p: Point, w: Wall): boolean => !near(p, w.a) && !near(p, w.b) && distToSegment(p, w.a, w.b) < NODE;

// ---------- finding what touches what, fast enough for a campus ----------

const CELL = 4;
const cellKey = (i: number, j: number): string => `${i},${j}`;

/** Wall ends and wall bodies, bucketed on a coarse grid. */
class Index {
  private ends = new Map<string, { w: Wall; end: End }[]>();
  private bodies = new Map<string, Wall[]>();
  /** Walls too long to bucket: always looked at. */
  private long: Wall[] = [];

  constructor(walls: readonly Wall[]) {
    for (const w of walls) {
      for (const end of ENDS) {
        const k = cellKey(Math.floor(w[end].x / CELL), Math.floor(w[end].y / CELL));
        const list = this.ends.get(k);
        if (list) list.push({ w, end });
        else this.ends.set(k, [{ w, end }]);
      }
      const [i0, j0, i1, j1] = this.cells(w.a, w.b);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) {
        this.long.push(w);
        continue;
      }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const list = this.bodies.get(cellKey(i, j));
          if (list) list.push(w);
          else this.bodies.set(cellKey(i, j), [w]);
        }
      }
    }
  }

  private cells(a: Point, b: Point): [number, number, number, number] {
    return [
      Math.floor((Math.min(a.x, b.x) - NEAR) / CELL),
      Math.floor((Math.min(a.y, b.y) - NEAR) / CELL),
      Math.floor((Math.max(a.x, b.x) + NEAR) / CELL),
      Math.floor((Math.max(a.y, b.y) + NEAR) / CELL),
    ];
  }

  /** Ends of other walls at `p`. */
  endsAt(p: Point, not: string): { w: Wall; end: End }[] {
    const out: { w: Wall; end: End }[] = [];
    const [i0, j0, i1, j1] = this.cells(p, p);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const r of this.ends.get(cellKey(i, j)) ?? []) {
          if (r.w.id !== not && near(r.w[r.end], p)) out.push(r);
        }
      }
    }
    return out;
  }

  /** Walls whose body (not an end) `p` rests on. */
  hostsOf(p: Point, not: string): Wall[] {
    const seen = new Set<string>();
    const out: Wall[] = [];
    const [i0, j0, i1, j1] = this.cells(p, p);
    const look = (w: Wall) => {
      if (w.id === not || seen.has(w.id)) return;
      seen.add(w.id);
      if (onBody(p, w)) out.push(w);
    };
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) for (const w of this.bodies.get(cellKey(i, j)) ?? []) look(w);
    }
    for (const w of this.long) look(w);
    return out;
  }

  /** Walls that may come near the segment a–b. */
  wallsNear(a: Point, b: Point): Wall[] {
    const [i0, j0, i1, j1] = this.cells(a, b);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) return [...new Set([...this.bodies.values()].flat()), ...this.long];
    const seen = new Set<Wall>(this.long);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) for (const w of this.bodies.get(cellKey(i, j)) ?? []) seen.add(w);
    }
    return [...seen];
  }

  /** Ends of other walls resting on the body of `w`. */
  ridersOn(w: Wall): { w: Wall; end: End }[] {
    return this.endsAround(w).filter((r) => onBody(r.w[r.end], w));
  }

  /** Ends of other walls that may come within a centimetre of `w`. */
  endsAround(w: Wall): { w: Wall; end: End }[] {
    const out: { w: Wall; end: End }[] = [];
    const [i0, j0, i1, j1] = this.cells(w.a, w.b);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) {
      // A very long wall: look at every end instead of every cell.
      for (const list of this.ends.values()) for (const r of list) if (r.w.id !== w.id) out.push(r);
      return out;
    }
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) for (const r of this.ends.get(cellKey(i, j)) ?? []) if (r.w.id !== w.id) out.push(r);
    }
    return out;
  }
}

// ---------- what each end does ----------

/**
 * How one wall end moves.
 *  - rigid: by the move (a selected end, or one where selected walls meet).
 *  - slide: a selected end that met one straight run of walls that stay: it
 *    goes to where its moved line meets that run.
 *  - follow: an end that stays joined to a sliding selected end.
 *  - meet: an end that stays on its own line, to where that line meets the
 *    moved line of selected wall `wall`; bridged to where the selected end
 *    `corner` went, when it met one.
 *  - step: like meet, for lines too close to parallel: the end goes to the
 *    foot of where `corner` went on its own line, and a short wall bridges it.
 */
type Rule =
  | { k: 'slide'; line: Line }
  | { k: 'follow'; key: string }
  | { k: 'meet'; wall: string; corner: string | null }
  | { k: 'step'; wall: string; corner: string };

/** Why a move was refused. */
export type Refusal = 'short' | 'detach' | 'opening' | 'overlap';

export interface GroupMove {
  readonly walls: Wall[];
  readonly openings: Opening[];
  readonly selected: ReadonlySet<string>;
  readonly selectedOpenings: ReadonlySet<string>;
  readonly rules: ReadonlyMap<string, Rule>;
  /** Walls that may change: the selected ones and those joined to them. */
  readonly changed: ReadonlySet<string>;
  /** An end resting on another wall's body that must stay on it: [wall, end, host]. */
  readonly contacts: readonly [string, End, string][];
  readonly byId: ReadonlyMap<string, Wall>;
  /** The walls that can't change, to check moved ones against. */
  readonly stillIndex: Index;
  /** Where in `openings` each wall's doors and windows are: only those on one wall can crowd each other. */
  readonly openingsOn: ReadonlyMap<string, readonly number[]>;
}

/**
 * Everything a move of these walls (and of these doors and windows) needs
 * that doesn't depend on how far it goes: worked out once, when a drag starts.
 */
export function prepareGroupMove(
  plan: Pick<PlanData, 'walls' | 'openings'>,
  wallIds: readonly string[],
  openingIds: readonly string[] = [],
): GroupMove {
  const byId = new Map(plan.walls.filter((w) => dist(w.a, w.b) > 1e-9).map((w) => [w.id, w]));
  const selected = new Set(wallIds.filter((id) => byId.has(id)));
  const index = new Index([...byId.values()]);
  const rules = new Map<string, Rule>();

  // The selected walls' ends.
  for (const id of selected) {
    const s = byId.get(id)!;
    for (const end of ENDS) {
      const p = s[end];
      const partners = index.endsAt(p, id).filter((r) => byId.has(r.w.id));
      const hosts = index.hostsOf(p, id);
      if (partners.some((r) => selected.has(r.w.id)) || hosts.some((h) => selected.has(h.id))) continue; // rigid
      // The walls that stay here and cross this one's line (those running on along it are bridged, not met):
      // if they all lie along one line, this end slides along it.
      const u = dirOf(s);
      const across = [...partners.map((r) => r.w), ...hosts].filter(
        (w) => !selected.has(w.id) && Math.abs(cross(dirOf(w), u)) >= PARALLEL,
      );
      if (!across.length) continue; // rigid
      const run = dirOf(across[0]);
      if (across.every((w) => Math.abs(cross(dirOf(w), run)) < 1e-9)) {
        rules.set(keyOf(id, end), { k: 'slide', line: { o: p, u: run } });
      }
    }
  }

  // Ends of walls that stay, joined end to end with a selected wall.
  for (const id of selected) {
    const s = byId.get(id)!;
    for (const end of ENDS) {
      const p = s[end];
      const partners = index.endsAt(p, id).filter((r) => byId.has(r.w.id));
      const atCorner = [{ w: s, end }, ...partners.filter((r) => selected.has(r.w.id))];
      const corner = keyOf(id, end);
      const sliding = rules.get(corner)?.k === 'slide';
      for (const r of partners) {
        const k = keyOf(r.w.id, r.end);
        if (selected.has(r.w.id) || rules.has(k)) continue;
        const u = dirOf(r.w);
        if (sliding) {
          // Along the line the end slides on: it goes with it. Running on along the moved wall: a step.
          rules.set(k, Math.abs(cross(dirOf(s), u)) >= PARALLEL ? { k: 'follow', key: corner } : { k: 'step', wall: id, corner });
          continue;
        }
        // The selected wall here most nearly square to this one gives the line it meets.
        let best = atCorner[0];
        for (const c of atCorner) if (Math.abs(cross(dirOf(c.w), u)) > Math.abs(cross(dirOf(best.w), u))) best = c;
        const at = keyOf(best.w.id, best.end);
        rules.set(
          k,
          Math.abs(cross(dirOf(best.w), u)) >= PARALLEL
            ? { k: 'meet', wall: best.w.id, corner: at }
            : { k: 'step', wall: best.w.id, corner: at },
        );
      }
    }
  }

  // Ends of walls that stay, resting on a selected wall's body.
  for (const id of selected) {
    const s = byId.get(id)!;
    for (const r of index.ridersOn(s)) {
      const k = keyOf(r.w.id, r.end);
      if (selected.has(r.w.id) || rules.has(k)) continue;
      rules.set(k, { k: 'meet', wall: id, corner: null });
    }
  }

  const changed = new Set(selected);
  for (const k of rules.keys()) changed.add(k.slice(0, k.lastIndexOf(':')));

  // Every end-on-body contact a changed wall is part of.
  const contacts: [string, End, string][] = [];
  const seen = new Set<string>();
  const keep = (wall: string, end: End, host: string) => {
    const k = `${wall}:${end}>${host}`;
    if (seen.has(k)) return;
    seen.add(k);
    contacts.push([wall, end, host]);
  };
  for (const id of changed) {
    const w = byId.get(id)!;
    for (const end of ENDS) for (const h of index.hostsOf(w[end], id)) keep(id, end, h.id);
    for (const r of index.ridersOn(w)) keep(r.w.id, r.end, id);
  }

  const stillIndex = new Index(plan.walls.filter((w) => !changed.has(w.id) && dist(w.a, w.b) > 1e-9));
  const openingsOn = new Map<string, number[]>();
  plan.openings.forEach((o, i) => {
    const list = openingsOn.get(o.wallId);
    if (list) list.push(i);
    else openingsOn.set(o.wallId, [i]);
  });

  return {
    walls: plan.walls,
    openings: plan.openings,
    selected,
    selectedOpenings: new Set(openingIds),
    rules,
    changed,
    contacts,
    byId,
    stillIndex,
    openingsOn,
  };
}

export type GroupMoveResult =
  | { ok: true; walls: Wall[]; openings: Opening[] }
  | { ok: false; why: Refusal };

/**
 * The walls and openings after moving by `delta`, or why that move is refused.
 * `newId(key)` names a bridging wall; the same key comes back for the same
 * bridge throughout a drag, so give back the same id.
 */
export function moveGroup(m: GroupMove, delta: Point, newId: (key: string) => string): GroupMoveResult {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return { ok: false, why: 'detach' };
  if (Math.abs(delta.x) < 1e-9 && Math.abs(delta.y) < 1e-9) return { ok: true, walls: m.walls, openings: m.openings };
  const moved = (p: Point): Point => pt(p.x + delta.x, p.y + delta.y);
  const movedLine = (w: Wall): Line => ({ o: moved(w.a), u: dirOf(w) });

  // Where each end of a changed wall goes.
  const done = new Map<string, Point | null>();
  const pointAt = (key: string): Point | null => {
    const at = key.lastIndexOf(':');
    return pointOf(key.slice(0, at), key.slice(at + 1) as End);
  };
  const pointOf = (id: string, end: End): Point | null => {
    const k = keyOf(id, end);
    if (done.has(k)) return done.get(k)!;
    done.set(k, null); // rules never loop, but if one did it would end here, refused
    const w = m.byId.get(id)!;
    const rule = m.rules.get(k);
    let p: Point | null;
    if (m.selected.has(id)) p = rule?.k === 'slide' ? meet(movedLine(w), rule.line) : moved(w[end]);
    else if (!rule || rule.k === 'slide') p = w[end];
    else if (rule.k === 'follow') p = pointAt(rule.key);
    else if (rule.k === 'meet') p = meet(lineOf(w), movedLine(m.byId.get(rule.wall)!));
    else {
      const c = pointAt(rule.corner);
      p = c && foot(c, lineOf(w));
    }
    done.set(k, p);
    return p;
  };

  const walls: Wall[] = [];
  const now = new Map<string, Wall>();
  for (const w of m.walls) {
    if (!m.changed.has(w.id)) {
      walls.push(w);
      continue;
    }
    const a = pointOf(w.id, 'a');
    const b = pointOf(w.id, 'b');
    if (!a || !b) return { ok: false, why: 'detach' };
    // Still pointing the same way, and not shrunk to nothing.
    if (dist(a, b) < MIN_WALL || (b.x - a.x) * (w.b.x - w.a.x) + (b.y - a.y) * (w.b.y - w.a.y) <= 0) {
      return { ok: false, why: 'short' };
    }
    const next = a.x === w.a.x && a.y === w.a.y && b.x === w.b.x && b.y === w.b.y ? w : { ...w, a, b };
    walls.push(next);
    now.set(w.id, next);
  }
  const final = (id: string): Wall => now.get(id) ?? m.byId.get(id)!;

  // Nothing that rested on a wall comes off it.
  for (const [id, end, host] of m.contacts) {
    const h = final(host);
    if (distToSegment(final(id)[end], h.a, h.b) > NODE) return { ok: false, why: 'detach' };
  }

  // Bridges where a corner moved away from a wall that stays.
  const bridges: Wall[] = [];
  for (const [k, rule] of m.rules) {
    if ((rule.k !== 'meet' && rule.k !== 'step') || !rule.corner) continue;
    const from = pointAt(k);
    const to = pointAt(rule.corner);
    if (!from || !to) return { ok: false, why: 'detach' };
    const levels = m.byId.get(rule.wall)!.levels;
    let n = 0;
    for (const [a, b] of gapsAlong(from, to, walls)) {
      // Cleanup drops walls under a centimetre, which would leave the corner open.
      if (dist(a, b) < 0.01) return { ok: false, why: 'short' };
      const w: Wall = { id: newId(n === 0 ? k : `${k}#${n}`), a, b, ...(levels !== undefined ? { levels } : {}) };
      walls.push(w);
      bridges.push(w);
      n++;
    }
  }

  // No moved wall or bridge newly runs along another wall or crosses one mid-way
  // (what already did before the move is not this move's doing).
  const moving = [...now.values(), ...bridges];
  for (const w of moving) {
    const was = m.byId.get(w.id);
    for (const o of m.stillIndex.wallsNear(w.a, w.b)) {
      if (clash(w, o) && !(was && clash(was, o))) return { ok: false, why: 'overlap' };
    }
  }
  for (let i = 0; i < moving.length; i++) {
    const w = moving[i];
    // Selected walls move together: between two of them nothing new can happen.
    if (m.selected.has(w.id)) continue;
    const was = m.byId.get(w.id);
    for (let j = 0; j < moving.length; j++) {
      const o = moving[j];
      if (i === j || (j < i && !m.selected.has(o.id))) continue;
      const before = m.byId.get(o.id);
      if (clash(w, o) && !(was && before && clash(was, before))) return { ok: false, why: 'overlap' };
    }
  }

  // Every end of what moved either joins a wall cleanly or keeps clear of it (see `limbo`).
  const was = (w: Wall): Wall | undefined => m.byId.get(w.id);
  for (const w of moving) {
    const w0 = was(w);
    // A selected wall that only moved along with the rest can't newly meet another selected one.
    const reshaped = !m.selected.has(w.id) || m.rules.has(keyOf(w.id, 'a')) || m.rules.has(keyOf(w.id, 'b'));
    for (const end of ENDS) {
      const others = reshaped ? [...m.stillIndex.wallsNear(w[end], w[end]), ...moving] : m.stillIndex.wallsNear(w[end], w[end]);
      for (const o of others) {
        if (o.id === w.id || !limbo(w[end], o)) continue;
        const o0 = m.byId.get(o.id) ?? o;
        if (!(w0 && limbo(w0[end], o0))) return { ok: false, why: 'short' };
      }
    }
    for (const r of m.stillIndex.endsAround(w)) {
      const p = r.w[r.end];
      if (limbo(p, w) && !(w0 && limbo(p, w0))) return { ok: false, why: 'short' };
    }
  }

  const openings = moveOpenings(m, delta, final);
  return openings ? { ok: true, walls, openings } : { ok: false, why: 'opening' };
}

/**
 * Doors and windows after the walls moved: on a moved wall they go with it;
 * a selected one on a wall that stays slides along it by as much of the move
 * as runs along the wall; any other stays exactly where it is. One whose wall
 * got too short around it there is pushed along the wall just far enough to
 * fit. Null when one no longer fits anywhere on its wall.
 */
function moveOpenings(m: GroupMove, delta: Point, final: (id: string) => Wall): Opening[] | null {
  const center = (o: Opening, w: Wall): Point => {
    const u = dirOf(w);
    return { x: w.a.x + u.x * o.offset, y: w.a.y + u.y * o.offset };
  };
  const along = (c: Point, w: Wall): number => {
    const u = dirOf(w);
    return (c.x - w.a.x) * u.x + (c.y - w.a.y) * u.y;
  };
  const fits = (offset: number, width: number, w: Wall): boolean => {
    const half = width / 2 + OPENING_GAP;
    return offset >= half - 1e-6 && offset <= dist(w.a, w.b) - half + 1e-6;
  };

  const out = m.openings.slice();
  const onWall = (wallId: string): Opening[] => (m.openingsOn.get(wallId) ?? []).map((j) => out[j]);
  const clear = (o: Opening, offset: number): boolean =>
    onWall(o.wallId).every(
      (q) => q.id === o.id || Math.abs(q.offset - offset) >= (q.width + o.width) / 2 + OPENING_GAP - 1e-6,
    );

  const sliding: number[] = [];
  const placed: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    const before = m.byId.get(o.wallId);
    if (!before) continue;
    const slides = m.selectedOpenings.has(o.id) && !m.selected.has(o.wallId);
    if (!m.changed.has(o.wallId) && !slides) continue;
    if (slides) {
      sliding.push(i); // after the others are in place, so it can find room among them
      continue;
    }
    const after = final(o.wallId);
    const c = center(o, before);
    const offset = r6(along(m.selected.has(o.wallId) ? { x: c.x + delta.x, y: c.y + delta.y } : c, after));
    if (offset !== o.offset) out[i] = { ...o, offset };
    placed.push(i);
  }
  // Those left without room where they were: pushed along their wall to the nearest place that fits.
  for (const i of placed) {
    const o = out[i];
    const after = final(o.wallId);
    if (fits(o.offset, o.width, after) && clear(o, o.offset)) continue;
    const offset = slideOpening(onWall(o.wallId), after, o.id, o.width, o.offset);
    if (offset === null) return null;
    out[i] = { ...o, offset: r6(offset) };
  }
  for (const i of sliding) {
    const o = out[i];
    const before = m.byId.get(o.wallId)!;
    const after = final(o.wallId);
    const u = dirOf(before);
    const run = delta.x * u.x + delta.y * u.y;
    const c = center(o, before);
    const want = along({ x: c.x + u.x * run, y: c.y + u.y * run }, after);
    const offset = slideOpening(onWall(o.wallId), after, o.id, o.width, want);
    if (offset === null) return null;
    if (r6(offset) !== o.offset) out[i] = { ...o, offset: r6(offset) };
  }
  return out;
}

/**
 * The stretches of the segment `from`→`to` that no wall lying along it covers,
 * in order. Empty when walls already cover all of it.
 */
function gapsAlong(from: Point, to: Point, walls: readonly Wall[]): [Point, Point][] {
  const len = dist(from, to);
  if (len < NODE) return [];
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const across = (p: Point) => (p.x - from.x) * uy - (p.y - from.y) * ux;
  const along = (p: Point) => (p.x - from.x) * ux + (p.y - from.y) * uy;
  const covered = walls
    .filter((w) => Math.abs(across(w.a)) < NODE && Math.abs(across(w.b)) < NODE)
    .map((w): [number, number] => [Math.min(along(w.a), along(w.b)), Math.max(along(w.a), along(w.b))])
    .filter(([lo, hi]) => hi > NODE && lo < len - NODE)
    .sort((p, q) => p[0] - q[0]);
  const at = (t: number): Point => pt(from.x + ux * t, from.y + uy * t);
  const gaps: [Point, Point][] = [];
  let t = 0;
  for (const [lo, hi] of covered) {
    if (lo > t + NODE) gaps.push([at(t), at(Math.min(lo, len))]);
    t = Math.max(t, hi);
    if (t >= len - NODE) break;
  }
  if (t < len - NODE) gaps.push([at(t), at(len)]);
  return gaps.filter(([a, b]) => dist(a, b) > NODE);
}

/**
 * Room names after a move. A room is named by the set of walls around it, so
 * a room this move changed (a bridge joined its walls) would lose its name:
 * each name whose room was there before the move and is gone after it passes
 * to the new room that shares most of its walls (at least half of the two
 * rooms' walls together; the larger room on a tie). Names that matched no
 * room before the move are left exactly as they were. `roomsOf` finds the
 * rooms of a set of walls (a cached one saves working them out again).
 */
export function carryRoomNames(
  names: Record<string, string>,
  before: Wall[],
  after: Wall[],
  roomsOf: (walls: Wall[]) => DetectedRoom[] = detectRooms,
): Record<string, string> {
  const entries = Object.entries(names);
  if (!entries.length || before === after) return names;
  const afterRooms = roomsOf(after);
  const afterKeys = new Set(afterRooms.map((r) => r.key));
  if (entries.every(([k]) => afterKeys.has(k))) return names;
  const beforeKeys = new Set(roomsOf(before).map((r) => r.key));
  const wallsOf = (key: string) => new Set(key.split('#')[0].split('|'));
  const fresh = afterRooms
    .filter((r) => !beforeKeys.has(r.key))
    .map((r) => ({ key: r.key, ids: wallsOf(r.key), area: r.area }));

  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const [k, name] of entries) {
    if (afterKeys.has(k)) {
      out[k] = name;
      taken.add(k);
    }
  }
  for (const [k, name] of entries) {
    if (afterKeys.has(k)) continue;
    if (!beforeKeys.has(k)) {
      out[k] = name; // not this move's doing
      continue;
    }
    const ids = [...wallsOf(k)];
    let best: (typeof fresh)[number] | null = null;
    let bestScore = 0;
    for (const r of fresh) {
      if (taken.has(r.key)) continue;
      const shared = ids.filter((id) => r.ids.has(id)).length;
      const score = shared / (ids.length + r.ids.size - shared);
      if (score >= 0.5 - 1e-9 && (score > bestScore + 1e-9 || (score > bestScore - 1e-9 && r.area > best!.area))) {
        bestScore = score;
        best = r;
      }
    }
    if (best) {
      out[best.key] = name;
      taken.add(best.key);
    } else out[k] = name;
  }
  return out;
}
