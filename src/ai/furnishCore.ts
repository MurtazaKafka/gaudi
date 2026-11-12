/**
 * Furnishing one room, minus the network and the store: the prompt Claude
 * sees, the schema it answers in, and the geometry check that every proposed
 * piece has to pass before it is shown. Pure, so it is tested in node.
 */
import { quadsOverlap } from '../geometry';
import { FURNITURE, FURNITURE_KINDS, customKind, type FurnitureKind } from '../catalog';
import type { Furniture, PlanData, Point } from '../types';
import {
  clearZone,
  defFor,
  degToRad,
  fitsInside,
  footprint,
  furnitureInRoom,
  isFlat,
  isNum,
  radToDeg,
  roomOpenings,
  settleInside,
  type RoomInfo,
  type RoomOpening,
} from './planGeom';

export type Placement = Omit<Furniture, 'id'>;

export interface FurnishContext {
  plan: PlanData;
  /** every room of the plan (from analyzeRooms) */
  rooms: RoomInfo[];
  /** the one being furnished */
  room: RoomInfo;
  /** name to furnish it as, when the plan has none yet */
  nameHint?: string;
  /** the user's one-line style note */
  note?: string;
  /** furnish as if the room were empty (what is there will be replaced) */
  replace?: boolean;
}

export interface FurnishResult {
  items: Placement[];
  /** suggestions that failed validation */
  dropped: number;
}

export interface RawPlacement {
  kind: string;
  x: number;
  y: number;
  rotation_deg: number;
  reason: string;
}

const MAX_ITEMS = 16;

/** Every furniture kind valid in this plan: the catalog plus the plan's own items. */
export function planKinds(plan: PlanData): string[] {
  return [...FURNITURE_KINDS, ...Object.keys(plan.customItems).map((id) => customKind(id))];
}

export function furnishSchema(kinds: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: kinds },
            x: { type: 'number' },
            y: { type: 'number' },
            rotation_deg: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['kind', 'x', 'y', 'rotation_deg', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
}

const n2 = (v: number): string => String(Math.round(v * 100) / 100);
const pt = (p: Point): string => `(${n2(p.x)}, ${n2(p.y)})`;

const STYLE_WORDS: Record<string, string> = {
  maquette: 'plain architectural maquette — calm, uncluttered',
};

const nameOf = (r: RoomInfo): string => r.name ?? 'an unnamed room';

export const FURNISH_SYSTEM = `You furnish rooms on a floor plan the way a thoughtful interior designer would: a realistic, uncluttered layout that suits the room's purpose, size and openings. You reply with placements only.`;

