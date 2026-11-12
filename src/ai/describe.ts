/**
 * Turn a plan into a compact, legible description for Claude, and hand out
 * the short ids (W1, D1, N1, F1, R1) the model answers with. Store-free.
 */
import { dist, pointInPolygon } from '../geometry';
import { FURNITURE, FURNITURE_KINDS, customKind } from '../catalog';
import type { PlanData, Point } from '../types';
import { analyzeRooms, defFor, pointOnWall, radToDeg, type RoomInfo } from './planGeom';
import type { PlanRefs } from './ops';

/** What the user has selected, in real ids. */
export interface Selection {
  wallIds: string[];
  openingIds: string[];
  furnitureIds: string[];
  roomKey: string | null;
}

export const NO_SELECTION: Selection = { wallIds: [], openingIds: [], furnitureIds: [], roomKey: null };

export interface PlanDescription {
  text: string;
  refs: PlanRefs;
  /** every furniture kind valid in this plan (catalog + its custom items) */
  kinds: string[];
  rooms: RoomInfo[];
}

const n2 = (v: number): string => String(Math.round(v * 100) / 100);
const pt = (p: Point): string => `(${n2(p.x)}, ${n2(p.y)})`;

const roomLabel = (r: RoomInfo, ref: string): string => (r.name ? `${ref} "${r.name}"` : ref);

