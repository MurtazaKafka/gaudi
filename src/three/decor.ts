/**
 * Room details for the 3D view: rugs, pictures, lamps, cushions, books,
 * plants, a mirror over the basin, a coat stand by the front door. Never part
 * of the plan — the model dresses itself from what the plan says each room is
 * and what furniture stands in it.
 *
 * Deterministic: every choice is hashed from positions, so the same plan is
 * dressed the same way every time. Things are placed with care — clear of
 * furniture footprints, door swings and each other, and wall pieces clear of
 * windows and doors — and with restraint: a few things per room, never clutter.
 *
 * Everything is merged into one mesh per finish (see decorShapes.ts).
 */
import type * as THREE from 'three';
import type { PlacedOpening, WallPiece } from '../build';
import { furnitureDef, isBuiltinKind } from '../catalog';
import { DOUBLE_DOOR_MIN } from '../openingSizes';
import { pointInPolygon } from '../geometry';
import type { DetectedRoom } from '../rooms';
import { liftOf, restOf, type RestMap } from '../stacking';
import { roomKindFromName } from '../roomTypes';
import type { RoomKind } from '../roomTypes';
import type { Furniture, PlanSettings, Point } from '../types';
import { Bag, mix, Pen } from './decorShapes';
import * as D from './decorThings';
import type { Tones } from './decorThings';
import { DOOR_AJAR } from './house';
import { furniturePalette } from './styles';
import type { HouseStyle } from './styles';

export interface DecorInput {
  rooms: DetectedRoom[];
  roomNames: Record<string, string>;
  furniture: Furniture[];
  openings: PlacedOpening[];
  pieces: WallPiece[];
  settings: PlanSettings;
  style: HouseStyle;
  /** Rooms open to the sky. */
  open: ReadonlySet<string>;
  /** True when the clock says the lamps are on. */
  evening: boolean;
}

// ---------- plan geometry ----------

/** An oriented rectangle on the plan: centre, half sizes, and the angle of its local x axis. */
interface Box2 {
  x: number;
  y: number;
  hx: number;
  hy: number;
  a: number;
}

function cornersOf(b: Box2): Point[] {
  const c = Math.cos(b.a);
  const s = Math.sin(b.a);
  const out: Point[] = [];
  for (const [u, v] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    out.push({ x: b.x + c * u * b.hx - s * v * b.hy, y: b.y + s * u * b.hx + c * v * b.hy });
  }
  return out;
}

/** Separating-axis test for two oriented rectangles. */
function overlaps(p: Box2, q: Box2): boolean {
  const pc = cornersOf(p);
  const qc = cornersOf(q);
  for (const a of [p.a, p.a + Math.PI / 2, q.a, q.a + Math.PI / 2]) {
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    let p0 = Infinity;
    let p1 = -Infinity;
    let q0 = Infinity;
    let q1 = -Infinity;
    for (const c of pc) {
      const d = c.x * ax + c.y * ay;
      p0 = Math.min(p0, d);
      p1 = Math.max(p1, d);
    }
    for (const c of qc) {
      const d = c.x * ax + c.y * ay;
      q0 = Math.min(q0, d);
      q1 = Math.max(q1, d);
    }
    if (p1 <= q0 || q1 <= p0) return false;
  }
  return true;
}

const grow = (b: Box2, m: number): Box2 => ({ ...b, hx: b.hx + m, hy: b.hy + m });

function insideBox(p: Point, b: Box2): boolean {
  const c = Math.cos(b.a);
  const s = Math.sin(b.a);
  const dx = p.x - b.x;
  const dy = p.y - b.y;
  return Math.abs(dx * c + dy * s) < b.hx && Math.abs(-dx * s + dy * c) < b.hy;
}

function segDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Drop vertices that sit in the middle of a straight run (T-junction splits). */
function simplify(poly: Point[]): Point[] {
  const out: Point[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[(i + n - 1) % n];
    const b = poly[i];
    const c = poly[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  return out.length >= 3 ? out : poly;
}

// ---------- the house as the dresser sees it ----------

/** One long inside face of a room's wall. Positions along it are `s`, from its start. */
interface Face {
  /** Where the inside face starts (plan). */
  ox: number;
  oy: number;
  /** Along the face, and into the room. */
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  /** The usable stretch of the face. */
  lo: number;
  hi: number;
  /** Stretches taken by doors, windows (with their curtains) and things already hung. */
  blocked: [number, number][];
  /** Stretches in front of windows (curtains included): nothing tall stands there. */
  windows: [number, number][];
}

interface Item {
  f: Furniture;
  kind: string;
  w: number;
  d: number;
  h: number;
  box: Box2;
  room: Room | null;
  seed: number;
  /** How high it stands: 0 on the floor, the table top for something on a table (stacking.ts). */
  lift: number;
  /** It stands on something else, so it takes up no floor of its own. */
  raised: boolean;
  /** The user has put something on it: its surfaces are theirs, not ours to dress. */
  loaded: boolean;
}

interface Room {
  key: string;
  kind: RoomKind;
  poly: Point[];
  faces: Face[];
  items: Item[];
  area: number;
  seed: number;
}

/** The top of the floors (house.ts lays them a centimetre up). */
const FLOOR = 0.01;

/** Furniture a rug may run under. */
const UNDER_RUG = new Set(['sofa', 'armchair', 'coffee_table', 'chair', 'bed_double', 'bed_single', 'nightstand']);

/** How high a thing reaches when deciding whether a picture can hang above it (a lamp on a sideboard reaches higher). */
const blockHeight = (it: Pick<Item, 'kind' | 'h' | 'lift'>): number => it.lift + (it.kind === 'tv_stand' ? 1.4 : it.h + 0.1);

function kindSeed(kind: string): number {
  let h = 7;
  for (const ch of kind) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

class Dresser {
  readonly bag = new Bag();
  readonly t: Tones;
  readonly rooms: Room[] = [];
  readonly items: Item[] = [];
  /** Where door leaves swing: nothing stands there. */
  readonly swings: Box2[] = [];
  /** The door leaves themselves, standing ajar: even a rug keeps out from under them. */
  readonly leaves: Box2[] = [];
  /** In front of each doorway, both sides: kept clear of anything that stands up. */
  readonly passages: Box2[] = [];
  /** Floor taken by dressing already placed, with its height. */
  readonly floor: { box: Box2; h: number }[] = [];
  readonly half: number;
  readonly wallH: number;
  readonly frontDoors: { o: PlacedOpening; nx: number; ny: number }[] = [];

  readonly input: DecorInput;

  constructor(input: DecorInput) {
    this.input = input;
    this.t = D.tonesFor(input.style, furniturePalette(input.style));
    this.half = Math.max(0.02, input.settings.wallThickness / 2);
    this.wallH = input.settings.wallHeight;
    this.collectRooms();
    this.collectOpenings();
    this.collectItems();
  }

  private collectRooms(): void {
    const { rooms, roomNames, open } = this.input;
    for (const r of rooms) {
      if (open.has(r.key) || r.polygon.length < 3) continue;
      const kind = roomKindFromName(roomNames[r.key]);
      if (kind === 'outdoor' || kind === 'garage') continue;
      const poly = simplify(r.polygon);
      let signed = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        signed += a.x * b.y - b.x * a.y;
      }
      const faces: Face[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 0.3) continue;
        const dx = (b.x - a.x) / len;
        const dy = (b.y - a.y) / len;
        const nx = signed > 0 ? -dy : dy;
        const ny = signed > 0 ? dx : -dx;
        faces.push({
          ox: a.x + nx * this.half,
          oy: a.y + ny * this.half,
          dx,
          dy,
          nx,
          ny,
          lo: this.half + 0.1,
          hi: len - this.half - 0.1,
          blocked: [],
          windows: [],
        });
      }
      this.rooms.push({
        key: r.key,
        kind,
        poly,
        faces,
        items: [],
        area: r.area,
        seed: D.rand(r.centroid.x, r.centroid.y, r.area),
      });
    }
  }

  private collectOpenings(): void {
    const outer = new Map<string, 1 | -1 | 0>();
    for (const p of this.input.pieces) {
      // Read from the ground, as house.ts does: higher up a wall may face out over a lower wing's roof.
      if (p.stacked || outer.get(p.wallId)) continue;
      outer.set(p.wallId, p.pOuter && !p.mOuter ? -1 : p.mOuter && !p.pOuter ? 1 : 0);
    }
    for (const o of this.input.openings) {
      if (![o.x, o.y, o.angle, o.width].every(Number.isFinite) || o.width < 0.1) continue;
      const ax = Math.cos(o.angle);
      const ay = Math.sin(o.angle);
      // The opening's +z (the wall's p side) on the plan.
      const px = -ay;
      const py = ax;
      if (o.type === 'door') {
        const w = o.width;
        // Leaves stand ajar toward the opening's −z side.
        const deep = w / 2 + o.thickness / 2 + 0.05;
        this.swings.push({ x: o.x - px * deep, y: o.y - py * deep, hx: w / 2 + 0.1, hy: deep, a: o.angle });
        // As house.ts hangs them: from the jamb, DOOR_AJAR toward −z (a pair from both jambs when wide).
        const inside = outer.get(o.wallId) ?? 0;
        if (inside === 0 || this.input.style.id === 'maquette') {
          const pair = w >= DOUBLE_DOOR_MIN;
          const lw = pair ? w / 2 : w;
          for (const dir of pair ? [1, -1] : [1]) {
            const hx = o.x - ax * dir * (w / 2);
            const hy = o.y - ay * dir * (w / 2);
            const cx = dir * Math.cos(DOOR_AJAR);
            const cz = -Math.sin(DOOR_AJAR);
            const vx = cx * ax + cz * px;
            const vy = cx * ay + cz * py;
            this.leaves.push({ x: hx + (vx * lw) / 2, y: hy + (vy * lw) / 2, hx: lw / 2 + 0.08, hy: 0.1, a: Math.atan2(vy, vx) });
          }
        }
        this.passages.push({ x: o.x, y: o.y, hx: w / 2 + 0.08, hy: o.thickness / 2 + 0.75, a: o.angle });
        if (inside !== 0) this.frontDoors.push({ o, nx: px * inside, ny: py * inside });
      }
      // Mark the stretch on every room face that runs along this wall.
      for (const room of this.rooms) {
        for (const f of room.faces) {
          if (Math.abs(ax * f.dx + ay * f.dy) < 0.98) continue;
          // Distance from the opening's centre to the face's wall axis.
          const ex = o.x - (f.ox - f.nx * this.half);
          const ey = o.y - (f.oy - f.ny * this.half);
          if (Math.abs(ex * f.nx + ey * f.ny) > 0.05) continue;
          const s = ex * f.dx + ey * f.dy;
          const m = o.type === 'window' ? 0.3 : 0.14;
          if (s + o.width / 2 + m < 0 || s - o.width / 2 - m > f.hi + this.half + 0.1) continue;
          f.blocked.push([s - o.width / 2 - m, s + o.width / 2 + m]);
          if (o.type === 'window') f.windows.push([s - o.width / 2 - m, s + o.width / 2 + m]);
        }
      }
    }
  }

  private collectItems(): void {
    let rest: RestMap = new Map();
    try {
      rest = restOf(this.input.furniture, furnitureDef);
    } catch {
      // Everything on the floor, as before stacking.
    }
    const loaded = new Set<string>();
    for (const r of rest.values()) if (r.on) loaded.add(r.on);
    for (const f of this.input.furniture) {
      if (![f.x, f.y, f.rotation].every(Number.isFinite)) continue;
      let def;
      try {
        def = furnitureDef(f.kind);
      } catch {
        continue;
      }
      if (!def || !(def.w > 0) || !(def.d > 0)) continue;
      const room = this.rooms.find((r) => pointInPolygon({ x: f.x, y: f.y }, r.poly)) ?? null;
      const item: Item = {
        f,
        kind: isBuiltinKind(f.kind) ? f.kind : 'custom',
        w: def.w,
        d: def.d,
        h: def.h,
        box: { x: f.x, y: f.y, hx: def.w / 2, hy: def.d / 2, a: f.rotation },
        room,
        seed: D.rand(f.x, f.y, f.rotation, kindSeed(f.kind)),
        lift: liftOf(rest, f.id),
        raised: !!rest.get(f.id)?.on,
        loaded: loaded.has(f.id),
      };
      this.items.push(item);
      room?.items.push(item);
    }
  }

  // ---------- where things can go ----------

  /** Is this rectangle of floor inside the room, off the walls, and clear? */
  floorFree(room: Room, box: Box2, opts: { h: number; under?: ReadonlySet<string>; passages?: boolean }): boolean {
    const pts = cornersOf(box);
    const probe = [...pts];
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      probe.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    const keep = this.half + 0.02;
    for (const p of probe) {
      if (!pointInPolygon(p, room.poly)) return false;
      for (let i = 0; i < room.poly.length; i++) {
        if (segDistance(p, room.poly[i], room.poly[(i + 1) % room.poly.length]) < keep) return false;
      }
    }
    for (const v of room.poly) if (insideBox(v, grow(box, this.half))) return false;
    for (const it of this.items) {
      // Whatever stands on another piece takes no floor: the piece under it already keeps us clear.
      if (it.raised || opts.under?.has(it.kind)) continue;
      if (overlaps(box, grow(it.box, 0.03))) return false;
    }
    // Door leaves clear the floor by a few millimetres: a rug may lie under one, nothing else.
    if (opts.h > 0.006) for (const s of this.swings) if (overlaps(box, s)) return false;
    for (const s of this.leaves) if (overlaps(box, s)) return false;
    if (opts.passages !== false) for (const s of this.passages) if (overlaps(box, s)) return false;
    for (const f of this.floor) if (overlaps(box, f.box)) return false;
    return true;
  }

  /** Point on a face at `s`, `out` metres into the room. */
  at(f: Face, s: number, out = 0): Point {
    return { x: f.ox + f.dx * s + f.nx * out, y: f.oy + f.dy * s + f.ny * out };
  }

  /** A pen on a face at `s` and height `y`, z out into the room. */
  wallPen(f: Face, s: number, y: number): Pen {
    const p = this.at(f, s, 0.004);
    return Pen.at(this.bag, p.x, p.y, Math.atan2(-f.nx, f.ny), y);
  }

  /** Can something `w` wide hang on this face at `s`, from height y0 up, standing `depth` proud? */
  wallFree(f: Face, s: number, w: number, y0: number, depth = 0.45): boolean {
    const a = s - w / 2;
    const b = s + w / 2;
    if (a < f.lo || b > f.hi) return false;
    for (const [p, q] of f.blocked) if (a < q && b > p) return false;
    const c = this.at(f, s, depth / 2);
    const strip: Box2 = { x: c.x, y: c.y, hx: w / 2, hy: depth / 2, a: Math.atan2(f.dy, f.dx) };
    for (const it of this.items) if (blockHeight(it) > y0 && overlaps(strip, it.box)) return false;
    for (const fl of this.floor) if (fl.h > y0 && overlaps(strip, fl.box)) return false;
    return true;
  }

  /** Take a stretch of a face. */
  claim(f: Face, s: number, w: number, margin = 0.15): void {
    f.blocked.push([s - w / 2 - margin, s + w / 2 + margin]);
  }

  /** The longest clear stretches of a room's walls at picture height, longest first. */
  clearRuns(room: Room, y0: number): { f: Face; a: number; b: number }[] {
    const runs: { f: Face; a: number; b: number }[] = [];
    for (const f of room.faces) {
      const cuts: [number, number][] = [...f.blocked];
      // Tall furniture against this face takes its stretch too.
      const ang = Math.atan2(f.dy, f.dx);
      const mid = this.at(f, (f.lo + f.hi) / 2, 0.25);
      const strip: Box2 = { x: mid.x, y: mid.y, hx: (f.hi - f.lo) / 2 + 1, hy: 0.25, a: ang };
      const tall = [
        ...this.items.filter((it) => blockHeight(it) > y0).map((it) => it.box),
        ...this.floor.filter((fl) => fl.h > y0).map((fl) => fl.box),
      ];
      for (const box of tall) {
        if (!overlaps(strip, box)) continue;
        let p = Infinity;
        let q = -Infinity;
        for (const c of cornersOf(box)) {
          const s = (c.x - f.ox) * f.dx + (c.y - f.oy) * f.dy;
          p = Math.min(p, s);
          q = Math.max(q, s);
        }
        cuts.push([p - 0.1, q + 0.1]);
      }
      cuts.sort((u, v) => u[0] - v[0]);
      let at = f.lo;
      for (const [p, q] of cuts) {
        if (p > at) runs.push({ f, a: at, b: Math.min(p, f.hi) });
        at = Math.max(at, q);
        if (at >= f.hi) break;
      }
      if (at < f.hi) runs.push({ f, a: at, b: f.hi });
    }
    return runs.filter((r) => r.b - r.a > 0.05).sort((u, v) => v.b - v.a - (u.b - u.a));
  }

  /** The face an item has its back to, and where along it the item's centre is. */
  backWall(it: Item, reach = 0.3): { f: Face; s: number } | null {
    if (!it.room) return null;
    const r = it.f.rotation;
    // Item's front on the plan; its back is the other way.
    const fx = -Math.sin(r);
    const fy = Math.cos(r);
    const bx = it.f.x - fx * (it.d / 2);
    const by = it.f.y - fy * (it.d / 2);
    for (const f of it.room.faces) {
      if (fx * f.nx + fy * f.ny < 0.95) continue;
      const gap = (bx - f.ox) * f.nx + (by - f.oy) * f.ny;
      if (gap < -0.05 || gap > reach) continue;
      const s = (it.f.x - f.ox) * f.dx + (it.f.y - f.oy) * f.dy;
      if (s < f.lo || s > f.hi) continue;
      return { f, s };
    }
    return null;
  }

  /** A pen in an item's own frame, `y` up from its base (which is the table top, for a piece standing on a table). */
  itemPen(it: Item, x: number, y: number, z: number, turn = 0): Pen {
    return Pen.at(this.bag, it.f.x, it.f.y, it.f.rotation).to(x, it.lift + y, z, [0, turn, 0]);
  }

  /** A point in an item's frame, on the plan. */
  itemPoint(it: Item, x: number, z: number): Point {
    const c = Math.cos(it.f.rotation);
    const s = Math.sin(it.f.rotation);
    return { x: it.f.x + c * x - s * z, y: it.f.y + s * x + c * z };
  }

  // ---------- wall pieces ----------

  /** Hang one or two pictures centred at `s` on a face, bottoms at least at `y0`. Returns false if they don't fit. */
  pictures(f: Face, s: number, maxW: number, y0: number, pick: number): boolean {
    const pair = D.rand(pick, 1) < 0.4 && maxW >= 0.95;
    const portrait = !pair && D.rand(pick, 2) < 0.3;
    const h = pair ? 0.6 : portrait ? 0.7 : 0.55 + 0.15 * D.rand(pick, 3);
    const each = pair ? Math.min(0.48, (maxW - 0.12) / 2) : portrait ? Math.min(0.52, maxW) : Math.min(1.15, maxW);
    const total = pair ? each * 2 + 0.12 : each;
    if (each < 0.3) return false;
    const yc = Math.min(this.wallH - 0.3 - h / 2, Math.max(1.5, y0 + h / 2));
    if (yc - h / 2 < y0 - 0.02) return false;
    if (!this.wallFree(f, s, total, yc - h / 2)) return false;
    if (pair) {
      for (const k of [-1, 1]) {
        D.picture(this.wallPen(f, s + k * (each / 2 + 0.06), yc), this.t, each, h, D.rand(pick, 4 + k));
      }
    } else {
      D.picture(this.wallPen(f, s, yc), this.t, each, h, pick);
    }
    this.claim(f, s, total);
    return true;
  }

  /** A picture on the longest clear wall of a room, if there is one long enough. */
  pictureOnLongestWall(room: Room, pick: number, avoid?: Face): boolean {
    const runs = this.clearRuns(room, 1.1).filter((r) => r.f !== avoid);
    for (const run of runs.slice(0, 4)) {
      const len = run.b - run.a;
      if (len < 0.75) break;
      const s = (run.a + run.b) / 2;
      if (this.pictures(run.f, s, Math.min(1.1, len * 0.55), 1.15, pick)) return true;
    }
    return false;
  }

  // ---------- floor pieces ----------

  /** Lay a rug, shrinking it until it fits. `place(w, d)` gives the rug's box for a size. */
  rug(room: Room, w: number, d: number, minW: number, minD: number, place: (w: number, d: number) => Box2, under: ReadonlySet<string>, pick: number, round = false): boolean {
    for (let i = 0; i < 9; i++) {
      const kw = Math.max(minW, w * (1 - 0.1 * Math.min(i, 5)));
      const kd = Math.max(minD, d * (1 - 0.08 * Math.max(0, i - 3)));
      const box = place(kw, kd);
      if (!this.floorFree(room, box, { h: 0.005, under, passages: false })) continue;
      D.rug(Pen.at(this.bag, box.x, box.y, box.a, FLOOR), this.t, box.hx * 2, box.hy * 2, pick, round);
      this.floor.push({ box, h: 0.01 });
      return true;
    }
    return false;
  }

  /** Does this spot stand close in front of a window (where curtains hang)? */
  byWindow(room: Room, spot: Box2): boolean {
    for (const f of room.faces) {
      if (f.windows.length === 0) continue;
      let near = Infinity;
      let a = Infinity;
      let b = -Infinity;
      for (const c of cornersOf(spot)) {
        near = Math.min(near, (c.x - f.ox) * f.nx + (c.y - f.oy) * f.ny);
        const s = (c.x - f.ox) * f.dx + (c.y - f.oy) * f.dy;
        a = Math.min(a, s);
        b = Math.max(b, s);
      }
      if (near > 0.3) continue;
      for (const [p, q] of f.windows) if (a < q && b > p) return true;
    }
    return false;
  }

  /** Try spots in order; stand the thing at the first that is clear. */
  stand(room: Room, spots: Box2[], h: number, draw: (pen: Pen, spot: Box2) => void): Box2 | null {
    for (const spot of spots) {
      if (!this.floorFree(room, spot, { h })) continue;
      if (h > 0.9 && this.byWindow(room, spot)) continue;
      draw(Pen.at(this.bag, spot.x, spot.y, spot.a), spot);
      this.floor.push({ box: spot, h });
      return spot;
    }
    return null;
  }

  /** Convex corners of a room as spots `inset` from both walls, in a repeatable shuffled order. */
  cornerSpots(room: Room, size: number, inset: number): Box2[] {
    const out: { b: Box2; k: number }[] = [];
    const n = room.poly.length;
    let signed = 0;
    for (let i = 0; i < n; i++) {
      const a = room.poly[i];
      const b = room.poly[(i + 1) % n];
      signed += a.x * b.y - b.x * a.y;
    }
    for (let i = 0; i < n; i++) {
      const a = room.poly[(i + n - 1) % n];
      const v = room.poly[i];
      const c = room.poly[(i + 1) % n];
      const cross = (v.x - a.x) * (c.y - v.y) - (v.y - a.y) * (c.x - v.x);
      if (cross * signed <= 0) continue; // a reflex corner
      const l1 = Math.hypot(v.x - a.x, v.y - a.y);
      const l2 = Math.hypot(c.x - v.x, c.y - v.y);
      if (l1 < 0.5 || l2 < 0.5) continue;
      // Step back along both walls.
      const k = this.half + inset;
      const x = v.x + ((a.x - v.x) / l1) * k + ((c.x - v.x) / l2) * k;
      const y = v.y + ((a.y - v.y) / l1) * k + ((c.y - v.y) / l2) * k;
      out.push({ b: { x, y, hx: size / 2, hy: size / 2, a: Math.atan2(c.y - v.y, c.x - v.x) }, k: D.rand(room.seed, i, 3) });
    }
    return out.sort((p, q) => p.k - q.k).map((o) => o.b);
  }

  // ---------- dressing furniture ----------

  dressItem(it: Item): void {
    // A surface the user has put something on is theirs: no vase or cushion of ours among their things.
    // (A bookcase's shelves and the mirror over a basin are not that surface.)
    if (it.loaded && it.kind !== 'bookshelf' && it.kind !== 'bathroom_sink') return;
    const { t } = this;
    const pick = it.seed;
    // Soft furnishings: the style's accents, softened toward linen.
    const soft = [t.accents[0], t.accents[1], ...t.accents.slice(4)];
    const ac = (k: number) => mix(D.choose(soft, D.rand(pick, k)), t.linen, 0.25);
    switch (it.kind) {
      case 'sofa': {
        const x = it.w / 2 - 0.36;
        const c1 = ac(1);
        const c2 = D.rand(pick, 2) < 0.5 ? c1 : mix(t.linen, t.fabric, 0.3);
        D.cushion(this.itemPen(it, -x, 0.5, -it.d / 2 + 0.22, 6), c1, 0.42, 0.42, 16);
        D.cushion(this.itemPen(it, x, 0.5, -it.d / 2 + 0.22, -5), c2, 0.42, 0.42, 14);
        if (it.w > 1.6 && D.rand(pick, 4) < 0.45) {
          D.throwBlanket(this.itemPen(it, it.w / 2 - 0.2, 0.54, 0.02, 90), mix(t.fabricDark, t.linen, 0.3), ac(5), 0.5, 0.28);
        }
        break;
      }
      case 'armchair':
        D.cushion(this.itemPen(it, 0, 0.42, -it.d / 2 + 0.24), ac(1), 0.36, 0.34, 15);
        break;
      case 'bed_double':
      case 'bed_single': {
        const throwW = it.w - 0.12;
        D.throwBlanket(this.itemPen(it, 0, 0.49, it.d / 2 - 0.42), mix(ac(1), t.linen, 0.25), mix(ac(2), t.white, 0.2), throwW, 0.5);
        if (it.kind === 'bed_double' || D.rand(pick, 3) < 0.5) {
          D.cushion(this.itemPen(it, 0, 0.48, -it.d / 2 + 0.5), ac(4), it.kind === 'bed_double' ? 0.42 : 0.34, 0.28, 14);
        }
        break;
      }
      case 'nightstand':
        D.tableLamp(this.itemPen(it, 0, 0.5, -0.03), t, pick);
        break;
      case 'desk': {
        const side = D.rand(pick, 1) < 0.5 ? -1 : 1;
        D.tableLamp(this.itemPen(it, side * (it.w / 2 - 0.16), 0.74, -it.d / 2 + 0.16), t, pick, 0.9);
        D.bookStack(this.itemPen(it, -side * (it.w / 2 - 0.2), 0.74, -it.d / 2 + 0.14), t, 2 + Math.floor(D.rand(pick, 2) * 2), pick);
        break;
      }
      case 'coffee_table': {
        const y = 0.4;
        const k = it.w / 2 - 0.25;
        D.bookStack(this.itemPen(it, -k, y, 0, 8), t, 2, pick);
        if (D.rand(pick, 3) < 0.5) D.candle(this.itemPen(it, k, y, -0.05), t);
        else D.vase(this.itemPen(it, k, y, 0), t, pick, 0.8);
        break;
      }
      case 'tv_stand':
        D.vase(this.itemPen(it, it.w * 0.43, 0.45, 0.1), t, pick, 0.75);
        D.candle(this.itemPen(it, -it.w * 0.43, 0.45, 0.1), t);
        break;
      case 'bookshelf':
        this.fillShelves(it);
        break;
      case 'dining_table': {
        const pen = this.itemPen(it, 0, 0.74, 0);
        const long = it.w >= it.d;
        if (D.rand(pick, 1) < 0.5) {
          const L = (long ? it.w : it.d) * 0.78;
          pen.box('matte', mix(t.linen, t.fabric, 0.4), long ? L : 0.32, 0.004, long ? 0.32 : L, 0, 0.002, 0);
        }
        if (D.rand(pick, 2) < 0.55) D.fruitBowl(pen.to(0, 0.004, 0), t, pick);
        else D.vase(pen.to(0, 0.004, 0), t, pick, 1.3, true);
        break;
      }
      case 'bathroom_sink': {
        const back = this.backWall(it, 0.3);
        if (!back) break;
        const w = Math.min(0.6, it.w + 0.1);
        const h = 0.75;
        const yc = 1.45;
        if (!this.wallFree(back.f, back.s, w, yc - h / 2, 0.3)) break;
        D.mirror(this.wallPen(back.f, back.s, yc), t, w, h, pick);
        this.claim(back.f, back.s, w, 0.1);
        break;
      }
      case 'wardrobe':
        if (D.rand(pick, 1) < 0.45 && this.wallH - it.lift - it.h > 0.45) {
          D.basket(this.itemPen(it, (D.rand(pick, 2) - 0.5) * (it.w - 0.45), it.h, -0.02), t, 0.38, 0.3, 0.22, pick);
        }
        break;
      default:
        break;
    }
  }

  /** Books on a bookcase's shelves, with a few things among them. */
  private fillShelves(it: Item): void {
    if (it.kind !== 'bookshelf') return;
    const { t } = this;
    const k = it.h / 1.8;
    const shelves: [number, number][] = [
      [0.485 * k, 0.895 * k],
      [0.915 * k, 1.325 * k],
      [1.345 * k, 1.73 * k],
    ];
    const inner = it.w - 0.12;
    shelves.forEach(([y0, y1], i) => {
      const pick = D.rand(it.seed, i, 7);
      const frac = 0.45 + 0.4 * D.rand(pick, 1);
      const span = inner * frac;
      const left = D.rand(pick, 2) < 0.5;
      const cx = left ? -inner / 2 + span / 2 : inner / 2 - span / 2;
      const used = D.bookRow(this.itemPen(it, cx, y0, 0), t, span, y1 - y0 - 0.04, 0.2, pick);
      // In the space left: a vase, a small plant or a few books lying flat.
      const free = inner - used;
      if (free < 0.14) return;
      const ox = left ? -inner / 2 + used + free / 2 : inner / 2 - used - free / 2;
      const what = D.rand(pick, 3);
      if (what < 0.35) D.vase(this.itemPen(it, ox, y0, 0), t, pick, 0.85);
      else if (what < 0.6 && y1 - y0 > 0.32) D.pottedPlant(this.itemPen(it, ox, y0, 0), t, pick, 0.3);
      else if (free > 0.24) D.bookStack(this.itemPen(it, ox, y0, 0, 90), t, 2 + Math.floor(D.rand(pick, 4) * 2), pick);
    });
  }

  /** Jars, a board, a basket: a couple of things on the counters of a room. */
  dressCounters(room: Room): void {
    const counters = room.items.filter((it) => it.kind === 'counter' && !it.loaded).sort((a, b) => a.seed - b.seed);
    if (counters.length === 0) return;
    if (room.kind === 'utility') {
      const c = counters[0];
      D.basket(this.itemPen(c, 0, 0.92, -0.02), this.t, 0.42, 0.32, 0.24, c.seed);
      return;
    }
    const [first, second] = counters;
    const side = D.rand(first.seed, 1) < 0.5 ? -1 : 1;
    D.jars(this.itemPen(first, side < 0 ? -first.w / 2 + 0.1 : first.w / 2 - 0.4, 0.92, -first.d / 2 + 0.12), this.t, first.seed);
    if (second) {
      D.board(this.itemPen(second, (D.rand(second.seed, 2) - 0.5) * (second.w - 0.5), 0.92, -second.d / 2 + 0.06), this.t, second.seed);
    } else if (first.w >= 1) {
      D.board(this.itemPen(first, -side * (first.w / 2 - 0.25), 0.92, -first.d / 2 + 0.06), this.t, first.seed);
    }
    const third = counters[2];
    if (third) D.pottedPlant(this.itemPen(third, (D.rand(third.seed, 3) - 0.5) * (third.w - 0.3), 0.92, -third.d / 2 + 0.14), this.t, third.seed, 0.3);
  }

  // ---------- dressing rooms ----------

  living(room: Room): void {
    const { t } = this;
    const sofas = room.items.filter((it) => it.kind === 'sofa').sort((a, b) => b.w - a.w);
    const sofa = sofas[0];
    const seat = sofa ?? room.items.find((it) => it.kind === 'armchair');

    // A rug under the seating, unless the plan already has one.
    if (sofa && !room.items.some((it) => it.kind === 'rug')) {
      const W = Math.max(2.0, sofa.w + 0.5);
      const back = sofa.d / 2 - 0.35;
      this.rug(room, W, 1.9, 1.4, 1.2, (w, d) => {
        const c = this.itemPoint(sofa, 0, back + d / 2);
        return { x: c.x, y: c.y, hx: w / 2, hy: d / 2, a: sofa.f.rotation };
      }, UNDER_RUG, room.seed);
    }

    // Pictures above the sofa, else on the longest clear wall.
    let hungOn: Face | undefined;
    if (sofa) {
      const back = this.backWall(sofa);
      if (back && this.pictures(back.f, back.s, Math.min(1.15, sofa.w * 0.65), 0.78 + 0.3, D.rand(room.seed, 11))) hungOn = back.f;
    }
    if (!hungOn) this.pictureOnLongestWall(room, D.rand(room.seed, 12));
    else if (room.area > 22) this.pictureOnLongestWall(room, D.rand(room.seed, 13), hungOn);

    // A reading lamp at one end of the sofa.
    if (seat) {
      const sides = D.rand(room.seed, 14) < 0.5 ? [1, -1] : [-1, 1];
      const spots = sides.map((k) => {
        const p = this.itemPoint(seat, k * (seat.w / 2 + 0.22), -seat.d / 2 + 0.22);
        return { x: p.x, y: p.y, hx: 0.17, hy: 0.17, a: seat.f.rotation };
      });
      this.stand(room, spots, 1.6, (pen) => D.floorLamp(pen, t, room.seed));
    }

    // A plant in a corner if the room has none.
    if (!room.items.some((it) => it.kind === 'plant')) this.cornerPlant(room, 1.1 + 0.3 * D.rand(room.seed, 15));
  }

  cornerPlant(room: Room, height: number): boolean {
    return !!this.stand(room, this.cornerSpots(room, 0.48, 0.3), height, (pen) => D.pottedPlant(pen, this.t, D.rand(room.seed, 16), height));
  }

  bedroom(room: Room): void {
    const beds = room.items.filter((it) => it.kind === 'bed_double' || it.kind === 'bed_single').sort((a, b) => b.w - a.w);
    const bed = beds[0];
    if (!bed) {
      this.pictureOnLongestWall(room, D.rand(room.seed, 21));
      return;
    }
    // A rug under the foot of the bed, reaching out both sides.
    if (!room.items.some((it) => it.kind === 'rug')) {
      const start = -bed.d / 2 + 0.62;
      this.rug(room, bed.w + 1.0, bed.d - 0.62 + 0.45, bed.w + 0.3, 1.2, (w, d) => {
        const c = this.itemPoint(bed, 0, start + d / 2);
        return { x: c.x, y: c.y, hx: w / 2, hy: d / 2, a: bed.f.rotation };
      }, UNDER_RUG, room.seed);
    }
    // A picture above the bed head.
    const back = this.backWall(bed);
    const placed = back && this.pictures(back.f, back.s, bed.kind === 'bed_double' ? Math.min(1.15, bed.w * 0.72) : 0.55, 0.95 + 0.15, D.rand(room.seed, 22));
    if (!placed) this.pictureOnLongestWall(room, D.rand(room.seed, 23));
  }

  bathroom(room: Room): void {
    const { t } = this;
    // A towel on a rail, near the bath or basin, where nothing stands below it.
    const anchor = room.items.find((it) => it.kind === 'bathtub') ?? room.items.find((it) => it.kind === 'bathroom_sink');
    const w = 0.55;
    const railY = 1.1;
    const options: { f: Face; s: number; score: number }[] = [];
    for (const f of room.faces) {
      for (let s = f.lo + w / 2; s <= f.hi - w / 2; s += 0.1) {
        if (!this.wallFree(f, s, w, railY - 0.5, 0.3)) continue;
        const p = this.at(f, s);
        const score = anchor ? Math.hypot(p.x - anchor.f.x, p.y - anchor.f.y) : D.rand(room.seed, s);
        options.push({ f, s, score });
      }
    }
    options.sort((a, b) => a.score - b.score);
    const best = options[0];
    if (best) {
      D.towelRail(this.wallPen(best.f, best.s, railY), t, w, D.rand(room.seed, 31));
      this.claim(best.f, best.s, w, 0.1);
    }
    // A mat by the bath, or in front of the basin.
    const tub = room.items.find((it) => it.kind === 'bathtub');
    const spots: Box2[] = [];
    if (tub) {
      for (const k of [1, -1]) {
        const p = this.itemPoint(tub, k * (tub.w / 2 + 0.3), 0);
        spots.push({ x: p.x, y: p.y, hx: 0.26, hy: 0.4, a: tub.f.rotation });
      }
    }
    for (const sink of room.items.filter((it) => it.kind === 'bathroom_sink')) {
      const p = this.itemPoint(sink, 0, sink.d / 2 + 0.3);
      spots.push({ x: p.x, y: p.y, hx: 0.36, hy: 0.24, a: sink.f.rotation });
    }
    for (const spot of spots) {
      if (!this.floorFree(room, spot, { h: 0.02, passages: false })) continue;
      D.bathMat(Pen.at(this.bag, spot.x, spot.y, spot.a, FLOOR), t, spot.hx * 2, spot.hy * 2, D.rand(room.seed, 32));
      this.floor.push({ box: spot, h: 0.02 });
      break;
    }
  }

  hall(room: Room): void {
    // A runner down a long hall, in the longest stretch clear of door swings.
    let best: { f: Face; len: number } | null = null;
    for (const f of room.faces) {
      const len = f.hi - f.lo;
      if (!best || len > best.len) best = { f, len };
    }
    if (best) {
      const f = best.f;
      let deep = 0;
      for (const v of room.poly) deep = Math.max(deep, (v.x - f.ox) * f.nx + (v.y - f.oy) * f.ny);
      const width = deep - this.half;
      const long = best.len;
      if (long > 2.2 && long > width * 1.8 && width > 0.9) {
        // Slide along the hall and keep the longest stretch clear of door leaves, trying a
        // couple of widths and a little off-centre.
        const step = 0.1;
        const ang = Math.atan2(f.dy, f.dx);
        let found: { a: number; b: number; rw: number; off: number } | null = null;
        for (const rw of [Math.min(0.8, width - 0.35), Math.min(0.62, width - 0.35)]) {
          for (const off of [0, -0.1, 0.1]) {
            const marks: boolean[] = [];
            for (let s = f.lo; s <= f.hi; s += step) {
              const c = this.at(f, s, width / 2 + off);
              marks.push(this.floorFree(room, { x: c.x, y: c.y, hx: step / 2, hy: rw / 2, a: ang }, { h: 0.005, passages: false }));
            }
            marks.push(false);
            let start = -1;
            marks.forEach((ok, i) => {
              if (ok && start < 0) start = i;
              if (!ok && start >= 0) {
                const a = f.lo + start * step + 0.06;
                const b = f.lo + (i - 1) * step - 0.06;
                if (!found || b - a > found.b - found.a + 0.3) found = { a, b, rw, off };
                start = -1;
              }
            });
          }
        }
        const run = found as { a: number; b: number; rw: number; off: number } | null;
        if (run && run.b - run.a >= 1.3) {
          const L = Math.min(run.b - run.a, 4.5);
          const c = this.at(f, (run.a + run.b) / 2, width / 2 + run.off);
          const box: Box2 = { x: c.x, y: c.y, hx: L / 2, hy: run.rw / 2, a: ang };
          if (this.floorFree(room, box, { h: 0.005, passages: false })) {
            D.rug(Pen.at(this.bag, box.x, box.y, box.a, FLOOR), this.t, L, run.rw, D.rand(room.seed, 41));
            this.floor.push({ box, h: 0.01 });
          }
        }
      }
    }
    this.pictureOnLongestWall(room, D.rand(room.seed, 42));
  }

  /** A bench or a coat stand just inside each way in from outside. */
  frontDoor(): void {
    for (const { o, nx, ny } of this.frontDoors) {
      const probe = { x: o.x + nx * (o.thickness / 2 + 0.5), y: o.y + ny * (o.thickness / 2 + 0.5) };
      const room = this.rooms.find((r) => pointInPolygon(probe, r.poly));
      if (!room || room.kind === 'bathroom' || room.kind === 'storage') continue;
      const face = room.faces.find((f) => {
        if (Math.abs(Math.cos(o.angle) * f.dx + Math.sin(o.angle) * f.dy) < 0.98) return false;
        return Math.abs((o.x - f.ox) * f.nx + (o.y - f.oy) * f.ny + this.half) < 0.05;
      });
      if (!face) continue;
      const s0 = (o.x - face.ox) * face.dx + (o.y - face.oy) * face.dy;
      const pick = D.rand(o.x, o.y, 51);
      const sides = D.rand(pick, 1) < 0.5 ? [1, -1] : [-1, 1];
      const ang = Math.atan2(-face.nx, face.ny);
      const benchFirst = D.rand(pick, 2) < 0.5;
      const tryBench = (): boolean => {
        const bw = 0.95;
        for (const k of sides) {
          const s = s0 + k * (o.width / 2 + 0.25 + bw / 2);
          const c = this.at(face, s, 0.2);
          const box: Box2 = { x: c.x, y: c.y, hx: bw / 2, hy: 0.19, a: ang };
          if (s - bw / 2 < face.lo || s + bw / 2 > face.hi) continue;
          if (this.stand(room, [box], 0.55, (pen) => D.bench(pen, this.t, bw, pick))) return true;
        }
        return false;
      };
      const tryRack = (): boolean => {
        for (const k of sides) {
          const s = s0 + k * (o.width / 2 + 0.3 + 0.2);
          if (!this.wallFree(face, s, 0.4, 0.3, 0.1)) continue;
          const c = this.at(face, s, 0.26);
          const box: Box2 = { x: c.x, y: c.y, hx: 0.21, hy: 0.21, a: ang };
          if (this.stand(room, [box], 1.9, (pen) => D.coatRack(pen, this.t, pick))) {
            this.claim(face, s, 0.4, 0.1);
            return true;
          }
        }
        return false;
      };
      if (benchFirst) {
        if (!tryBench()) tryRack();
      } else if (!tryRack()) tryBench();
    }
  }

  dress(): THREE.Group {
    // Things that stand on the floor or hang on walls go first, so the furniture dressing never fights them.
    this.frontDoor();
    for (const room of this.rooms) {
      switch (room.kind) {
        case 'living':
          this.living(room);
          break;
        case 'event':
        case 'other':
          if (room.items.some((it) => it.kind === 'sofa')) this.living(room);
          break;
        case 'bedroom':
          this.bedroom(room);
          break;
        case 'bathroom':
          this.bathroom(room);
          break;
        case 'circulation':
          this.hall(room);
          break;
        case 'office':
          this.pictureOnLongestWall(room, D.rand(room.seed, 61));
          if (D.rand(room.seed, 62) < 0.6) this.cornerPlant(room, 0.9 + 0.3 * D.rand(room.seed, 63));
          break;
        case 'dining':
          this.pictureOnLongestWall(room, D.rand(room.seed, 71));
          break;
        default:
          break;
      }
      this.dressCounters(room);
    }
    for (const it of this.items) this.dressItem(it);
    return this.bag.build('decor', this.input.evening);
  }
}

export function buildDecor(input: DecorInput): THREE.Group {
  return new Dresser(input).dress();
}