export function buildFurnishPrompt(ctx: FurnishContext): string {
  const { plan, room, rooms } = ctx;
  const name = room.name ?? ctx.nameHint;
  const openings = roomOpenings(room, plan.walls, plan.openings);
  const beyond = (i: number): string => (i < 0 ? 'outside' : nameOf(rooms[i]));

  const sides = room.edges.map(
    (e) => `- ${e.side} side: ${pt(e.a)} → ${pt(e.b)}, ${n2(e.length)} m, ${e.neighbour < 0 ? 'exterior wall' : `shared with ${nameOf(rooms[e.neighbour])}`}`,
  );
  const openingLines = openings.map((o) => {
    const side = room.edges.find((e) => Math.abs(e.out.x + o.inward.x) < 0.01 && Math.abs(e.out.y + o.inward.y) < 0.01)?.side;
    return `- ${o.opening.type} at ${pt(o.center)}${side ? ` on the ${side} side` : ''}, ${n2(o.opening.width)} m wide, ${o.opening.type === 'door' ? `leads to ${beyond(o.beyond)}` : `looks onto ${beyond(o.beyond)}`}`;
  });
  const existing = ctx.replace
    ? []
    : furnitureInRoom(plan.furniture, room.room).flatMap((f) => {
        const def = defFor(plan, f.kind);
        return def
          ? [`- ${def.label} (${f.kind}) at ${pt(f)}, rotation ${radToDeg(f.rotation)}°, footprint ${n2(def.w)}×${n2(def.d)} m`]
          : [];
      });
  const others = rooms
    .filter((r) => r.index !== room.index)
    .map((r) => `${nameOf(r)} ${r.room.area.toFixed(0)} m²`)
    .join(', ');

  const catalog = FURNITURE_KINDS.map((k) => {
    const d = FURNITURE[k];
    return `${k}: ${d.label}, ${d.w}×${d.d} m, ${d.h} m high`;
  });
  const custom = Object.values(plan.customItems).map(
    (c) => `${customKind(c.id)}: ${c.label}, ${n2(c.w)}×${n2(c.d)} m, ${n2(c.h)} m high (the user's own item — use it where it suits the room)`,
  );

  const style = STYLE_WORDS[plan.look.style] ?? plan.look.style;
  const margin = n2(plan.settings.wallThickness / 2 + 0.02);

  return `Furnish one room of a house floor plan.

Coordinates are meters; +x is east, +y is south (screen-down). Rotation is in degrees, clockwise. At rotation 0 an item's width (first footprint number) runs east–west and its front faces south, so its back is to the north: a bed's headboard, a sofa's backrest, a wardrobe's back and a toilet's cistern are on the north side at rotation 0. To put a sofa's back against the east wall, rotate it 90°; against the south wall, 180°; against the west wall, 270°.

ROOM
Name: ${name ?? 'unnamed — judge its purpose from its size and openings'}
Area: ${room.room.area.toFixed(1)} m². Extent: x ${n2(room.minX)}…${n2(room.maxX)}, y ${n2(room.minY)}…${n2(room.maxY)}.
Corners (closed polygon, wall centerlines): ${room.room.polygon.map(pt).join(' ')}
Sides:
${sides.join('\n')}
Doors and windows:
${openingLines.length ? openingLines.join('\n') : '- none'}
Already in the room (leave it, do not overlap it, do not duplicate its role):
${existing.length ? existing.join('\n') : '- nothing'}

THE HOUSE
Look: ${style}.${ctx.note?.trim() ? `\nThe user's note for this room: "${ctx.note.trim().slice(0, 200)}"` : ''}
Other rooms: ${others || 'none'}.

CATALOG (kind: label, width×depth, height)
${[...catalog, ...custom].join('\n')}

RULES
- x and y are the item's center. The whole rotated footprint must be inside the room, at least ${margin} m from every wall centerline (walls have thickness) — a piece "against" a wall sits ${margin} m off it.
- Keep the floor in front of every door clear: nothing within one door-width of a door, across its full width. Never put anything tall in front of a window.
- Pieces must not overlap each other or what is already there. Rugs are the exception: other pieces may stand on a rug.
- Leave about 0.7 m of walking space along the routes between doors and the main pieces.
- Suit the room's purpose and size; fewer well-placed pieces beat a crowded room. Typically 3–7 pieces; a hall or a very small room may need one or none.
- Put pieces against walls where that is natural (beds, wardrobes, sofas, desks, counters, toilets, baths), and group what belongs together (chairs at a table, nightstands by a bed).
- Use only catalog kinds.`;
}

interface Zone {
  quad: Point[];
  /** only pieces taller than this are kept out (0 = everything) */
  minHeight: number;
}

function zonesFor(openings: RoomOpening[]): Zone[] {
  return openings.map((o) =>
    o.opening.type === 'door'
      ? { quad: clearZone(o, Math.min(1.1, Math.max(0.8, o.opening.width))), minHeight: 0 }
      : { quad: clearZone(o, 0.35), minHeight: 1.3 },
  );
}

const shrink = (q: Point[], by: number): Point[] => {
  const cx = q.reduce((s, p) => s + p.x, 0) / q.length;
  const cy = q.reduce((s, p) => s + p.y, 0) / q.length;
  return q.map((p) => {
    const l = Math.hypot(p.x - cx, p.y - cy) || 1;
    const k = Math.max(0, l - by) / l;
    return { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k };
  });
};

/**
 * Keep only placements that are physically sound: a real kind, fully inside
 * the room (nudged in if a hair off), clear of other pieces, of door swings
 * and — for tall pieces — of windows.
 */
export function validatePlacements(raw: unknown, ctx: FurnishContext): FurnishResult {
  const { plan, room } = ctx;
  const list = Array.isArray(raw) ? raw : [];
  const margin = plan.settings.wallThickness / 2 + 0.01;
  const zones = zonesFor(roomOpenings(room, plan.walls, plan.openings));

  const solid: Point[][] = [];
  if (!ctx.replace) {
    for (const f of furnitureInRoom(plan.furniture, room.room)) {
      const def = defFor(plan, f.kind);
      if (def && !isFlat(f.kind, def)) solid.push(footprint(def, f));
    }
  }

  const items: Placement[] = [];
  let dropped = 0;
  for (const r of list as Partial<RawPlacement>[]) {
    const def = r && typeof r === 'object' ? defFor(plan, r.kind) : null;
    if (!def || !isNum(r.x) || !isNum(r.y) || items.length >= MAX_ITEMS) {
      dropped++;
      continue;
    }
    const kind = r.kind as FurnitureKind;
    const rotation = degToRad(isNum(r.rotation_deg) ? r.rotation_deg : 0);
    const spot = settleInside(r.x, r.y, def.w, def.d, rotation, room.room.polygon, 0.35, margin);
    if (!spot) {
      dropped++;
      continue;
    }
    const quad = footprint(def, { x: spot.x, y: spot.y, rotation });
    if (!fitsInside(quad, room.room.polygon)) {
      dropped++;
      continue;
    }
    const flat = isFlat(kind, def);
    if (!flat) {
      const tight = shrink(quad, 0.02);
      const blocked =
        solid.some((q) => quadsOverlap(tight, q)) ||
        zones.some((z) => def.h > z.minHeight && quadsOverlap(tight, z.quad));
      if (blocked) {
        dropped++;
        continue;
      }
      solid.push(quad);
    }
    items.push({ kind, x: spot.x, y: spot.y, rotation });
  }
  return { items, dropped };
}

// ---------- naming rooms ----------

export interface RoomNameReply {
  rooms: { room: string; name: string }[];
}

export const ROOM_NAMES_SCHEMA = {
  type: 'object',
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        properties: { room: { type: 'string' }, name: { type: 'string' } },
        required: ['room', 'name'],
        additionalProperties: false,
      },
    },
  },
  required: ['rooms'],
  additionalProperties: false,
} as const;

/** Prompt for inferring what each unnamed room is. Rooms are referred to as R1, R2 … by index. */
export function buildRoomNamesPrompt(plan: PlanData, rooms: RoomInfo[]): string {
  const ref = (i: number): string => (i < 0 ? 'outside' : `R${i + 1}`);
  const lines = rooms.map((r) => {
    const os = roomOpenings(r, plan.walls, plan.openings);
    const doors = os.filter((o) => o.opening.type === 'door').map((o) => ref(o.beyond));
    const windows = os.filter((o) => o.opening.type === 'window').length;
    const next = [...new Set(r.edges.map((e) => e.neighbour).filter((i) => i >= 0))].map(ref);
    const exterior = r.edges.some((e) => e.neighbour < 0);
    return `- R${r.index + 1}: ${r.name ? `"${r.name}"` : 'unnamed'}, ${r.room.area.toFixed(1)} m², ${n2(r.maxX - r.minX)}×${n2(r.maxY - r.minY)} m; doors to ${doors.length ? doors.join(', ') : 'nothing'}; ${windows} window${windows === 1 ? '' : 's'}; next to ${next.length ? next.join(', ') : 'no other room'}${exterior ? '' : '; no exterior wall'}`;
  });
  return `These are the rooms of a single-storey home. Some have no name yet. From their sizes, doors, windows and neighbours, decide what each unnamed room most plausibly is and name it the way a floor plan would ("Bedroom", "Kitchen", "Bathroom", "Living room", "Hall", "Study", "Closet" …). A home has one kitchen and one living room; number repeats ("Bedroom 2"). Return a name for every unnamed room, and only for those.

${lines.join('\n')}`;
}

/** Clean the model's names: unnamed rooms only, sensible strings, keyed by room index. */
export function readRoomNames(reply: unknown, rooms: RoomInfo[]): Map<number, string> {
  const out = new Map<number, string>();
  const list = reply && typeof reply === 'object' ? (reply as Partial<RoomNameReply>).rooms : null;
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    if (!r || typeof r.room !== 'string' || typeof r.name !== 'string') continue;
    const m = r.room.trim().match(/^R(\d+)$/i);
    const name = r.name.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!m || !name) continue;
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= rooms.length || rooms[i].name || out.has(i)) continue;
    out.set(i, name);
  }
  return out;
}