export function describePlan(plan: PlanData, selection: Selection = NO_SELECTION): PlanDescription {
  const rooms = analyzeRooms(plan.walls, plan.roomNames);
  const refs: PlanRefs = { walls: {}, openings: {}, furniture: {}, rooms: [] };
  const wallRef = new Map<string, string>();
  const openingRef = new Map<string, string>();
  const furnitureRef = new Map<string, string>();

  plan.walls.forEach((w, i) => {
    const ref = `W${i + 1}`;
    refs.walls[ref] = w.id;
    wallRef.set(w.id, ref);
  });
  let doors = 0;
  let windows = 0;
  for (const o of plan.openings) {
    const ref = o.type === 'door' ? `D${++doors}` : `N${++windows}`;
    refs.openings[ref] = o.id;
    openingRef.set(o.id, ref);
  }
  plan.furniture.forEach((f, i) => {
    const ref = `F${i + 1}`;
    refs.furniture[ref] = f.id;
    furnitureRef.set(f.id, ref);
  });
  const roomRef = rooms.map((_, i) => `R${i + 1}`);
  rooms.forEach((r, i) => refs.rooms.push({ ref: roomRef[i], key: r.room.key, name: r.name }));
  const labelOf = (i: number): string => (i < 0 ? 'outside' : roomLabel(rooms[i], roomRef[i]));

  const lines: string[] = [];
  lines.push(
    `A single-storey floor plan called "${plan.name}". Coordinates are meters; +x is east, +y is south (north is -y). ` +
      `The user reads lengths in ${plan.settings.units === 'ft' ? 'feet and inches' : 'meters'} — convert what they type (1 ft = 0.3048 m). ` +
      `Walls are ${n2(plan.settings.wallHeight)} m high and ${n2(plan.settings.wallThickness)} m thick, drawn on their centerlines.`,
  );

  lines.push('', `ROOMS (${rooms.length})`);
  if (rooms.length === 0) lines.push('- none yet (no closed loop of walls)');
  rooms.forEach((r, i) => {
    const sides = r.edges
      .map((e) => `${e.side} ${e.wallId ? (wallRef.get(e.wallId) ?? '?') : '?'} ${n2(e.length)} m → ${labelOf(e.neighbour)}`)
      .join('; ');
    lines.push(
      `- ${roomLabel(r, roomRef[i])}${r.name ? '' : ' (unnamed)'}: ${r.room.area.toFixed(1)} m², ` +
        `x ${n2(r.minX)}…${n2(r.maxX)}, y ${n2(r.minY)}…${n2(r.maxY)}, corners ${r.room.polygon.map(pt).join(' ')}. Sides: ${sides}`,
    );
  });

  lines.push('', `WALLS (${plan.walls.length})`);
  for (const w of plan.walls) {
    const ref = wallRef.get(w.id)!;
    const bounds: string[] = [];
    rooms.forEach((r, i) => {
      if (r.edges.some((e) => e.wallId === w.id)) {
        const e = r.edges.find((x) => x.wallId === w.id)!;
        // The room lies on the opposite side from the edge's outward normal.
        const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' }[e.side];
        bounds.push(`${roomLabel(r, roomRef[i])} on its ${opposite} side`);
      }
    });
    const dx = Math.abs(w.b.x - w.a.x);
    const dy = Math.abs(w.b.y - w.a.y);
    const run = dy < 0.01 ? 'runs east–west' : dx < 0.01 ? 'runs north–south' : 'diagonal';
    lines.push(
      `- ${ref}: ${pt(w.a)} → ${pt(w.b)}, ${n2(dist(w.a, w.b))} m, ${run}; ${bounds.length ? bounds.join(', ') : 'bounds no room'}`,
    );
  }

  lines.push('', `OPENINGS (${plan.openings.length})`);
  if (plan.openings.length === 0) lines.push('- none');
  for (const o of plan.openings) {
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const c = pointOnWall(wall, o.offset);
    const touching = rooms
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.edges.some((e) => e.wallId === wall.id && onSegment(c, e.a, e.b)))
      .map(({ r, i }) => roomLabel(r, roomRef[i]));
    const where = touching.length === 2 ? `between ${touching[0]} and ${touching[1]}` : touching.length === 1 ? `between ${touching[0]} and outside` : '';
    lines.push(
      `- ${openingRef.get(o.id)}: ${o.type} on ${wallRef.get(wall.id)}, offset ${n2(o.offset)} m, ${n2(o.width)} m wide, at ${pt(c)}${where ? `, ${where}` : ''}${o.label ? `, labelled "${o.label}"` : ''}`,
    );
  }

  lines.push('', `FURNITURE (${plan.furniture.length})`);
  if (plan.furniture.length === 0) lines.push('- none');
  for (const f of plan.furniture) {
    const def = defFor(plan, f.kind);
    if (!def) continue;
    const ri = rooms.findIndex((r) => pointInPolygon({ x: f.x, y: f.y }, r.room.polygon));
    lines.push(
      `- ${furnitureRef.get(f.id)}: ${def.label} (${f.kind}) in ${labelOf(ri)}, center ${pt(f)}, rotation ${radToDeg(f.rotation)}°, footprint ${n2(def.w)}×${n2(def.d)} m${f.label ? `, labelled "${f.label}"` : ''}`,
    );
  }

  const custom = Object.values(plan.customItems);
  const kinds: string[] = [...FURNITURE_KINDS, ...custom.map((c) => customKind(c.id))];
  lines.push('', 'FURNITURE KINDS YOU CAN ADD (kind: label, width×depth m — width runs east–west at rotation 0, front faces south)');
  lines.push(FURNITURE_KINDS.map((k) => `${k}: ${FURNITURE[k].label} ${FURNITURE[k].w}×${FURNITURE[k].d}`).join(' · '));
  if (custom.length) {
    lines.push("This plan's own items: " + custom.map((c) => `${customKind(c.id)}: ${c.label} ${n2(c.w)}×${n2(c.d)}`).join(' · '));
  }

  const sel: string[] = [];
  if (selection.roomKey) {
    const i = rooms.findIndex((r) => r.room.key === selection.roomKey);
    if (i >= 0) sel.push(`room ${roomLabel(rooms[i], roomRef[i])}`);
  }
  for (const id of selection.wallIds) if (wallRef.has(id)) sel.push(`wall ${wallRef.get(id)}`);
  for (const id of selection.openingIds) {
    const o = plan.openings.find((x) => x.id === id);
    if (o && openingRef.has(id)) sel.push(`${o.type} ${openingRef.get(id)}`);
  }
  for (const id of selection.furnitureIds) {
    const f = plan.furniture.find((x) => x.id === id);
    const def = f && defFor(plan, f.kind);
    if (f && def) sel.push(`${def.label.toLowerCase()} ${furnitureRef.get(id)}`);
  }
  lines.push('', sel.length ? `SELECTED BY THE USER ("this", "it", "here" mean): ${sel.join(', ')}` : 'SELECTED BY THE USER: nothing');

  return { text: lines.join('\n'), refs, kinds, rooms };
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  const len = dist(a, b);
  if (len < 1e-9) return false;
  const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len;
  if (t < -0.01 || t > len + 0.01) return false;
  const off = Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len;
  return off < 0.05;
}
