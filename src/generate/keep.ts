/**
 * Keeping part of a plan: read the rooms of an existing plan, set some aside
 * to stay exactly where they are, and describe what is left as a footprint
 * the filler can re-plan around them. Pure — no store.
 */
import { pointInPolygon } from '../geometry';
import { roomKindFromName } from '../roomTypes';
import { detectRooms } from '../rooms';
import type { PlanData, Point } from '../types';
import { OUTSIDE, type LayoutLink, type LayoutRoom, type RoomType } from './layout';
import { cellsFromPolygon, isRectilinear, largestFirst, slabs, tidyPolygon, type Rect } from './outline';

/** A room's polygon as rectangles: whichever way of cutting it leaves the thickest pieces (then the fewest). */
function roomRects(polygon: Point[]): Rect[] {
  const cells = cellsFromPolygon(polygon);
  const ways = [slabs(cells, true), slabs(cells, false), largestFirst(cells)].filter((w) => w.length > 0);
  const thin = (w: Rect[]) => Math.min(...w.map((r) => Math.min(r.w, r.h)));
  return ways.sort((p, q) => thin(q) - thin(p) || p.length - q.length)[0] ?? [];
}

export interface PlanRoom {
  /** The plan's own key for the room (see rooms.ts). */
  key: string;
  /** Its name on the plan, or "Room". */
  name: string;
  /** What it counts as in a brief; an open-plan room counts as each of its parts. */
  types: RoomType[];
  polygon: Point[];
  /** The rectangles it is made of; empty when it has an angled wall. */
  rects: Rect[];
  /** m² */
  area: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function typeOfName(name: string): RoomType {
  const n = name.toLowerCase();
  switch (roomKindFromName(name)) {
    case 'bedroom':
      return /\b(primary|master|main)\b/.test(n) ? 'primary_bedroom' : 'bedroom';
    case 'bathroom':
      return /\b(primary|master|ensuite|en-suite)\b/.test(n) ? 'primary_bath' : 'bathroom';
    case 'kitchen':
      return 'kitchen';
    case 'dining':
      return 'dining';
    case 'living':
      return 'living';
    case 'office':
      return 'office';
    case 'circulation':
      return /\b(entry|entrance|foyer|vestibule|lobby)\b/.test(n) ? 'entry' : 'hall';
    case 'utility':
      return 'laundry';
    case 'storage':
      return /\b(pantry|larder)\b/.test(n) ? 'pantry' : 'closet';
    case 'garage':
      return 'garage';
    default:
      return 'other';
  }
}

/** The rooms of a plan as the generator sees them. */
export function planRooms(plan: Pick<PlanData, 'walls' | 'roomNames'>): PlanRoom[] {
  return detectRooms(plan.walls).map((room) => {
    const name = (plan.roomNames[room.key] ?? '').trim();
    const parts = name.split(/\s*[+/&,]\s*/).filter(Boolean);
    const types = [...new Set((parts.length ? parts : [name]).map(typeOfName))];
    const polygon = tidyPolygon(room.polygon.map((p) => ({ x: r3(p.x), y: r3(p.y) })));
    const square = polygon.length >= 4 && isRectilinear(polygon);
    return {
      key: room.key,
      name: name || 'Room',
      types: types.length > 1 ? types.filter((t) => t !== 'other') : types,
      polygon,
      rects: square ? roomRects(polygon) : [],
      area: room.area,
    };
  });
}

export interface KeepSetup {
  /** What is re-planned: the footprint of every room not kept. */
  mask: Rect[];
  /** The kept rooms as fixed rectangles (an L-shaped room is several, open to each other). */
  rooms: LayoutRoom[];
  links: LayoutLink[];
  /** What the kept rooms already provide, for the brief's count. */
  taken: RoomType[];
  /** Kept rooms by their name on the plan, with a point inside each — to put the names back afterwards. */
  kept: { name: string; at: Point; polygon: Point[] }[];
}

/** Set `keys` aside and describe the rest; an error line when that can't be done. */
export function keepSetup(
  plan: Pick<PlanData, 'walls' | 'openings' | 'roomNames'>,
  keys: readonly string[],
): { ok: true; setup: KeepSetup } | { ok: false; error: string } {
  const all = planRooms(plan);
  const kept = all.filter((r) => keys.includes(r.key));
  const rest = all.filter((r) => !keys.includes(r.key));
  if (kept.length === 0) return { ok: false, error: 'Pick a room to keep first.' };
  if (rest.length === 0) return { ok: false, error: 'Every room is kept — nothing left to re-plan.' };
  if (all.some((r) => r.rects.length === 0)) {
    return { ok: false, error: 'This plan has angled walls, which can’t be re-planned around yet.' };
  }
  const rooms: LayoutRoom[] = [];
  const links: LayoutLink[] = [];
  const partsOf = new Map<string, LayoutRoom[]>();
  const used = new Set<string>();
  for (const room of kept) {
    const bySize = room.rects.slice().sort((p, q) => q.w * q.h - p.w * p.h);
    let stem = room.name.slice(0, 32);
    for (let n = 2; used.has(stem.toLowerCase()); n++) stem = `${room.name.slice(0, 30)} ${n}`;
    used.add(stem.toLowerCase());
    const parts = bySize.map((r, i): LayoutRoom => ({ name: i === 0 ? stem : `${stem} · ${i + 1}`, type: room.types[0] ?? 'other', ...r }));
    partsOf.set(room.key, parts);
    rooms.push(...parts);
    // The pieces of one room are open to each other.
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        if (touching(parts[i], parts[j])) links.push({ a: parts[i].name, b: parts[j].name, kind: 'open' });
      }
    }
  }
  // Doors between kept rooms, and a kept front door, carry over.
  const partAt = (p: Point): LayoutRoom | 'elsewhere' | null => {
    for (const room of kept) {
      if (!pointInPolygon(p, room.polygon)) continue;
      return partsOf.get(room.key)!.find((r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) ?? null;
    }
    return rest.some((r) => pointInPolygon(p, r.polygon)) ? 'elsewhere' : null;
  };
  const seen = new Set<string>();
  for (const o of plan.openings) {
    if (o.type !== 'door') continue;
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
    if (len < 1e-6) continue;
    const ux = (wall.b.x - wall.a.x) / len;
    const uy = (wall.b.y - wall.a.y) / len;
    const c = { x: wall.a.x + ux * o.offset, y: wall.a.y + uy * o.offset };
    const one = partAt({ x: c.x - uy * 0.2, y: c.y + ux * 0.2 });
    const two = partAt({ x: c.x + uy * 0.2, y: c.y - ux * 0.2 });
    const a = one && one !== 'elsewhere' ? one : null;
    const b = two && two !== 'elsewhere' ? two : null;
    let link: LayoutLink | null = null;
    if (a && b && a !== b) link = { a: a.name, b: b.name, kind: 'door' };
    else if ((a && two === null) || (b && one === null)) link = { a: (a ?? b)!.name, b: OUTSIDE, kind: 'door' };
    if (!link) continue;
    const key = [link.a, link.b].sort().join('|');
    if (seen.has(key) || (link.b === OUTSIDE && links.some((l) => l.b === OUTSIDE))) continue;
    seen.add(key);
    links.push(link);
  }
  return {
    ok: true,
    setup: {
      mask: rest.flatMap((r) => r.rects),
      rooms,
      links,
      taken: kept.flatMap((r) => r.types),
      kept: kept.map((r) => {
        const big = partsOf.get(r.key)![0];
        return { name: r.name, at: { x: big.x + big.w / 2, y: big.y + big.h / 2 }, polygon: r.polygon };
      }),
    },
  };
}

function touching(a: Rect, b: Rect): boolean {
  const xo = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const v = Math.abs(a.x + a.w - b.x) < 1e-6 || Math.abs(b.x + b.w - a.x) < 1e-6;
  const h = Math.abs(a.y + a.h - b.y) < 1e-6 || Math.abs(b.y + b.h - a.y) < 1e-6;
  return (v && yo > 1e-6) || (h && xo > 1e-6);
}

/**
 * Finish a re-planned plan: kept rooms get their own names back, and the
 * furniture standing in them stays (what stood in the re-planned rooms goes).
 */
export function restoreKept(built: PlanData, original: Pick<PlanData, 'furniture'>, setup: KeepSetup): PlanData {
  const roomNames = { ...built.roomNames };
  const detected = detectRooms(built.walls);
  for (const k of setup.kept) {
    const room = detected.find((d) => pointInPolygon(k.at, d.polygon));
    if (room && k.name !== 'Room') roomNames[room.key] = k.name;
    else if (room) delete roomNames[room.key];
  }
  const furniture = original.furniture
    .filter((f) => setup.kept.some((k) => pointInPolygon({ x: f.x, y: f.y }, k.polygon)))
    .map((f) => ({ ...f }));
  return { ...built, roomNames, furniture };
}
