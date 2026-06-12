import Anthropic from '@anthropic-ai/sdk';
import { FURNITURE, FURNITURE_KINDS, furnitureDef, type FurnitureKind } from './catalog';
import type { DetectedRoom } from './rooms';
import { usePlanStore } from './store';
import { getApiKey } from './aiStore';
import {
  dist,
  distToSegment,
  pointInPolygon,
  quadsOverlap,
  rectCorners,
} from './geometry';
import type { Furniture, Point } from './types';

export interface SuggestResult {
  items: Omit<Furniture, 'id'>[];
  /** how many model suggestions failed geometry validation and were dropped */
  dropped: number;
}

interface RawPlacement {
  kind: string;
  x: number;
  y: number;
  rotation_deg: number;
  reason: string;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: FURNITURE_KINDS },
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
} as const;

function buildPrompt(room: DetectedRoom, roomName: string | undefined): string {
  const { walls, openings, furniture } = usePlanStore.getState();

  const poly = room.polygon.map((p) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).join(', ');

  // Openings whose center lies on this room's boundary.
  const boundaryOpenings = openings.flatMap((o) => {
    const wall = walls.find((w) => w.id === o.wallId);
    if (!wall) return [];
    const len = dist(wall.a, wall.b);
    if (len < 1e-6) return [];
    const t = o.offset / len;
    const c: Point = {
      x: wall.a.x + (wall.b.x - wall.a.x) * t,
      y: wall.a.y + (wall.b.y - wall.a.y) * t,
    };
    const onBoundary = room.polygon.some((p, i) =>
      distToSegment(c, p, room.polygon[(i + 1) % room.polygon.length]) < 0.15,
    );
    if (!onBoundary) return [];
    return [`${o.type} at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}), ${o.width} m wide`];
  });

  const existing = furniture
    .filter((f) => pointInPolygon({ x: f.x, y: f.y }, room.polygon))
    .map((f) => {
      const def = furnitureDef(f.kind);
      return `${f.kind} at (${f.x}, ${f.y}), rotation ${Math.round((f.rotation * 180) / Math.PI)}°, footprint ${def.w}×${def.d} m`;
    });

  const catalog = FURNITURE_KINDS.map((k) => {
    const d = FURNITURE[k];
    return `${k}: ${d.label}, ${d.w}×${d.d} m`;
  }).join('\n');

  return `Furnish one room of a house floor plan.

Coordinate system: meters; +x is east, +y is south (screen-down). Furniture rotation is in degrees, clockwise. At rotation 0 an item's width (first footprint dimension) runs east-west and its "front" faces south; the back faces north. A bed's headboard, a sofa's backrest, and a wardrobe's back are on the north side at rotation 0 — so to put a sofa's back against the east wall, rotate it 90°.

ROOM
Name: ${roomName ?? 'unnamed room'}
Boundary polygon (closed): ${poly}
Area: ${room.area.toFixed(1)} m²
Openings on this room's walls:
${boundaryOpenings.length ? boundaryOpenings.map((s) => `- ${s}`).join('\n') : '- none recorded'}
Existing furniture already placed in this room (do not overlap it, do not duplicate its role):
${existing.length ? existing.map((s) => `- ${s}`).join('\n') : '- none'}

CATALOG (kind: label, width×depth)
${catalog}

RULES
- Every item must sit fully inside the boundary polygon, including its rotated footprint corners. Keep at least 0.05 m from walls unless intentionally flush against one.
- Keep door areas clear: leave a swing/walk zone of about the door's width in front of every door. Never block a door.
- Items must not overlap each other or existing furniture (rugs are the exception: other items may sit on a rug).
- Leave practical walking clearance (~0.6 m) along the main paths between the door(s) and the key pieces.
- Furnish appropriately for the room's name and size — a realistic, tasteful, uncluttered layout. Prefer fewer well-placed pieces over cramming. Typical counts: 3-7 items.
- Place items against walls when that is the natural position (beds, wardrobes, sofas, desks, counters, toilets).
- Use only catalog kinds. x and y are the item's center.

Return the layout as JSON.`;
}

/** Drop suggestions that violate geometry: outside the room or overlapping. */
function validate(
  raw: RawPlacement[],
  room: DetectedRoom,
): SuggestResult {
  const { furniture } = usePlanStore.getState();
  const placedQuads: Point[][] = furniture
    .filter((f) => pointInPolygon({ x: f.x, y: f.y }, room.polygon))
    .map((f) => {
      const def = furnitureDef(f.kind);
      return rectCorners(f.x, f.y, def.w, def.d, f.rotation);
    });

  const accepted: Omit<Furniture, 'id'>[] = [];
  let dropped = 0;

  for (const r of raw) {
    if (!(r.kind in FURNITURE)) {
      dropped++;
      continue;
    }
    const kind = r.kind as FurnitureKind;
    const def = furnitureDef(kind);
    const rot = (r.rotation_deg * Math.PI) / 180;
    const corners = rectCorners(r.x, r.y, def.w, def.d, rot);

    const inside =
      pointInPolygon({ x: r.x, y: r.y }, room.polygon) &&
      corners.every((c) => pointInPolygon(c, room.polygon));
    if (!inside) {
      dropped++;
      continue;
    }

    // Rugs may overlap; everything else must not.
    const overlaps =
      kind !== 'rug' &&
      placedQuads.some((q) => quadsOverlap(corners, q));
    if (overlaps) {
      dropped++;
      continue;
    }

    if (kind !== 'rug') placedQuads.push(corners);
    accepted.push({ kind, x: r.x, y: r.y, rotation: rot });
  }

  return { items: accepted, dropped };
}

export async function suggestFurniture(
  room: DetectedRoom,
  roomName: string | undefined,
): Promise<SuggestResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key set.');

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: 'user', content: buildPrompt(room, roomName) }],
  });

  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Empty model response.');

  const parsed = JSON.parse(text.text) as { items: RawPlacement[] };
  return validate(parsed.items ?? [], room);
}
