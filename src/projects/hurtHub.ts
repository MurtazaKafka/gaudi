/**
 * The Hurt Hub @ Davidson: a 1920s one-storey brick mill turned innovation hub.
 *
 * Laid out from the published floor diagram, then corrected from photographs
 * of the real building: the building is scaled to its stated 22,883 sq ft
 * (about 46 × 47 m), the Social Commons shrunk to its stated 2,000 sq ft with
 * a porch in front of it, Event Room 303 deepened to the 11 × 14 m the photos
 * show, and the patio made what it is, an open courtyard with a full brick
 * seat-ring. Coordinates below are metres from the building's north-west
 * corner, north up, as on the diagram.
 *
 * What room rectangles cannot say is done in `finish`: the exact doors and
 * windows of the photos, the brick wall that half closes the Commons off from
 * the Lab, and everything the Hub is furnished with, built as custom items in
 * its real colours and sizes: the mustard leather sofas, the coffee bar, the
 * honeycomb wall, the glass lantern over the entrance, the porch and canopy,
 * the glass-fronted office boxes of the coworking floor, the pergola and the
 * seat-ring outside. Every custom item stays inside what a plan file may carry
 * (customItems.ts: 8 m footprints, parts centred within 5 m and below 6 m).
 */
import type { BuiltinKind, FurnitureDef, Part } from '../catalog';
import { OUTSIDE, type LayoutLink, type LayoutRoom } from '../generate/layout';
import { pointInPolygon } from '../geometry';
import { detectRooms } from '../rooms';
import type { CustomItem, Furniture, Opening, Point, RestMode, Wall } from '../types';
import type { Template, TemplateFinish, TemplateItem } from './templates';

const LAB = 'The Van Deman Innovation Lab';
const COMMONS = 'Social Commons';
const PRIVATE = 'Private business area';
const WEST_OFFICE = 'Exterior private office west';
const EAST_OFFICE = 'Exterior private office east';

/** One storey of brick, the parapet about 5 m up. */
const WALL_HEIGHT = 5;
const WALL_THICKNESS = 0.2;
const FACE = WALL_THICKNESS / 2;

// ---------- the plan ----------

const rooms: LayoutRoom[] = [
  // The coworking floor: one space, drawn as the rectangles it breaks into.
  { name: PRIVATE, type: 'office', x: 0, y: 8, w: 18.5, h: 13.5 },
  { name: 'Private area north-west', type: 'office', x: 0, y: 0, w: 5.5, h: 4 },
  { name: 'Private area north', type: 'office', x: 0, y: 4, w: 15, h: 4 },
  { name: 'Private area east', type: 'hall', x: 18.5, y: 13.5, w: 4, h: 8 },
  { name: 'Private area south-west', type: 'office', x: 0, y: 21.5, w: 14, h: 8 },
  { name: 'Private area south', type: 'hall', x: 14, y: 24.5, w: 8.5, h: 5 },
  { name: 'Private area south-east', type: 'hall', x: 20, y: 29.5, w: 2.5, h: 5.5 },

  { name: 'Phone rooms', type: 'other', x: 5.5, y: 0, w: 17, h: 4 },
  { name: 'Phone rooms south', type: 'hall', x: 15, y: 4, w: 5, h: 4 },
  { name: 'Storage', type: 'closet', x: 20, y: 4, w: 2.5, h: 4 },
  { name: 'Room 311', type: 'office', x: 18.5, y: 8, w: 4, h: 5.5 },
  { name: 'Hurt Hub staff area', type: 'office', x: 14, y: 21.5, w: 8.5, h: 3 },

  { name: 'Student room 2', type: 'office', x: 22.5, y: 0, w: 4, h: 4 },
  { name: 'Student room 3', type: 'office', x: 26.5, y: 0, w: 4, h: 4 },
  { name: 'Student room 4', type: 'office', x: 30.5, y: 0, w: 4, h: 4 },
  { name: 'Student rooms', type: 'hall', x: 22.5, y: 4, w: 12, h: 5 },
  { name: 'Room 203', type: 'office', x: 22.5, y: 9, w: 6, h: 4 },
  { name: 'Hurt Hub staff', type: 'office', x: 22.5, y: 13, w: 6, h: 5 },
  { name: 'Student room 1', type: 'office', x: 28.5, y: 9, w: 4, h: 4.5 },
  { name: 'Room 208', type: 'office', x: 34.5, y: 0, w: 12.5, h: 9 },
  { name: 'Room 212', type: 'office', x: 41.5, y: 9, w: 5.5, h: 9 },

  // The open floor: the lab, its two northern bays, and the commons, half walled off from it.
  { name: LAB, type: 'other', x: 22.5, y: 18, w: 19, h: 16 },
  { name: 'Lab north', type: 'hall', x: 32.5, y: 9, w: 9, h: 4.5 },
  { name: 'Lab middle', type: 'hall', x: 28.5, y: 13.5, w: 13, h: 4.5 },
  { name: COMMONS, type: 'other', x: 22.5, y: 34, w: 19, h: 10 },

  { name: 'Event room 303', type: 'other', x: 0, y: 29.5, w: 14, h: 11 },
  { name: 'Room 302', type: 'office', x: 14, y: 29.5, w: 6, h: 7.5 },
  { name: 'Hall', type: 'hall', x: 20, y: 35, w: 2.5, h: 12 },
  { name: 'Restroom 1', type: 'bathroom', x: 14, y: 37, w: 6, h: 5 },
  { name: 'Restroom 2', type: 'bathroom', x: 14, y: 42, w: 6, h: 5 },
  { name: WEST_OFFICE, type: 'office', x: 0, y: 40.5, w: 14, h: 6.5 },
  // Its south face is under the porch canopy, three metres back from the west block's.
  { name: EAST_OFFICE, type: 'office', x: 41.5, y: 34, w: 12, h: 10 },
];

const door = (a: string, b: string): LayoutLink => ({ a, b, kind: 'door' });
const open = (a: string, b: string): LayoutLink => ({ a, b, kind: 'open' });

const links: LayoutLink[] = [
  open(PRIVATE, 'Private area north'),
  open('Private area north', 'Private area north-west'),
  open(PRIVATE, 'Private area east'),
  open(PRIVATE, 'Private area south-west'),
  open('Private area south-west', 'Private area south'),
  open('Private area south', 'Private area south-east'),
  open('Phone rooms', 'Phone rooms south'),
  open(LAB, 'Lab middle'),
  open('Lab middle', 'Lab north'),
  open('Student rooms', 'Lab north'),
  open(LAB, COMMONS),

  // Placeholders: the real ways in are placed by `finish`.
  { a: COMMONS, b: OUTSIDE, kind: 'door' },
  { a: WEST_OFFICE, b: OUTSIDE, kind: 'door' },
  door('Phone rooms', 'Private area north'),
  door('Phone rooms south', PRIVATE),
  door('Storage', 'Phone rooms south'),
  door('Room 311', PRIVATE),
  door('Hurt Hub staff area', 'Private area south'),
  door('Private area east', LAB),
  door('Room 203', 'Student rooms'),
  door('Hurt Hub staff', LAB),
  door('Student room 1', 'Student rooms'),
  door('Student room 2', 'Student rooms'),
  door('Student room 3', 'Student rooms'),
  door('Student room 4', 'Student rooms'),
  door('Room 208', 'Lab north'),
  door('Room 212', 'Lab middle'),
  door('Event room 303', 'Private area south-west'),
  door('Event room 303', 'Room 302'),
  door('Room 302', 'Private area south-east'),
  door('Hall', 'Private area south-east'),
  door('Restroom 1', 'Hall'),
  door('Restroom 2', 'Hall'),
  door('Hall', COMMONS),
  door(EAST_OFFICE, COMMONS),
];

// ---------- plain rooms: catalog furniture ----------

type Item = TemplateItem;
const it = (room: string, kind: BuiltinKind, x: number, y: number, rot = 0): Item => ({ room, kind, x, y, rot });

/** Rooms with no photograph: plain and plausible. */
const items: Item[] = [
  ...[1, 2, 3, 4].map((at): Item => ({ room: 'Restroom 1', kind: 'toilet', wall: 'w', at })),
  ...[3.2, 4.2].map((at): Item => ({ room: 'Restroom 1', kind: 'bathroom_sink', wall: 'n', at })),
  ...[1, 2, 3, 4].map((at): Item => ({ room: 'Restroom 2', kind: 'toilet', wall: 'w', at })),
  ...[3.2, 4.2].map((at): Item => ({ room: 'Restroom 2', kind: 'bathroom_sink', wall: 's', at })),
  { room: 'Storage', kind: 'bookshelf', wall: 'w', at: 1.2 },
  { room: 'Storage', kind: 'bookshelf', wall: 'w', at: 2.6 },

  ...[1.5, 4.5].flatMap((at): Item[] => [{ room: 'Hurt Hub staff', kind: 'desk', wall: 'n', at }, it('Hurt Hub staff', 'chair', at, 1.05, 180)]),
  { room: 'Hurt Hub staff', kind: 'bookshelf', wall: 'w', at: 3.6 },
  it('Hurt Hub staff', 'plant', 5.5, 4.5),
  ...[3, 5.4, 7.6].flatMap((at): Item[] => [
    { room: 'Hurt Hub staff area', kind: 'desk', wall: 'n', at },
    it('Hurt Hub staff area', 'chair', at, 1.05, 180),
  ]),

  ...[1.8, 4.2, 9.8, 12.2].flatMap((at): Item[] => [
    { room: WEST_OFFICE, kind: 'desk', wall: 'n', at },
    it(WEST_OFFICE, 'chair', at, 1.05, 180),
  ]),
  it(WEST_OFFICE, 'dining_table', 7, 3.6, 0),
  ...[6.6, 7.4].flatMap((x): Item[] => [it(WEST_OFFICE, 'chair', x, 2.8, 0), it(WEST_OFFICE, 'chair', x, 4.4, 180)]),
  { room: WEST_OFFICE, kind: 'sofa', wall: 'w', at: 4.6 },
  it(WEST_OFFICE, 'plant', 13.4, 5.9),

  ...[2.2, 4.6, 7].flatMap((at): Item[] => [
    { room: EAST_OFFICE, kind: 'desk', wall: 'e', at },
    it(EAST_OFFICE, 'chair', 10.95, at, 270),
  ]),
  it(EAST_OFFICE, 'dining_table', 4.5, 6, 90),
  ...[5.6, 6.4].flatMap((y): Item[] => [it(EAST_OFFICE, 'chair', 3.7, y, 270), it(EAST_OFFICE, 'chair', 5.3, y, 90)]),
  { room: EAST_OFFICE, kind: 'sofa', wall: 'n', at: 6.5 },
  { room: EAST_OFFICE, kind: 'bookshelf', wall: 'w', at: 2.6 },
  it(EAST_OFFICE, 'plant', 0.6, 9.3),

];

// ---------- the Hub's own things ----------

const q = (v: number): number => Math.round(v * 1e4) / 1e4;
/** Keep an angle inside what a plan file accepts (±360). */
const deg = (a: number): number => q((((a % 360) + 540) % 360) - 180);

type Extra = Partial<Pick<Part, 'rough' | 'metal' | 'glow' | 'opacity' | 'rot' | 'r2'>>;
const turn = (a: number): Extra => (Math.abs(deg(a)) < 1e-6 ? {} : { rot: [0, deg(a), 0] });

function box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, e: Extra = {}): Part {
  return { shape: 'box', x: q(x), y: q(y), z: q(z), w: q(w), h: q(h), d: q(d), color, ...e };
}
function rbox(x: number, y: number, z: number, w: number, h: number, d: number, color: string, bevel: number, e: Extra = {}): Part {
  return { shape: 'rbox', x: q(x), y: q(y), z: q(z), w: q(w), h: q(h), d: q(d), color, bevel: q(bevel), ...e };
}
function cyl(x: number, y: number, z: number, r: number, h: number, color: string, e: Extra = {}): Part {
  return { shape: 'cylinder', x: q(x), y: q(y), z: q(z), r: q(r), h: q(h), color, ...e };
}
function cone(x: number, y: number, z: number, r: number, h: number, color: string, e: Extra = {}): Part {
  return { shape: 'cone', x: q(x), y: q(y), z: q(z), r: q(r), h: q(h), color, ...e };
}
function ball(x: number, y: number, z: number, r: number, color: string, e: Extra = {}): Part {
  return { shape: 'sphere', x: q(x), y: q(y), z: q(z), r: q(r), color, ...e };
}
function blob(x: number, y: number, z: number, w: number, h: number, d: number, color: string, e: Extra = {}): Part {
  return { shape: 'sphere', x: q(x), y: q(y), z: q(z), w: q(w), h: q(h), d: q(d), color, ...e };
}
function ring(x: number, y: number, z: number, r: number, tube: number, color: string, e: Extra = {}): Part {
  return { shape: 'torus', x: q(x), y: q(y), z: q(z), r: q(r), r2: q(tube), color, ...e };
}
const def = (label: string, w: number, d: number, h: number, parts: Part[]): FurnitureDef => ({
  label,
  w: q(Math.min(8, w)),
  d: q(Math.min(8, d)),
  h: q(Math.min(5, h)),
  parts,
});

// Colours read off the photographs (see the research notes): estimates, ±10%.
const BLACK = '#1e1e1e';
const STEEL = '#1c1c1c';
const BRICK_OUT = '#a35b42';
const BRICK_IN = '#8a4a34';
const DRYWALL = '#dcdbd6';
const WHITE_TOP = '#e6e6e4';
const CHARCOAL = '#4a4a4a';
const SETU_SEAT = '#8c8c8c';
const SETU_BACK = '#7a7a7a';
const MESH = '#2e2f31';
const FRAME_GREY = '#9a9da0';
const WALNUT = '#6c5240';
const WOOD_DOOR = '#6a3a1e';
const GLASS_IN = '#c9d6da';
const FROST = '#d9dedf';
const EXT_GLASS = '#2b3741';
const SKY_GLASS = '#a9bcc6';
const PARTITION_GLASS = '#bfcbd0';
const CONCRETE = '#cfcac0';
const MUSTARD = '#c99335';
const TEAK = '#9c6a3a';
const TEAL_WALL = '#146b6b';
const TURQUOISE = '#1ba3ae';

const GLASS_OUT: Extra = { rough: 0.06, metal: 0.5 };

/** A task chair (Setu-like): seat, back, post and a cross base, facing `facing` degrees from +z. */
function taskChair(x: number, z: number, facing: number, seat: string, back: string, base = '#9a9a9a'): Part[] {
  const s = Math.sin((facing * Math.PI) / 180);
  const c = Math.cos((facing * Math.PI) / 180);
  return [
    rbox(x, 0.46, z, 0.48, 0.07, 0.46, seat, 0.03, turn(facing)),
    rbox(x - 0.22 * s, 0.76, z - 0.22 * c, 0.46, 0.44, 0.05, back, 0.02, turn(facing)),
    cyl(x, 0.24, z, 0.025, 0.4, base, { metal: 0.6, rough: 0.4 }),
    box(x, 0.04, z, 0.58, 0.04, 0.07, base, turn(facing + 45)),
  ];
}

/** A shell chair: seat and back only (the legs read in the seat's shadow). */
function shellChair(x: number, z: number, facing: number, color: string, seatY = 0.46): Part[] {
  const s = Math.sin((facing * Math.PI) / 180);
  const c = Math.cos((facing * Math.PI) / 180);
  return [
    rbox(x, seatY, z, 0.46, 0.06, 0.44, color, 0.025, turn(facing)),
    rbox(x - 0.22 * s, seatY + 0.26, z - 0.22 * c, 0.44, 0.4, 0.05, color, 0.02, turn(facing)),
    box(x, seatY / 2, z, 0.04, seatY, 0.04, '#2a2a2a'),
  ];
}

interface Hole {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A flat panel `len` long and `height` tall, centred on x, with rectangular holes cut out. */
function panelParts(len: number, height: number, holes: Hole[], color: string, z = 0, depth = 0.02, e: Extra = {}, base = 0): Part[] {
  const half = len / 2;
  const xs = [...new Set([-half, half, ...holes.flatMap((h) => [h.x0, h.x1]).filter((x) => x > -half && x < half)].map(q))].sort((a, b) => a - b);
  const strips: { x0: number; x1: number; spans: [number, number][] }[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const [x0, x1] = [xs[i], xs[i + 1]];
    const mid = (x0 + x1) / 2;
    let spans: [number, number][] = [[base, height]];
    for (const h of holes) {
      if (!(h.x0 < mid && mid < h.x1)) continue;
      spans = spans.flatMap(([a, b]): [number, number][] => {
        const out: [number, number][] = [];
        if (h.y0 > a) out.push([a, Math.min(b, h.y0)]);
        if (h.y1 < b) out.push([Math.max(a, h.y1), b]);
        return out.filter(([s, t]) => t - s > 0.01);
      });
    }
    const last = strips[strips.length - 1];
    if (last && JSON.stringify(last.spans) === JSON.stringify(spans)) last.x1 = x1;
    else strips.push({ x0, x1, spans });
  }
  return strips.flatMap((s) => s.spans.map(([a, b]) => box((s.x0 + s.x1) / 2, (a + b) / 2, z, s.x1 - s.x0, b - a, depth, color, e)));
}

/**
 * Glass laid over the wall face above and below a window or door, on both
 * faces, with black frames: the app's openings are 0.9–2.1 m (windows) and
 * 0–2.1 m (doors); this makes one read as tall as the photographs show.
 * `outside`: +1 when +z is outdoors, 0 when both faces are indoors.
 */
function glazeDef(label: string, w: number, sill: number, head: number, outside: 1 | 0, mullions: number): FurnitureDef {
  const parts: Part[] = [];
  for (const s of [1, -1]) {
    const out = outside === 1 && s === 1;
    const glass = outside === 0 ? PARTITION_GLASS : out ? EXT_GLASS : SKY_GLASS;
    const ge: Extra = out ? GLASS_OUT : { rough: 0.15 };
    const gz = s * (FACE + 0.02);
    const fz = s * (FACE + 0.035);
    const zones: [number, number][] = [];
    if (sill < 0.88) zones.push([sill, 0.9]);
    if (head > 2.12) zones.push([2.1, head]);
    for (const [a, b] of zones) {
      parts.push(box(0, (a + b) / 2, gz, w, b - a, 0.02, glass, ge));
      for (let k = 1; k < mullions; k++) parts.push(box(-w / 2 + (k * w) / mullions, (a + b) / 2, fz, 0.04, b - a, 0.02, BLACK));
      if (b - a > 0.75) parts.push(box(0, (a + b) / 2, fz, w, 0.04, 0.02, BLACK));
    }
    parts.push(box(-w / 2 - 0.03, (sill + head) / 2, fz, 0.06, head - sill, 0.03, BLACK));
    parts.push(box(w / 2 + 0.03, (sill + head) / 2, fz, 0.06, head - sill, 0.03, BLACK));
    parts.push(box(0, head + 0.03, fz, w + 0.12, 0.06, 0.03, BLACK));
    if (sill > 0.05) parts.push(box(0, sill - 0.03, fz, w + 0.12, 0.06, 0.04, BLACK));
  }
  return def(label, w + 0.12, WALL_THICKNESS + 0.1, head + 0.06, parts);
}

/** One stretch of the porch along the recessed front: slab, brick edge, rail, black canopy on knee braces. */
function porchDef(len: number, braces: number[], canopyFrom = -len / 2, railFrom = -len / 2): FurnitureDef {
  const half = len / 2;
  const parts: Part[] = [
    box(0, 0.075, 0, len, 0.15, 2.9, '#cfc8bc', { rough: 0.85 }),
    box(0, 0.09, 1.37, len, 0.18, 0.16, BRICK_OUT),
  ];
  const rl = half - railFrom;
  const rc = (railFrom + half) / 2;
  const posts = Math.max(2, Math.round(rl / 1.9) + 1);
  for (let k = 0; k < posts; k++) parts.push(box(railFrom + 0.05 + (k * (rl - 0.1)) / (posts - 1), 0.685, 1.25, 0.05, 1.07, 0.05, BLACK));
  parts.push(box(rc, 1.22, 1.25, rl, 0.04, 0.05, BLACK));
  for (const y of [0.42, 0.66, 0.9]) parts.push(box(rc, y, 1.25, rl, 0.022, 0.022, BLACK));
  const cl = half - canopyFrom;
  const cc = (canopyFrom + half) / 2;
  parts.push(box(cc, 3.55, -0.2, cl, 0.1, 2.5, '#202020', { rough: 0.55, metal: 0.3 }));
  parts.push(box(cc, 3.47, 1.05, cl, 0.3, 0.06, '#202020', { rough: 0.55, metal: 0.3 }));
  for (const bx of braces) parts.push(box(bx, 3.025, -0.95, 0.08, 1.38, 0.08, BLACK, { rot: [46.5, 0, 0] }));
  return def('Porch and canopy', len, 2.9, 3.65, parts);
}

/** A white cylinder (or black dome) pendant row: `n` lamps over `len`, at staggered heights. */
function pendantsDef(len: number, n: number, dome: boolean): FurnitureDef {
  const parts: Part[] = [];
  for (let k = 0; k < n; k++) {
    const x = -len / 2 + ((k + 0.5) * len) / n;
    const y = 3.05 + ((k * 7) % 5) * 0.14;
    parts.push(cyl(x, (y + WALL_HEIGHT) / 2 + 0.1, 0, 0.006, WALL_HEIGHT - y - 0.2, '#2a2a2a'));
    if (dome) {
      parts.push(cone(x, y, 0, 0.19, 0.2, '#1e1e1e', { rough: 0.5 }));
      parts.push(cyl(x, y - 0.1, 0, 0.15, 0.01, '#fff3d6', { glow: 1.2 }));
    } else parts.push(cyl(x, y, 0, 0.13, 0.3, '#f4f4f2', { glow: 0.35, rough: 0.5 }));
  }
  return def(dome ? 'Dome pendants' : 'Cylinder pendants', len, 0.4, WALL_HEIGHT, parts);
}

/** An open-topped office box (drywall, black-framed glass front, a wood door), facing +z, with a desk inside. */
function officeDef(w: number, d: number): FurnitureDef {
  const hw = w / 2;
  const hd = d / 2;
  const glassW = w - 1.2;
  const gx = -hw + 1.1 + glassW / 2;
  return def('Private office', w, d, 3.2, [
    box(0, 1.6, -hd + 0.05, w, 3.2, 0.1, DRYWALL),
    box(-hw + 0.05, 1.6, 0, 0.1, 3.2, d, DRYWALL),
    box(hw - 0.05, 1.6, 0, 0.1, 3.2, d, DRYWALL),
    box(-hw + 0.6, 1.35, hd - 0.04, 0.95, 2.7, 0.06, WOOD_DOOR, { rough: 0.5 }),
    box(-hw + 0.6, 2.95, hd - 0.04, 0.95, 0.46, 0.02, GLASS_IN, { opacity: 0.35, rough: 0.1 }),
    box(gx, 1.6, hd - 0.04, glassW, 3.1, 0.02, GLASS_IN, { opacity: 0.3, rough: 0.1 }),
    box(gx, 1.35, hd - 0.03, glassW, 0.9, 0.015, FROST, { opacity: 0.75, rough: 0.4 }),
    box(0, 3.17, hd - 0.04, w, 0.06, 0.08, BLACK),
    box(-hw + 1.1, 1.6, hd - 0.04, 0.06, 3.2, 0.08, BLACK),
    box(gx, 0.9, hd - 0.03, glassW, 0.04, 0.04, BLACK),
    box(gx, 1.8, hd - 0.03, glassW, 0.04, 0.04, BLACK),
    box(gx, 2.7, hd - 0.03, glassW, 0.04, 0.04, BLACK),
    box(0, 0.016, 0, w - 0.2, 0.012, d - 0.2, '#8a8682'),
    box(0.3, 0.73, -hd + 0.6, 1.6, 0.04, 0.75, WHITE_TOP),
    box(0.3, 0.36, -hd + 0.3, 1.5, 0.7, 0.04, CHARCOAL),
    ...taskChair(0.3, -hd + 1.35, 180, '#3a3a3a', '#333333').slice(0, 2),
  ]);
}

/** A table with chairs down both long sides (and one at each end when `ends`): a meeting room set. */
function meetingDef(label: string, len: number, depth: number, perSide: number, ends: boolean, top: string, chair: 'setu' | 'bucket'): FurnitureDef {
  const parts: Part[] = [];
  if (label.startsWith('Boat')) parts.push(blob(0, 0.74, 0, len, 0.04, depth, top, { rough: 0.45 }));
  else parts.push(box(0, 0.74, 0, len, 0.04, depth, top, { rough: 0.45 }));
  parts.push(box(-len / 2 + 0.35, 0.36, 0, 0.06, 0.72, depth - 0.25, '#b5b8bb', { metal: 0.6, rough: 0.35 }));
  parts.push(box(len / 2 - 0.35, 0.36, 0, 0.06, 0.72, depth - 0.25, '#b5b8bb', { metal: 0.6, rough: 0.35 }));
  const seat = (x: number, z: number, facing: number): Part[] =>
    chair === 'setu'
      ? taskChair(x, z, facing, SETU_SEAT, SETU_BACK)
      : [
          rbox(x, 0.6, z, 0.56, 0.42, 0.56, '#6a6a6a', 0.12, turn(facing)),
          cyl(x, 0.2, z, 0.035, 0.38, BLACK),
          box(x, 0.03, z, 0.56, 0.04, 0.07, BLACK, turn(facing + 45)),
        ];
  const step = len / perSide;
  for (let k = 0; k < perSide; k++) {
    const x = -len / 2 + step * (k + 0.5);
    parts.push(...seat(x, -depth / 2 - 0.3, 0), ...seat(x, depth / 2 + 0.3, 180));
  }
  if (ends) parts.push(...seat(-len / 2 - 0.35, 0, 90), ...seat(len / 2 + 0.35, 0, 270));
  return def(label, len + (ends ? 1.4 : 0.6), depth + 1.4, 1.2, parts);
}

/** A 6 ft training table with two chairs behind it (people face +z). */
function trainingDef(seat: string, back: string, base: string): FurnitureDef {
  return def('Training table', 1.83, 1.5, 1.0, [
    box(0, 0.74, 0.25, 1.83, 0.03, 0.6, '#ededea', { rough: 0.4 }),
    box(-0.8, 0.37, 0.25, 0.05, 0.72, 0.05, '#8c8f93', { metal: 0.5 }),
    box(0.8, 0.37, 0.25, 0.05, 0.72, 0.05, '#8c8f93', { metal: 0.5 }),
    box(-0.8, 0.03, 0.25, 0.06, 0.04, 0.55, '#8c8f93'),
    box(0.8, 0.03, 0.25, 0.06, 0.04, 0.55, '#8c8f93'),
    ...taskChair(-0.45, -0.35, 0, seat, back, base),
    ...taskChair(0.45, -0.35, 0, seat, back, base),
  ]);
}

/** A flat-topped hexagon of three crossed boxes: `f` across the flats, standing in the x-y plane. */
function hexagon(x: number, y: number, z: number, f: number, depth: number, color: string, e: Extra = {}): Part[] {
  const side = f / Math.sqrt(3);
  return [0, 60, 120].map((a) => box(x, y, z, side, f, depth, color, { ...e, ...(a ? { rot: [0, 0, a] as [number, number, number] } : {}) }));
}

type Face = 'n' | 'e' | 's' | 'w';
interface Placed {
  key: string;
  x: number;
  y: number;
  rot: number;
  rest?: RestMode;
  label?: string;
}

// Openings, in diagram metres: the photographs' bays, put where the diagram allows.
const COMMONS_GARAGE = [31.9, 35.3, 38.7];
const SE_FRONT = [43.5, 46.9, 50.3];
const LAB_EAST = [19.6, 21.9, 24.2, 26.5, 28.8];
const LAB_PATIO_DOOR = 31.3;
const WEST_COWORK = [3.1, 9.1, 15.1, 21.1];
const WEST_303 = [32.9, 37.1];
const GARAGE_303 = [2.4, 5.6, 8.8];
const STUDENT_FRONTS: [number, number][] = [
  [23.3, 25.3],
  [27.3, 29.3],
  [31.3, 33.3],
];
const CIRCLE: Point = { x: 52.5, y: 26 };

/** Everything the Hub is furnished with: the definitions, and where each copy stands. */
function furnish(): { defs: Record<string, FurnitureDef>; placed: Placed[] } {
  const defs: Record<string, FurnitureDef> = {};
  const placed: Placed[] = [];
  const add = (key: string, d: FurnitureDef): string => {
    defs[key] = d;
    return key;
  };
  const put = (key: string, x: number, y: number, rot = 0, more: Partial<Placed> = {}): void => {
    placed.push({ key, x, y, rot, ...more });
  };
  /** Against a wall face: `faces` is the way it looks (into the room it is in), `c` the wall's line, `t` along it. */
  const onWall = (key: string, faces: Face, c: number, t: number, off: number, more: Partial<Placed> = {}): void => {
    const d = FACE + off;
    if (faces === 's') put(key, t, c + d, 0, more);
    else if (faces === 'n') put(key, t, c - d, 180, more);
    else if (faces === 'e') put(key, c + d, t, 270, more);
    else put(key, c - d, t, 90, more);
  };
  /** A painted (or brick, or metal) face on a wall from t0 to t1, openings cut out where the wall has them. */
  const paint = (key: string, label: string, color: string, faces: Face, c: number, t0: number, t1: number, holes: { t0: number; t1: number; y0: number; y1: number }[] = [], e: Extra = {}, off = 0.025): void => {
    const tc = (t0 + t1) / 2;
    const sgn = faces === 's' || faces === 'w' ? 1 : -1;
    const local = holes.map((h): Hole => {
      const a = sgn * (h.t0 - tc);
      const b = sgn * (h.t1 - tc);
      return { x0: Math.min(a, b), x1: Math.max(a, b), y0: h.y0, y1: h.y1 };
    });
    add(key, def(label, t1 - t0, 0.03, WALL_HEIGHT, panelParts(t1 - t0, WALL_HEIGHT, local, color, 0, 0.02, { rough: 0.95, ...e })));
    onWall(key, faces, c, tc, off);
  };
  const win = (t: number, w: number, y0 = 0.9, y1 = 2.1) => ({ t0: t - w / 2, t1: t + w / 2, y0, y1 });
  /**
   * A floor finish over a rectangle (stained concrete, carpet): a slab under 3 cm thick, so nothing
   * bumps into it and nothing stands on it but the floor. Cut into equal tiles of at most 8 m.
   */
  const floor = (key: string, label: string, color: string, x0: number, y0: number, x1: number, y1: number, rough = 0.95, y = 0.0125, h = 0.005): void => {
    const nx = Math.ceil((x1 - x0) / 8 - 1e-9);
    const ny = Math.ceil((y1 - y0) / 8 - 1e-9);
    const [w, d] = [(x1 - x0) / nx, (y1 - y0) / ny];
    add(key, def(label, w, d, y + h / 2, [box(0, y, 0, w, h, d, color, { rough })]));
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) put(key, x0 + w * (i + 0.5), y0 + d * (j + 0.5));
  };
  const carpet = (key: string, color: string, x0: number, y0: number, x1: number, y1: number): void =>
    floor(key, 'Carpet', color, x0, y0, x1, y1, 1, 0.016, 0.012);

  // ----- the street front -----

  add('porch-1', porchDef(7.75, [3.675], -0.975, 3.225));
  add('porch-2', porchDef(7.75, [-0.525, 2.875]));
  add('porch-3', porchDef(7.75, [-1.525, 0.025, 3.325]));
  add('porch-4', porchDef(7.75, [-1.025, 2.375]));
  const porchY = 44 + FACE + 1.45;
  put('porch-1', 26.375, porchY);
  put('porch-2', 34.125, porchY, 0, { label: 'Porch' });
  put('porch-3', 41.875, porchY);
  put('porch-4', 49.625, porchY);

  // The glass lantern over the entrance stands on its own two steel columns (it rests on them: see stacking.ts).
  add('lantern-base', def('Lantern columns', 8.0, 4.8, 2.2, [box(-3.35, 1.1, -2, 0.2, 2.2, 0.2, STEEL), box(3.65, 1.1, -2, 0.2, 2.2, 0.2, STEEL)]));
  {
    const lift = 2.2;
    const L = (abs: number) => abs - lift;
    const glass = '#4a6a80';
    const ge: Extra = { opacity: 0.55, rough: 0.05, metal: 0.5 };
    // 8 m wide (the widest part a plan file may carry), from the west block's wall to past the door.
    const parts: Part[] = [
      box(0, L(4.3), 2.36, 7.96, 1.4, 0.04, '#33495a', { rough: 0.08, metal: 0.5 }),
      box(0, L(6.6), 2.36, 7.96, 3.2, 0.04, glass, ge),
      box(0, L(6.6), -2.2, 7.96, 3.2, 0.04, glass, ge),
      box(-3.98, L(6.6), 0.08, 0.04, 3.2, 4.56, glass, ge),
      box(3.98, L(6.6), 0.08, 0.04, 3.2, 4.56, glass, ge),
      // A dark glass roof inside a black rim: the plan still shows the entry under it.
      box(0, 6.0, 0.08, 7.9, 0.06, 4.5, '#2a3138', { opacity: 0.35, rough: 0.1, metal: 0.4 }),
      box(0, 5.85, 2.36, 8.0, 0.3, 0.1, BLACK, { rough: 0.6 }),
      box(0, 5.85, -2.2, 8.0, 0.3, 0.1, BLACK, { rough: 0.6 }),
      box(-3.98, 5.85, 0.08, 0.1, 0.3, 4.66, BLACK, { rough: 0.6 }),
      box(3.98, 5.85, 0.08, 0.1, 0.3, 4.66, BLACK, { rough: 0.6 }),
      ...[-3.98, -2, 0, 2, 3.98].map((x) => box(x, L(5.9), 2.39, 0.07, 4.6, 0.06, BLACK)),
      ...[5.0, 6.1, 7.15].map((y) => box(0, L(y), 2.39, 7.96, 0.07, 0.06, BLACK)),
      ...[-2, 0, 2].map((x) => box(x, L(6.6), -2.23, 0.07, 3.2, 0.06, BLACK)),
      box(0, L(6.1), -2.23, 7.96, 0.07, 0.06, BLACK),
      box(-4.0, L(6.6), 0.08, 0.06, 3.2, 0.07, BLACK),
      box(4.0, L(6.6), 0.08, 0.06, 3.2, 0.07, BLACK),
      box(-4.0, L(6.1), 0.08, 0.06, 0.07, 4.56, BLACK),
      box(4.0, L(6.1), 0.08, 0.06, 0.07, 4.56, BLACK),
      box(-3.98, L(6.6), -2.2, 0.1, 3.2, 0.1, BLACK),
      box(3.98, L(6.6), -2.2, 0.1, 3.2, 0.1, BLACK),
      box(-3.35, 1.4, -2, 0.2, 2.8, 0.2, STEEL),
      box(3.65, 1.4, -2, 0.2, 2.8, 0.2, STEEL),
      // Vertical LED tubes hanging in the lantern.
      ...[
        [-3, 0.8, 6.3],
        [-1.8, -0.6, 6.6],
        [-0.6, 0.9, 6.0],
        [0.6, -0.4, 6.4],
        [1.8, 0.7, 6.1],
        [3, -0.7, 6.5],
      ].map(([x, z, y]) => cyl(x, L(y), z, 0.025, 1.2, '#ffffff', { glow: 1.4 })),
    ];
    add('lantern', def('Glass lantern', 8.0, 4.4, 5, parts));
  }
  put('lantern-base', 26.6, 41.8);
  put('lantern', 26.6, 41.8, 0, { rest: 'top' });

  add('vestibule', def('Vestibule', 2.8, 2, 2.7, [
    box(0, 1.35, 0.98, 2.8, 2.7, 0.03, GLASS_IN, { opacity: 0.3, rough: 0.05 }),
    box(-1.38, 1.35, 0, 0.03, 2.7, 1.96, GLASS_IN, { opacity: 0.3, rough: 0.05 }),
    box(1.38, 1.35, 0, 0.03, 2.7, 1.96, GLASS_IN, { opacity: 0.3, rough: 0.05 }),
    box(0, 2.68, 0.98, 2.84, 0.06, 0.06, BLACK),
    box(-1.38, 2.68, 0, 0.06, 0.06, 2, BLACK),
    box(1.38, 2.68, 0, 0.06, 0.06, 2, BLACK),
    ...[-1.38, -0.9, 0, 0.9, 1.38].map((x) => box(x, 1.35, 0.98, 0.06, 2.7, 0.07, BLACK)),
    box(0, 2.2, 0.98, 2.8, 0.06, 0.07, BLACK),
    box(0, 2.45, 1.0, 0.32, 0.14, 0.03, '#c8222b', { glow: 0.8 }),
  ]));
  put('vestibule', 28.6, 42.9, 180);

  // The 2018 cedar sign beside the door: "THE HURT HUB @DAVIDSON" under a gable outline.
  {
    const ink: Extra = { rough: 0.6 };
    const at = (x: number, y: number, w: number, h: number) => box(x, y, 0.04, w, h, 0.02, '#151515', ink);
    add('cedar-sign', def('Cedar sign', 2.4, 0.08, 3.4, [
      box(0, 1.8, 0, 2.4, 3.2, 0.06, '#b8834c', { rough: 0.7 }),
      at(0, 2.75, 1.4, 0.16),
      at(-0.85, 2.15, 0.1, 0.8), at(-0.55, 2.15, 0.1, 0.8), at(-0.7, 2.15, 0.3, 0.1),
      at(-0.25, 2.15, 0.1, 0.8), at(0.05, 2.15, 0.1, 0.8), at(-0.1, 1.8, 0.3, 0.1),
      at(0.35, 2.15, 0.1, 0.8), at(0.62, 2.33, 0.1, 0.35), at(0.62, 1.97, 0.1, 0.35),
      at(0.48, 2.5, 0.3, 0.1), at(0.48, 2.15, 0.3, 0.1), at(0.48, 1.8, 0.3, 0.1),
      at(0, 1.4, 1.5, 0.14),
      box(-0.5, 3.15, 0.04, 1.15, 0.05, 0.02, '#151515', { rot: [0, 0, 22] }),
      box(0.5, 3.15, 0.04, 1.15, 0.05, 0.02, '#151515', { rot: [0, 0, -22] }),
    ]));
  }
  put('cedar-sign', 26.1, 44 + FACE + 0.05);
  add('cedar-panel', def('Cedar wall panel', 2.2, 0.05, 3.6, [box(0, 1.8, 0, 2.2, 3.6, 0.05, '#c08a4a', { rough: 0.7 })]));
  onWall('cedar-panel', 'n', 44, 26.1, 0.03);

  // Tall glazing: the commons' glazed overhead doors, the office storefronts, the transom over the door.
  add('glaze-garage', glazeDef('Glazed overhead door', 2.6, 0.02, 3.2, 1, 3));
  for (const x of COMMONS_GARAGE) put('glaze-garage', x, 44, 0);
  add('glaze-store', glazeDef('Storefront', 2.4, 0.02, 3.1, 1, 2));
  for (const x of SE_FRONT) put('glaze-store', x, 44, 0);
  add('glaze-entry', glazeDef('Transom', 1.8, 2.1, 3.0, 1, 2));
  put('glaze-entry', 28.6, 44, 0);
  add('glaze-tall', glazeDef('Tall glazing', 1.4, 0.05, 3.5, 1, 2));
  put('glaze-tall', 24.3, 44, 0);

  // The taller south-east block: a stepped parapet above the 5 m walls, up once over the middle, down twice to the back.
  {
    // A plan file keeps every part centred below 6 m, so the coping tops out at 6.03 m.
    const riser = (z: number, d: number, top: number): Part[] => [
      box(1, (WALL_HEIGHT + top - 0.06) / 2, z, 0.26, top - 0.06 - WALL_HEIGHT, d, BRICK_OUT),
      box(1, top - 0.03, z, 0.34, 0.06, d, '#2a2a2a', { rough: 0.5, metal: 0.3 }),
    ];
    add('se-parapet', def('Stepped parapet', 6, 8, 5, [
      ...riser(5, 3.2, 5.75),
      ...riser(0.45, 5.9, 6.03),
      ...riser(-3, 1, 5.6),
      ...riser(-5, 3, 5.35),
      box(-1.75, 5.345, 3.5, 5.5, 0.69, 0.26, BRICK_OUT),
      box(-1.75, 5.72, 3.5, 5.5, 0.06, 0.34, '#2a2a2a', { rough: 0.5, metal: 0.3 }),
    ]));
    put('se-parapet', 52.5, 40.5);
  }
  add('se-sign', def('Cedar sign (end wall)', 2.3, 0.08, 4.6, [
    box(0, 3.6, 0, 2.3, 2.0, 0.06, '#b9874e', { rough: 0.7 }),
    box(0, 4.15, 0.04, 0.06, 0.5, 0.02, '#151515'),
    box(0, 4.15, 0.04, 0.42, 0.06, 0.02, '#151515'),
    box(0, 3.45, 0.04, 1.75, 0.2, 0.02, '#151515'),
    box(0, 3.15, 0.04, 1.0, 0.09, 0.02, '#151515'),
  ]));
  onWall('se-sign', 'e', 53.5, 39.6, 0.05);
  add('bike-rack', def('Bike rack', 2.8, 0.1, 0.95, [-1.1, -0.55, 0, 0.55, 1.1].map((x) => ring(x, 0.5, 0, 0.42, 0.025, '#b9bcbf', { metal: 0.8, rough: 0.3, rot: [90, 0, 0] }))));
  put('bike-rack', 54.6, 41.5, 90);
  add('lamp-post', def('Street lamp', 0.4, 0.4, 4.5, [
    cyl(0, 0.3, 0, 0.12, 0.6, BLACK),
    cyl(0, 2.1, 0, 0.055, 3.6, BLACK),
    ball(0, 4.1, 0, 0.2, '#f5ecd2', { glow: 0.4 }),
    cone(0, 4.42, 0, 0.17, 0.24, BLACK),
  ]));
  for (const x of [25, 37.5, 50]) put('lamp-post', x, 48.4);
  // The west block's side entrance: a small flat black canopy on two braces.
  add('side-canopy', def('Door canopy', 2.8, 1.2, 2.9, [
    box(0, 2.8, 0, 2.8, 0.08, 1.2, '#202020', { rough: 0.55, metal: 0.3 }),
    box(0, 2.74, 0.58, 2.8, 0.2, 0.05, '#202020'),
    box(-1.2, 2.38, -0.15, 0.06, 1.18, 0.06, BLACK, { rot: [49.8, 0, 0] }),
    box(1.2, 2.38, -0.15, 0.06, 1.18, 0.06, BLACK, { rot: [49.8, 0, 0] }),
  ]));
  put('side-canopy', 10.8, 47 + FACE + 0.6);

  // The west end: punched windows' interior is plain; the coworking windows read 2 m tall.
  add('glaze-cowork', glazeDef('Window', 2.0, 0.9, 3.0, 1, 2));
  for (const y of WEST_COWORK) put('glaze-cowork', 0, y, 90);
  add('glaze-303', glazeDef('Window', 1.3, 0.9, 2.7, 1, 2));
  for (const y of WEST_303) put('glaze-303', 0, y, 90);

  // ----- the patio: an open courtyard between the wings -----

  // The lab's curtain wall: tall black windows between grey metal panels.
  add('glaze-lab', glazeDef('Curtain wall', 1.6, 0.5, 3.3, 1, 2));
  for (const y of LAB_EAST) put('glaze-lab', 41.5, y, 270);
  add('glaze-lab-door', glazeDef('Transom', 1.8, 2.1, 3.3, 1, 2));
  put('glaze-lab-door', 41.5, LAB_PATIO_DOOR, 270);
  const labHoles = (ts: number[]) => ts.map((t) => ({ t0: t - 0.85, t1: t + 0.85, y0: 0.45, y1: 3.4 }));
  paint('lab-facade-1', 'Metal panels', '#6c7074', 'e', 41.5, 18.1, 26, labHoles([19.6, 21.9, 24.2]), { rough: 0.5, metal: 0.35 });
  paint('lab-facade-2', 'Metal panels', '#6c7074', 'e', 41.5, 26, 33.9, [...labHoles([26.5, 28.8]), { t0: 30.35, t1: 32.25, y0: 0, y1: 3.4 }], { rough: 0.5, metal: 0.35 });
  // The north wing's brick is painted terracotta where it faces the patio.
  paint('paint-212', 'Painted brick', '#c2613b', 's', 18, 41.6, 46.9, [win(43.3, 1.8), { t0: 45.15, t1: 46.05, y0: 0, y1: 2.1 }]);

  add('paving-pergola', def('Paving', 5.8, 7.9, 0.115, [box(0, 0.0575, 0, 5.8, 0.115, 7.9, '#d2cdc3', { rough: 0.85 })]));
  add('paving-pergola-b', def('Paving', 5.8, 7.9, 0.115, [
    box(0, 0.0575, 0, 5.8, 0.115, 7.9, '#d2cdc3', { rough: 0.85 }),
    box(0, 0.117, 1.35, 5.8, 0.006, 1.6, '#a9533f'),
  ]));
  put('paving-pergola', 44.5, 22.05);
  put('paving-pergola-b', 44.5, 29.95);
  {
    const posts: Part[] = [];
    for (const x of [-1.6, 1.6]) for (const z of [-2.5, 0, 2.5]) posts.push(box(x, 1.9, z, 0.15, 3.8, 0.15, '#1c1c1c'));
    const slats: Part[] = [];
    for (let k = 0; k < 17; k++) slats.push(box(0, 3.92, -3.5 + k * 0.4375, 5.8, 0.15, 0.06, '#a08e78', { rough: 0.85 }));
    add('pergola', def('Pergola', 5.8, 7.5, 4.0, [
      ...posts,
      ...[-1.66, -1.54, 1.54, 1.66].map((x) => box(x, 3.72, 0, 0.06, 0.25, 7.5, '#9c8770', { rough: 0.85 })),
      ...slats,
    ]));
  }
  put('pergola', 44.7, 22.05, 0, { rest: 'top', label: 'Pergola' });
  put('pergola', 44.7, 29.95, 0, { rest: 'top' });

  // The circle: a concrete disc with scored joints inside a round brick seat wall with a cast-stone cap, open east and west.
  {
    const parts: Part[] = [
      cyl(0, 0.06, 0, 3.47, 0.12, CONCRETE, { rough: 0.85 }),
      ring(0, 0.121, 0, 1.0, 0.02, '#b9b4aa'),
      ...[0, 45, 90, 135].map((a) => box(0, 0.1215, 0, 6.9, 0.003, 0.025, '#aaa59c', turn(a))),
    ];
    for (let k = 0; k < 20; k++) {
      const a = 9 + k * 18;
      if (Math.abs(a - 180) < 25 || a < 25 || a > 335) continue;
      const r = (a * Math.PI) / 180;
      const [x, z] = [3.7 * Math.cos(r), 3.7 * Math.sin(r)];
      parts.push(box(x, 0.32, z, 1.24, 0.44, 0.4, '#8e3c2e', turn(90 - a)));
      parts.push(box(x, 0.58, z, 1.3, 0.08, 0.52, '#d4d2cc', { rough: 0.7, ...turn(90 - a) }));
    }
    add('seat-ring', def('Seat wall', 7.9, 7.9, 0.62, parts));
    put('seat-ring', CIRCLE.x, CIRCLE.y, 0, { label: 'Patio' });
  }
  {
    // A quarter of the paver ring and its concrete edge; the circle's centre is this item's north-west corner.
    const parts: Part[] = [];
    for (let k = 0; k < 6; k++) {
      const a = 7.5 + k * 15;
      const r = (a * Math.PI) / 180;
      parts.push(box(5.1 * Math.cos(r) - 3.65, 0.055, 5.1 * Math.sin(r) - 3.65, 1.72, 0.11, 2.8, '#9a4a3a', turn(90 - a)));
      parts.push(box(6.88 * Math.cos(r) - 3.65, 0.06, 6.88 * Math.sin(r) - 3.65, 1.92, 0.12, 0.85, CONCRETE, { rough: 0.85, ...turn(90 - a) }));
    }
    add('pavers', def('Brick pavers', 7.3, 7.3, 0.12, parts));
    for (const rot of [0, 90, 180, 270]) {
      const t = (rot * Math.PI) / 180;
      // Where the local corner (−3.65, −3.65) lands is the circle's centre.
      const [ox, oy] = [-3.65 * Math.cos(t) + 3.65 * Math.sin(t), -3.65 * Math.sin(t) - 3.65 * Math.cos(t)];
      put('pavers', CIRCLE.x - ox, CIRCLE.y - oy, rot);
    }
  }
  add('picnic', def('Picnic table', 1.8, 1.6, 0.78, [
    box(0, 0.74, 0, 1.8, 0.05, 0.75, '#b8875a', { rough: 0.8 }),
    box(0, 0.44, 0.62, 1.8, 0.05, 0.28, '#b8875a', { rough: 0.8 }),
    box(0, 0.44, -0.62, 1.8, 0.05, 0.28, '#b8875a', { rough: 0.8 }),
    box(-0.7, 0.37, 0, 0.08, 0.72, 1.45, '#9a6d45'),
    box(0.7, 0.37, 0, 0.08, 0.72, 1.45, '#9a6d45'),
  ]));
  for (const y of [20.3, 23.7, 27.1]) put('picnic', 44.7, y, 0, { rest: 'top' });
  add('patio-high', def('High table and stools', 1.9, 1.9, 1.06, [
    box(0, 1.0, 0, 0.78, 0.06, 0.78, '#6e7074', { rough: 0.6, rot: [0, 45, 0] }),
    cyl(0, 0.5, 0, 0.12, 1.0, '#6e7074', { r2: 0.2, rough: 0.6 }),
    cyl(0, 0.03, 0, 0.36, 0.06, '#6e7074'),
    cyl(-0.75, 0.38, 0, 0.19, 0.76, '#6e7074', { r2: 0.15, rough: 0.6 }),
    cyl(0.75, 0.38, 0, 0.19, 0.76, '#6e7074', { r2: 0.15, rough: 0.6 }),
    cyl(0, 0.23, -0.78, 0.2, 0.46, '#c9d41c', { rough: 0.6 }),
    cyl(0, 0.23, 0.78, 0.2, 0.46, '#c9d41c', { rough: 0.6 }),
  ]));
  put('patio-high', 51.4, 24.9, 0, { rest: 'top' });
  put('patio-high', 53.6, 27.2, 30, { rest: 'top' });
  add('adirondack', def('Adirondack chair', 0.8, 0.95, 0.95, [
    box(0, 0.36, 0.05, 0.62, 0.05, 0.55, '#2ba3a8', { rot: [-8, 0, 0] }),
    box(0, 0.66, -0.33, 0.62, 0.72, 0.05, '#2ba3a8', { rot: [-20, 0, 0] }),
    box(-0.38, 0.6, 0.02, 0.12, 0.03, 0.75, '#2ba3a8'),
    box(0.38, 0.6, 0.02, 0.12, 0.03, 0.75, '#2ba3a8'),
    box(-0.33, 0.3, 0.35, 0.06, 0.6, 0.06, '#24898d'),
    box(0.33, 0.3, 0.35, 0.06, 0.6, 0.06, '#24898d'),
    box(-0.33, 0.2, -0.25, 0.06, 0.4, 0.06, '#24898d'),
    box(0.33, 0.2, -0.25, 0.06, 0.4, 0.06, '#24898d'),
  ]));
  for (const a of [-62, -46, -30]) {
    const r = (a * Math.PI) / 180;
    put('adirondack', CIRCLE.x + 6.9 * Math.cos(r), CIRCLE.y + 6.9 * Math.sin(r), 90 + a, { rest: 'top' });
  }
  add('evergreen', def('Evergreen', 1.2, 1.2, 3.0, [cyl(0, 0.2, 0, 0.08, 0.4, '#5a4636'), cone(0, 1.55, 0, 0.6, 2.7, '#2f5a32', { rough: 0.95 })]));
  add('shrubs', def('Shrubs', 2.0, 1.2, 0.8, [
    blob(-0.55, 0.35, 0, 0.9, 0.7, 0.9, '#5f7e45'),
    blob(0.25, 0.4, 0.1, 1.0, 0.8, 1.0, '#6b8a4c'),
    blob(0.75, 0.3, -0.15, 0.7, 0.6, 0.7, '#7b8f52'),
  ]));
  for (const [x, y] of [[61.2, 21.6], [61.8, 26], [61.2, 30.4]] as const) put('evergreen', x, y);
  for (const [x, y] of [[60.4, 23.8], [60.4, 28.2]] as const) put('shrubs', x, y, 90);

  // ----- the Social Commons -----

  const brickE: Extra = { rough: 0.95 };
  paint('brick-cn1', 'Exposed brick', BRICK_IN, 's', 34, 26.6, 34, [], brickE, 0.02);
  paint('brick-cn2', 'Exposed brick', BRICK_IN, 's', 34, 34, 41.4, [], brickE, 0.02);
  paint('brick-ce1', 'Exposed brick', BRICK_IN, 'w', 41.5, 34.1, 39.1, [], brickE, 0.02);
  paint('brick-ce2', 'Exposed brick', BRICK_IN, 'w', 41.5, 39.1, 43.9, [{ t0: 39.15, t1: 40.85, y0: 0, y1: 2.15 }], brickE, 0.02);
  paint('brick-cw', 'Exposed brick', BRICK_IN, 'e', 22.5, 34.1, 41.5, [{ t0: 35.2, t1: 36.2, y0: 0, y1: 2.15 }], brickE, 0.02);
  paint('sage-w', 'Painted wall', '#5f7a69', 'e', 22.5, 41.5, 43.9, [], {}, 0.02);
  paint('sage-s', 'Painted wall', '#5f7a69', 'n', 44, 22.6, 23.55, [], {}, 0.02);
  const garageHoles = (ts: number[]) => ts.map((t) => ({ t0: t - 1.36, t1: t + 1.36, y0: 0, y1: 3.28 }));
  paint('surround-1', 'Painted wall', '#5d675c', 'n', 44, 29.6, 37, garageHoles([31.9, 35.3]), {}, 0.02);
  paint('surround-2', 'Painted wall', '#5d675c', 'n', 44, 37, 41.4, garageHoles([38.7]), {}, 0.02);

  {
    // Honeycomb shelving: wood cells on a white lattice, on the brick.
    const parts: Part[] = [box(0, 2.05, 0, 2.4, 3.5, 0.3, '#f0ece4', { rough: 0.8 })];
    const pitch = 0.52;
    const colStep = (1.5 * pitch) / Math.sqrt(3);
    for (let c = -2; c <= 2; c++) {
      for (let r = 0; r < 5; r++) {
        const y = 0.62 + r * pitch + (Math.abs(c) % 2 ? pitch / 2 : 0);
        const shade = (c * 7 + r * 3) % 4 === 0 ? '#b98a54' : '#c9a06a';
        parts.push(...hexagon(c * colStep, y, 0.16, 0.45, 0.02, shade, { rough: 0.7 }));
      }
    }
    add('honeycomb', def('Honeycomb shelving', 2.4, 0.34, 3.8, parts));
  }
  onWall('honeycomb', 'e', 22.5, 37.6, 0.17);
  onWall('honeycomb', 'e', 22.5, 40.0, 0.17);

  {
    const tiles = ['#8c98a6', '#c9c2b2', '#5e6b7a', '#c9c2b2', '#8c98a6', '#5e6b7a'];
    const hex: Part[] = [];
    tiles.forEach((color, k) => {
      const x = -3.2 + (k % 3) * 0.3 + (k > 2 ? 0.15 : 0);
      const y = k > 2 ? 0.42 : 0.7;
      hex.push(...hexagon(x, y, 1.285, 0.27, 0.01, color, { rough: 0.5 }));
    });
    add('coffee-bar', def('Coffee bar', 6.8, 2.9, 1.9, [
      box(-0.35, 0.5, 0.95, 6.0, 1.0, 0.65, '#3e3330', { rough: 0.75 }),
      box(-0.35, 1.03, 0.98, 6.1, 0.05, 0.78, '#e2e0da', { rough: 0.3 }),
      box(3.0, 0.5, -0.1, 0.7, 1.0, 2.75, '#3e3330', { rough: 0.75 }),
      box(3.0, 1.03, -0.1, 0.78, 0.05, 2.8, '#e2e0da', { rough: 0.3 }),
      ...hex,
      box(-0.5, 0.45, -1.15, 4.0, 0.9, 0.6, '#3a3a3a'),
      box(-0.5, 0.92, -1.15, 4.1, 0.04, 0.64, '#d8d6d0', { rough: 0.3 }),
      box(-1.0, 1.15, -1.2, 0.7, 0.42, 0.5, '#b8b8b8', { metal: 0.8, rough: 0.3 }),
      cyl(-2.0, 1.14, -1.2, 0.1, 0.4, '#c0c0c0', { metal: 0.8, rough: 0.3 }),
      cyl(-1.7, 1.14, -1.2, 0.1, 0.4, '#c0c0c0', { metal: 0.8, rough: 0.3 }),
      box(2.2, 0.9, -1.13, 0.75, 1.8, 0.65, '#c4c6c8', { metal: 0.7, rough: 0.35 }),
    ]));
  }
  put('coffee-bar', 33, 35.55, 0, { label: 'Social Commons' });
  add('bar-back', def('Steel shelf frame', 4.6, 0.5, 3.1, [
    box(-2.25, 1.5, 0, 0.06, 3.0, 0.06, STEEL),
    box(2.25, 1.5, 0, 0.06, 3.0, 0.06, STEEL),
    box(0, 3.0, 0, 4.56, 0.06, 0.06, STEEL),
    box(0, 1.35, -0.1, 4.4, 0.03, 0.28, '#3a3026'),
    box(0, 1.75, -0.1, 4.4, 0.03, 0.28, '#3a3026'),
    box(-0.7, 2.55, -0.2, 2.0, 0.17, 0.01, '#ededed'),
    box(0, 2.3, -0.2, 3.3, 0.1, 0.01, '#ededed'),
    box(-0.5, 2.1, -0.2, 2.5, 0.1, 0.01, '#ededed'),
  ]));
  put('bar-back', 32.5, 34 + FACE + 0.27);
  add('art-panel', def('Steel art panel', 1.6, 0.05, 3.4, [
    box(0, 2.4, 0, 1.6, 2.0, 0.03, '#6b4a3a', { rough: 0.8, metal: 0.3 }),
    box(0.15, 2.5, 0.02, 1.0, 1.3, 0.01, '#5d5f61', { rough: 0.6, metal: 0.4 }),
  ]));
  onWall('art-panel', 's', 34, 38.8, 0.05);
  add('bar-stool', def('Bar stool', 0.45, 0.45, 0.98, [
    rbox(0, 0.75, 0, 0.42, 0.06, 0.4, '#b39c84', 0.025),
    rbox(0, 0.9, -0.17, 0.4, 0.22, 0.04, '#b39c84', 0.015),
    ...[-0.15, 0.15].flatMap((x) => [-0.15, 0.15].map((z) => cyl(x, 0.37, z, 0.012, 0.74, BLACK))),
    ring(0, 0.3, 0, 0.17, 0.01, BLACK),
  ]));
  for (const x of [30.3, 31.2, 32.1, 33, 33.9, 34.8]) put('bar-stool', x, 37.2, 180);

  add('sofa-mustard', def('Leather sofa', 2.2, 0.9, 0.82, [
    rbox(0, 0.32, 0.05, 2.2, 0.26, 0.8, MUSTARD, 0.04, { rough: 0.45 }),
    rbox(-0.52, 0.5, 0.08, 1.02, 0.14, 0.7, '#d5a158', 0.05, { rough: 0.45 }),
    rbox(0.52, 0.5, 0.08, 1.02, 0.14, 0.7, '#d5a158', 0.05, { rough: 0.45 }),
    rbox(0, 0.62, -0.34, 2.1, 0.42, 0.2, MUSTARD, 0.06, { rough: 0.45 }),
    rbox(-1.02, 0.55, 0.05, 0.16, 0.3, 0.8, MUSTARD, 0.05, { rough: 0.45 }),
    rbox(1.02, 0.55, 0.05, 0.16, 0.3, 0.8, MUSTARD, 0.05, { rough: 0.45 }),
    ...[-0.95, 0.95].flatMap((x) => [-0.32, 0.32].map((z) => cyl(x, 0.09, z, 0.025, 0.18, TEAK, { r2: 0.015 }))),
  ]));
  add('armchair-teak', def('Armchair', 0.75, 0.8, 0.8, [
    rbox(0, 0.42, 0.04, 0.6, 0.14, 0.6, '#9aa2ac', 0.04),
    rbox(0, 0.64, -0.28, 0.58, 0.42, 0.12, '#9aa2ac', 0.04, { rot: [-12, 0, 0] }),
    box(0, 0.34, 0.03, 0.68, 0.05, 0.66, TEAK),
    box(-0.34, 0.56, 0, 0.05, 0.05, 0.75, TEAK),
    box(0.34, 0.56, 0, 0.05, 0.05, 0.75, TEAK),
    ...[-0.34, 0.34].flatMap((x) => [-0.33, 0.33].map((z) => box(x, 0.27, z, 0.05, 0.54, 0.05, TEAK))),
  ]));
  add('chair-cognac', def('Lounge chair', 0.75, 0.75, 0.85, [
    rbox(0, 0.38, 0.08, 0.66, 0.06, 0.55, '#c48a4a', 0.025, { rough: 0.45, rot: [-8, 0, 0] }),
    rbox(0, 0.62, -0.25, 0.66, 0.5, 0.06, '#c48a4a', 0.025, { rough: 0.45, rot: [-20, 0, 0] }),
    ...[-0.3, 0.3].flatMap((x) => [-0.28, 0.28].map((z) => cyl(x, 0.2, z, 0.012, 0.4, BLACK))),
  ]));
  add('table-round', def('Coffee table', 0.9, 0.9, 0.44, [
    cyl(0, 0.42, 0, 0.45, 0.03, '#1f1f1f', { rough: 0.4 }),
    ring(0, 0.03, 0, 0.32, 0.012, BLACK),
    ...[0, 120, 240].map((a) => cyl(0.3 * Math.cos((a * Math.PI) / 180), 0.21, 0.3 * Math.sin((a * Math.PI) / 180), 0.01, 0.4, BLACK)),
  ]));
  add('rug-grey', def('Rug', 2.8, 2.2, 0.02, [box(0, 0.016, 0, 2.8, 0.012, 2.2, '#a9abaa'), box(0.35, 0.0225, -0.2, 1.4, 0.002, 1.0, '#c6c8c7')]));
  add('rug-lime', def('Rug', 2.6, 2.0, 0.02, [box(0, 0.016, 0, 2.6, 0.012, 2.0, '#bfc79a'), box(-0.4, 0.0225, 0.2, 1.2, 0.002, 0.9, '#a7ab9a')]));
  // Group by the coffee bar.
  put('rug-grey', 32, 40.2);
  put('sofa-mustard', 32, 41.35, 180);
  put('armchair-teak', 31.2, 39.15);
  put('armchair-teak', 32.8, 39.15);
  put('table-round', 32, 40.25);
  // Group by the east wall.
  put('rug-lime', 38.7, 38.6, 90);
  put('sofa-mustard', 40.25, 38.6, 90);
  put('armchair-teak', 37.3, 37.9, 270);
  put('armchair-teak', 37.3, 39.3, 270);
  put('table-round', 38.7, 38.6);
  // Cognac chairs by the honeycomb.
  put('chair-cognac', 24.4, 37.3, 270);
  put('chair-cognac', 24.4, 38.7, 270);
  put('table-round', 25.3, 38.0);
  add('table-mint', def('Round table, four chairs', 2.0, 2.0, 0.9, [
    cyl(0, 0.74, 0, 0.55, 0.04, '#6c4e36', { rough: 0.45 }),
    cyl(0, 0.37, 0, 0.05, 0.7, BLACK),
    cyl(0, 0.02, 0, 0.28, 0.03, BLACK),
    ...[0, 90, 180, 270].flatMap((a) => {
      const r = (a * Math.PI) / 180;
      return shellChair(0.78 * Math.sin(r), 0.78 * Math.cos(r), a + 180, '#b8cdbf');
    }),
  ]));
  put('table-mint', 35.4, 41.4);
  add('pub-set', def('Pub table, three stools', 1.6, 1.6, 1.1, [
    cyl(0, 1.05, 0, 0.35, 0.04, '#1a1a1a', { rough: 0.4 }),
    cyl(0, 0.53, 0, 0.035, 1.02, BLACK),
    cyl(0, 0.02, 0, 0.25, 0.03, BLACK),
    ...[30, 150, 270].flatMap((a) => {
      const r = (a * Math.PI) / 180;
      const [x, z] = [0.58 * Math.cos(r), 0.58 * Math.sin(r)];
      return [cyl(x, 0.76, z, 0.19, 0.05, '#b88a55', { rough: 0.6 }), cyl(x, 0.38, z, 0.02, 0.74, BLACK), ring(x, 0.28, z, 0.15, 0.01, BLACK)];
    }),
  ]));
  for (const x of [33.6, 37, 40.3]) put('pub-set', x, 43.05);
  add('window-counter', def('Window counter', 2.8, 0.45, 1.06, [
    box(0, 1.04, 0, 2.8, 0.04, 0.45, '#e8e6e0', { rough: 0.3 }),
    box(-1.25, 0.51, 0, 0.05, 1.02, 0.4, BLACK),
    box(1.25, 0.51, 0, 0.05, 1.02, 0.4, BLACK),
  ]));
  put('window-counter', 24.7, 43.6);
  for (const x of [23.8, 24.7, 25.6]) put('bar-stool', x, 43.0);
  add('mat', def('Entry mat', 3.0, 1.8, 0.02, [box(0, 0.016, 0, 3.0, 0.012, 1.8, '#2f3033'), box(0, 0.0225, 0, 2.7, 0.002, 1.5, '#3a3c40')]));
  put('mat', 28.6, 40.8);
  // Near-black stained concrete, polished.
  floor('floor-commons', 'Stained concrete', '#2e2926', 22.6, 34.1, 41.4, 43.9, 0.3);

  add('column', def('Timber column', 0.25, 0.25, 5, [box(0, 2.5, 0, 0.25, 5, 0.25, '#ece8e0', { rough: 0.85 })]));
  add('column-steel', def('Steel column', 0.22, 0.22, 5, [
    box(0, 2.5, -0.09, 0.22, 5, 0.03, STEEL),
    box(0, 2.5, 0.09, 0.22, 5, 0.03, STEEL),
    box(0, 2.5, 0, 0.03, 5, 0.18, STEEL),
  ]));
  for (const x of [25.8, 29.4, 33, 36.6]) put('column', x, 38.4);
  put('column-steel', 27.6, 38.4);
  add('duct', def('Duct', 7.4, 0.6, 4.6, [rbox(0, 4.3, 0, 7.4, 0.6, 0.6, '#e4e4e4', 0.29, { rough: 0.6 })]));
  put('duct', 30.4, 36.8);
  put('duct', 37.8, 36.8);
  add('pendants-white', pendantsDef(7.2, 5, false));
  add('pendants-dome', pendantsDef(7.2, 4, true));
  put('pendants-white', 30.6, 40.6);
  put('pendants-white', 37.8, 40.6);

  // ----- the Van Deman Innovation Lab -----

  paint('brick-lw1', 'Exposed brick', BRICK_IN, 'e', 22.5, 18.1, 23.5, [{ t0: 20.0, t1: 21.0, y0: 0, y1: 2.15 }], brickE, 0.02);
  paint('brick-lw2', 'Exposed brick', BRICK_IN, 'e', 22.5, 23.5, 29.0, [], brickE, 0.02);
  {
    const slats: Part[] = [];
    for (let k = 0; k < 18; k++) slats.push(box(-2.4 + k * 0.2824, 1.45, 0, 0.09, 2.8, 0.12, '#8a5634', { rough: 0.7 }));
    add('slat-screen', def('Slat wall sign', 5.0, 0.6, 2.9, [
      ...slats,
      box(0, 2.88, 0, 5.0, 0.06, 0.12, '#8a5634'),
      box(0, 2.3, 0.08, 3.8, 0.16, 0.02, '#c8ccd0', { metal: 0.7, rough: 0.3 }),
      box(0, 0.45, 0.33, 4.6, 0.9, 0.5, '#e8e8e6'),
    ]));
  }
  onWall('slat-screen', 'e', 22.5, 31.55, 0.08);
  add('lab-reception', def('Reception desk', 4.0, 0.9, 1.15, [
    box(0, 0.58, 0.38, 4.0, 1.04, 0.08, '#4e2e22', { rough: 0.5 }),
    box(0, 0.06, 0.43, 4.0, 0.12, 0.04, '#b45a2a', { metal: 0.4, rough: 0.4 }),
    box(0, 1.1, 0.25, 4.06, 0.04, 0.42, '#4e2e22', { rough: 0.5 }),
    box(0, 0.74, -0.05, 3.9, 0.04, 0.75, '#e4e2dc'),
    box(-1.98, 0.55, 0, 0.05, 1.1, 0.88, '#4e2e22'),
    box(1.98, 0.55, 0, 0.05, 1.1, 0.88, '#4e2e22'),
    box(-0.6, 0.98, -0.12, 0.55, 0.34, 0.03, '#1a1a1a'),
    box(0.6, 0.98, -0.12, 0.55, 0.34, 0.03, '#1a1a1a'),
  ]));
  put('lab-reception', 24.15, 31.55, 270, { label: 'Innovation Lab' });
  for (const y of [19.6, 22.6, 25.6, 28.6, 31.6]) put('column', 26.6, y);
  for (const x of [32.25, 37.4]) for (const y of [20.6, 24.2, 27.8, 31.4]) put('column', x, y);
  put('duct', 25.2, 22.2, 90);
  put('duct', 25.2, 29.6, 90);
  put('pendants-dome', 25.4, 25.8, 90);
  put('pendants-dome', 34.8, 33.2);

  add('carpet-lab', def('Carpet', 5.0, 5.5, 0.025, [
    box(0, 0.016, 0, 5.0, 0.012, 5.5, '#d9d5cb'),
    box(1.2, 0.0225, 1.5, 1.2, 0.002, 0.6, '#c5d46a'),
    box(-1.5, 0.0225, -2.0, 0.6, 0.002, 1.2, '#c5d46a'),
    ...[-1.8, -0.6, 0.6, 1.8].map((z) => box(0, 0.0225, z, 5.0, 0.002, 0.02, '#8a857e')),
    ...[-1.3, 1.3].map((x) => box(x, 0.0225, 0, 0.02, 0.002, 5.5, '#8a857e')),
  ]));
  for (const x of [30, 35]) for (const y of [23, 28.5]) put('carpet-lab', x, y);
  // Dark brown stained concrete round the island carpet; lighter brown by the patio glass.
  floor('floor-lab-w', 'Stained concrete', '#3e3029', 22.6, 18.1, 27.5, 33.9, 0.35);
  floor('floor-lab-n', 'Stained concrete', '#3e3029', 27.5, 18.1, 37.5, 20.25, 0.35);
  floor('floor-lab-s', 'Stained concrete', '#3e3029', 27.5, 31.25, 37.5, 33.9, 0.35);
  floor('floor-lounge', 'Stained concrete', '#4e3f35', 37.5, 18.1, 41.4, 33.9, 0.4);
  floor('floor-lab-mid', 'Stained concrete', '#3e3029', 28.6, 13.6, 41.4, 18.1, 0.35);
  floor('floor-lab-north', 'Stained concrete', '#3e3029', 32.6, 9.1, 41.4, 13.6, 0.35);
  floor('floor-alley', 'Stained concrete', '#3e3029', 22.6, 4.1, 34.4, 8.9, 0.35);
  add('high-table', def('High table, six stools', 2.4, 2.2, 1.12, [
    box(0, 1.05, 0, 2.4, 0.04, 0.9, '#f0f0ee', { rough: 0.35 }),
    box(-1.1, 0.52, 0, 0.05, 1.02, 0.7, '#9a9a9a', { metal: 0.4 }),
    box(1.1, 0.52, 0, 0.05, 1.02, 0.7, '#9a9a9a', { metal: 0.4 }),
    box(0, 0.25, 0, 2.2, 0.04, 0.04, '#9a9a9a'),
    ...[-0.8, 0, 0.8].flatMap((x) =>
      [-1, 1].flatMap((s) => [
        rbox(x, 0.76, s * 0.78, 0.42, 0.06, 0.4, '#f2f2f0', 0.025),
        box(x, 0.8, s * 0.78, 0.34, 0.03, 0.32, '#7a1c2c'),
        rbox(x, 0.97, s * 0.96, 0.4, 0.32, 0.04, '#f2f2f0', 0.015),
        cyl(x, 0.37, s * 0.78, 0.015, 0.74, '#c0c0c0', { metal: 0.7 }),
      ]),
    ),
  ]));
  put('high-table', 29.6, 22.8);
  put('high-table', 29.6, 26.6);
  add('train-setu', trainingDef(SETU_SEAT, SETU_BACK, '#9a9a9a'));
  for (const [x, y, r] of [[33.6, 22.2, 0], [36, 22.2, 0], [33.6, 25.6, 180], [36, 25.6, 180], [33.6, 29, 0], [36, 29, 0]] as const) put('train-setu', x, y, r);
  add('whiteboard-mobile', def('Mobile whiteboard', 1.85, 0.5, 1.95, [
    box(0, 1.3, 0, 1.8, 1.2, 0.03, '#f6f6f4', { rough: 0.25 }),
    box(-0.9, 0.95, 0, 0.04, 1.9, 0.04, '#b0b0b0', { metal: 0.5 }),
    box(0.9, 0.95, 0, 0.04, 1.9, 0.04, '#b0b0b0', { metal: 0.5 }),
    box(-0.9, 0.04, 0, 0.05, 0.05, 0.5, '#9a9a9a'),
    box(0.9, 0.04, 0, 0.05, 0.05, 0.5, '#9a9a9a'),
  ]));
  for (const y of [22.3, 26, 29.6]) put('whiteboard-mobile', 31.6, y, 90);
  add('pouf', def('Pouf', 0.5, 0.5, 0.44, [cyl(0, 0.22, 0, 0.25, 0.44, '#6e2a63', { rough: 0.95 })]));
  put('pouf', 30.4, 29.8);
  put('pouf', 36.9, 30.9);
  put('pouf', 39.7, 27.3);

  // The computer bar: a blue mural with radiating lines, a row of iMacs in front of it.
  {
    const lines: Part[] = [];
    const tops = [-1.95, -1.45, -0.9, -0.35, 0.35, 0.9, 1.45, 1.95];
    const colors = ['#f3b21a', '#e8792a', '#ffffff', '#c8222b', '#f3b21a', '#ffffff', '#e8792a', '#f3b21a'];
    tops.forEach((xt, k) => {
      const len = Math.hypot(xt, 2.8);
      const a = (Math.atan2(xt, 2.8) * 180) / Math.PI;
      lines.push(box(xt / 2, 0.3 + 1.4, 0.012, 0.05, len, 0.005, colors[k], { rot: [0, 0, deg(-a)] }));
    });
    add('mural', def('Blue mural', 4.0, 0.04, 3.2, [
      box(0, 1.6, 0, 4.0, 3.0, 0.02, '#1c66d4', { rough: 0.85 }),
      ...lines,
      ring(-1.2, 0.55, 0.015, 0.4, 0.03, '#e8792a', { rot: [90, 0, 0] }),
      ring(1.2, 0.55, 0.015, 0.4, 0.03, '#f3b21a', { rot: [90, 0, 0] }),
    ]));
  }
  onWall('mural', 's', 13.5, 30.5, 0.02);
  add('imac-bar', def('Computer bar', 4.0, 1.6, 1.25, [
    box(0, 0.74, -0.25, 4.0, 0.04, 0.75, '#e9e9e7'),
    box(-1.9, 0.36, -0.25, 0.06, 0.72, 0.65, '#3a3a3a'),
    box(1.9, 0.36, -0.25, 0.06, 0.72, 0.65, '#3a3a3a'),
    ...[-1.6, -0.8, 0, 0.8, 1.6].flatMap((x) => [
      box(x, 1.03, -0.42, 0.55, 0.38, 0.03, '#d9dadb', { metal: 0.5, rough: 0.3 }),
      box(x, 1.06, -0.4, 0.5, 0.29, 0.005, '#cfe3f5', { glow: 0.6 }),
    ]),
    ...[-1.6, -0.8, 0, 0.8, 1.6].flatMap((x) => shellChair(x, 0.35, 180, '#2b2b2b').slice(0, 2)),
  ]));
  put('imac-bar', 30.5, 14.95);

  // The east lounge, along the glass onto the pergola.
  paint('lounge-wall-1', 'Painted wall', '#8d8b87', 'w', 41.5, 18.1, 26, labHoles([19.6, 21.9, 24.2]), {}, 0.02);
  paint('lounge-wall-2', 'Painted wall', '#8d8b87', 'w', 41.5, 26, 33.9, [...labHoles([26.5, 28.8]), { t0: 30.35, t1: 32.25, y0: 0, y1: 3.4 }], {}, 0.02);
  add('sofa-grey', def('Sofa', 2.1, 0.85, 0.78, [
    rbox(0, 0.33, 0.04, 2.1, 0.3, 0.78, '#c9c7c3', 0.08),
    rbox(0, 0.5, 0.08, 1.9, 0.1, 0.62, '#d2d0cc', 0.04),
    rbox(0, 0.62, -0.32, 2.1, 0.42, 0.2, '#c9c7c3', 0.08),
    rbox(-0.98, 0.55, 0.04, 0.16, 0.32, 0.78, '#c9c7c3', 0.07),
    rbox(0.98, 0.55, 0.04, 0.16, 0.32, 0.78, '#c9c7c3', 0.07),
    ...[-0.9, 0.9].flatMap((x) => [-0.3, 0.3].map((z) => cyl(x, 0.09, z, 0.02, 0.18, '#6b4a33', { r2: 0.012 }))),
  ]));
  add('ottoman', def('Ottoman', 0.45, 0.45, 0.45, [rbox(0, 0.225, 0, 0.45, 0.45, 0.45, '#9da53b', 0.03)]));
  add('c-table', def('Side table', 0.45, 0.35, 0.62, [
    box(0, 0.6, 0, 0.45, 0.025, 0.35, '#c79b6a'),
    box(0.21, 0.31, 0, 0.025, 0.6, 0.35, '#c79b6a'),
    box(0, 0.015, 0, 0.45, 0.025, 0.35, '#c79b6a'),
  ]));
  add('planter', def('Planter', 1.0, 0.4, 1.6, [
    box(0, 0.3, 0, 1.0, 0.6, 0.4, '#1f1f1f', { rough: 0.6 }),
    cone(-0.25, 1.05, 0, 0.3, 0.9, '#3e6e3a'),
    cone(0.22, 1.12, 0.02, 0.28, 1.02, '#4a7c42'),
  ]));
  add('rug-pale', def('Rug', 3.4, 2.6, 0.02, [box(0, 0.016, 0, 3.4, 0.012, 2.6, '#d6d2c8')]));
  put('rug-pale', 39.4, 24.2);
  put('sofa-grey', 39.4, 22.95);
  put('sofa-grey', 39.4, 25.45, 180);
  put('ottoman', 39.1, 24.2);
  put('ottoman', 39.65, 24.2);
  put('c-table', 40.5, 24.2, 90);
  put('sofa-grey', 40.65, 28.6, 90);
  onWall('planter', 'w', 41.5, 21.9, 0.25);
  onWall('planter', 'w', 41.5, 26.5, 0.25);

  add('copier', def('Printer', 0.6, 0.65, 1.2, [box(0, 0.55, 0, 0.6, 1.1, 0.65, '#2a2a2a'), box(0, 1.15, -0.05, 0.6, 0.1, 0.5, '#3a3a3a')]));
  add('laptop-kiosk', def('Laptop kiosk', 0.9, 0.5, 1.8, [
    box(0, 0.9, 0, 0.9, 1.8, 0.5, '#9a9da0'),
    box(0, 1.1, 0.26, 0.8, 0.9, 0.02, '#f2f2f2'),
    box(0, 1.7, 0.26, 0.9, 0.12, 0.02, '#c8222b'),
  ]));
  onWall('copier', 'e', 32.5, 10.6, 0.34, { label: 'PAW printer' });
  onWall('laptop-kiosk', 'e', 32.5, 12.2, 0.26, { label: 'Laptop kiosk' });
  add('vending', def('Vending machine', 0.95, 0.8, 1.84, [
    box(0, 0.92, 0, 0.95, 1.84, 0.8, '#2a2d33'),
    box(-0.12, 1.05, 0.41, 0.6, 1.3, 0.01, '#d9e6ef', { glow: 0.5 }),
    box(0.36, 1.05, 0.41, 0.18, 1.0, 0.01, '#1a1a1a'),
  ]));
  onWall('vending', 'n', 9, 24.1, 0.41, { label: 'Vending' });
  onWall('vending', 'n', 9, 25.15, 0.41);

  // ----- the private business area (coworking) -----

  for (const [k, y] of WEST_COWORK.entries()) {
    const key = `teal-bay-${k}`;
    paint(key, 'Teal wall', TEAL_WALL, 'e', 0, y - 3, y + 3, [win(y, 2.12, 0.86, 3.06)], {}, 0.02);
  }
  paint('teal-plain', 'Teal wall', TEAL_WALL, 'e', 0, 24.1, 29.4, [], {}, 0.02);
  add('reveal', def('Window reveal', 2.3, 0.1, 3.1, [
    box(-1.08, 1.96, 0, 0.1, 2.12, 0.06, TURQUOISE),
    box(1.08, 1.96, 0, 0.1, 2.12, 0.06, TURQUOISE),
    box(0, 3.06, 0, 2.26, 0.1, 0.06, TURQUOISE),
    box(0, 0.86, 0.02, 2.26, 0.06, 0.1, TURQUOISE),
  ]));
  for (const y of WEST_COWORK) onWall('reveal', 'e', 0, y, 0.06);
  add('bench-pod', def('Benching pod, four desks', 3.0, 2.9, 1.35, [
    box(0, 0.73, 0, 3.0, 0.03, 1.5, WHITE_TOP, { rough: 0.4 }),
    ...[-1.45, 0, 1.45].map((x) => box(x, 0.36, 0, 0.06, 0.72, 1.3, CHARCOAL)),
    ...[-0.75, 0.75].flatMap((x) => [box(x, 1.12, 0, 1.4, 0.35, 0.35, '#e8e6e1', { rough: 0.5 }), box(x, 0.84, 0, 0.12, 0.22, 0.08, CHARCOAL)]),
    ...[-0.75, 0.75].flatMap((x) => [...taskChair(x, -1.08, 0, SETU_SEAT, SETU_BACK), ...taskChair(x, 1.08, 180, SETU_SEAT, SETU_BACK)]),
  ]));
  for (const y of [9.8, 12.8, 15.8, 18.8]) {
    put('bench-pod', 2.1, y);
    put('bench-pod', 5.2, y);
  }
  put('bench-pod', 2.1, 22.8);

  add('office', officeDef(3.3, 4.0));
  for (const y of [5.95, 9.35, 12.75, 16.15]) put('office', 10.5, y, 90);
  for (const y of [9.8, 13.1, 16.4, 19.7]) put('office', 14.5, y, 270);
  for (const y of [15.3, 18.6]) put('office', 20.4, y, 90);
  put('office', 2.1, 26.4, 270);
  put('office', 15.8, 27.4, 180);
  add('glass-room', def('Meeting room', 3.3, 4.0, 3.2, [
    box(0, 1.6, -1.95, 3.3, 3.2, 0.1, DRYWALL),
    box(0, 1.6, -1.89, 3.1, 3.1, 0.02, '#7db928'),
    box(-1.6, 1.6, 0, 0.1, 3.2, 4.0, DRYWALL),
    box(0.4, 1.6, 1.97, 2.4, 3.1, 0.02, GLASS_IN, { opacity: 0.3, rough: 0.1 }),
    box(0.4, 1.35, 1.98, 2.4, 0.9, 0.015, FROST, { opacity: 0.75, rough: 0.4 }),
    box(1.62, 1.6, 0, 0.02, 3.1, 3.9, GLASS_IN, { opacity: 0.3, rough: 0.1 }),
    box(1.63, 1.35, 0, 0.015, 0.9, 3.9, FROST, { opacity: 0.75, rough: 0.4 }),
    box(-1.15, 1.35, 1.97, 0.9, 2.7, 0.05, WOOD_DOOR, { rough: 0.5 }),
    box(0, 3.17, 1.97, 3.3, 0.06, 0.07, BLACK),
    box(1.62, 3.17, 0, 0.07, 0.06, 4.0, BLACK),
    box(1.62, 1.6, 1.97, 0.08, 3.2, 0.08, BLACK),
    box(-0.68, 1.6, 1.97, 0.06, 3.2, 0.07, BLACK),
    box(1.62, 1.6, -0.6, 0.06, 3.2, 0.06, BLACK),
    box(0.4, 1.8, 1.98, 2.4, 0.04, 0.04, BLACK),
    box(1.63, 1.8, 0, 0.04, 0.04, 3.9, BLACK),
    box(0, 0.016, 0, 3.1, 0.012, 3.8, '#6e6a65'),
    box(0.1, 0.74, -0.3, 1.0, 0.04, 2.0, WHITE_TOP),
    box(0.1, 0.36, -0.3, 0.1, 0.72, 1.4, CHARCOAL),
    ...[-0.95, 0.35].flatMap((z) => [...shellChair(-0.65, z, 90, '#3a3a3a').slice(0, 2), ...shellChair(0.85, z, 270, '#3a3a3a').slice(0, 2)]),
  ]));
  put('glass-room', 10.5, 19.55, 90);

  {
    // The Hive: ten sit-to-stand desks in a glass enclosure, frosted low and middle, on grey carpet.
    const parts: Part[] = [
      box(0, 0.016, 0, 7.3, 0.012, 7.1, '#8a8a8a'),
      box(0, 1.5, 3.58, 7.4, 2.95, 0.02, GLASS_IN, { opacity: 0.25, rough: 0.1 }),
      box(0.95, 1.5, -3.58, 5.5, 2.95, 0.02, GLASS_IN, { opacity: 0.25, rough: 0.1 }),
      box(-3.68, 1.5, 0, 0.02, 2.95, 7.1, GLASS_IN, { opacity: 0.25, rough: 0.1 }),
      box(3.68, 1.5, 0, 0.02, 2.95, 7.1, GLASS_IN, { opacity: 0.25, rough: 0.1 }),
      box(0, 1.1, 3.59, 7.4, 1.6, 0.015, FROST, { opacity: 0.7, rough: 0.4 }),
      box(0.95, 1.1, -3.59, 5.5, 1.6, 0.015, FROST, { opacity: 0.7, rough: 0.4 }),
      box(-3.69, 1.1, 0, 0.015, 1.6, 7.1, FROST, { opacity: 0.7, rough: 0.4 }),
      box(3.69, 1.1, 0, 0.015, 1.6, 7.1, FROST, { opacity: 0.7, rough: 0.4 }),
      box(-2.65, 1.35, -3.58, 0.95, 2.7, 0.05, WOOD_DOOR, { rough: 0.5 }),
      box(0, 2.98, 3.58, 7.4, 0.06, 0.06, BLACK),
      box(0, 2.98, -3.58, 7.4, 0.06, 0.06, BLACK),
      box(-3.68, 2.98, 0, 0.06, 0.06, 7.2, BLACK),
      box(3.68, 2.98, 0, 0.06, 0.06, 7.2, BLACK),
      ...[-1.85, 0, 1.85].flatMap((t) => [
        box(t, 1.5, 3.58, 0.05, 2.95, 0.06, BLACK),
        box(t, 1.5, -3.58, 0.05, 2.95, 0.06, BLACK),
        box(-3.68, 1.5, t, 0.06, 2.95, 0.05, BLACK),
        box(3.68, 1.5, t, 0.06, 2.95, 0.05, BLACK),
      ]),
    ];
    const desk = (x: number, z: number, facing: 0 | 180): Part[] => {
      const s = facing === 0 ? 1 : -1;
      return [
        box(x, 0.73, z, 1.6, 0.04, 0.7, WHITE_TOP, { rough: 0.4 }),
        box(x, 0.36, z - s * 0.3, 1.5, 0.7, 0.04, '#222222'),
        ...shellChair(x, z + s * 0.62, facing === 0 ? 180 : 0, '#2a2a2a').slice(0, 2),
      ];
    };
    for (const x of [-2.6, -0.9, 0.8, 2.5]) parts.push(...desk(x, 3.05, 180));
    for (const x of [-0.9, 0.8, 2.5]) parts.push(...desk(x, -3.05, 0));
    for (const x of [-0.9, 0.8, 2.5]) parts.push(...desk(x, 0.2, 0));
    add('hive', def('The Hive', 7.4, 7.2, 3.0, parts));
  }
  put('hive', 10.2, 25.7, 0, { label: 'The Hive' });

  add('cubicle', def('Dedicated desk', 1.8, 1.8, 1.25, [
    box(0, 0.62, -0.87, 1.8, 1.24, 0.05, '#b9afa4'),
    box(-0.87, 0.62, 0, 0.05, 1.24, 1.8, '#b9afa4'),
    box(0, 0.98, -0.83, 1.0, 0.5, 0.02, '#1e7d92'),
    box(0.05, 0.73, -0.45, 1.7, 0.04, 0.8, WHITE_TOP),
    box(0.6, 0.3, -0.5, 0.4, 0.6, 0.6, '#b9afa4'),
    ...shellChair(0.05, 0.25, 180, '#3a3a3a').slice(0, 2),
  ]));
  put('cubicle', 1.4, 5.95);
  put('cubicle', 3.4, 5.95);
  put('cubicle', 5.4, 5.95);
  add('mail', def('Mail sorter', 1.2, 0.5, 1.8, [
    box(0, 0.45, 0, 1.2, 0.9, 0.5, '#6c6c6c'),
    box(0, 1.35, -0.05, 1.2, 0.9, 0.4, '#d8d0c0'),
    ...[1.1, 1.4, 1.6].map((y) => box(0, y, 0.16, 1.2, 0.015, 0.01, '#a89f90')),
    ...[-0.3, 0, 0.3].map((x) => box(x, 1.35, 0.16, 0.015, 0.9, 0.01, '#a89f90')),
  ]));
  onWall('mail', 's', 4, 7.2, 0.25);
  add('cowork-reception', def('Front desk', 3.0, 1.6, 1.15, [
    box(-0.4, 0.55, 0.45, 2.2, 1.1, 0.12, '#4a2e22', { rough: 0.5 }),
    box(-0.4, 1.1, 0.35, 2.25, 0.04, 0.4, '#4a2e22'),
    box(-0.4, 0.74, -0.05, 2.1, 0.04, 0.7, '#e4e2dc'),
    box(1.1, 0.74, -0.35, 0.8, 0.04, 1.4, '#e4e2dc'),
    box(1.1, 0.36, -0.35, 0.75, 0.72, 1.3, '#e8e8e6'),
    box(-0.8, 1.0, -0.15, 0.55, 0.34, 0.03, '#1a1a1a'),
    box(0, 1.0, -0.15, 0.55, 0.34, 0.03, '#1a1a1a'),
    ...taskChair(-0.4, -0.6, 180, '#3a3a3a', '#333333').slice(0, 2),
  ]));
  put('cowork-reception', 19.6, 25.6, 0, { label: 'Front desk' });
  paint('blue-wall', 'Blue wall', '#1a72c8', 's', 24.5, 15.6, 22.4, [], {}, 0.02);
  put('pendants-white', 2.1, 14.3, 90);
  put('pendants-white', 5.2, 14.3, 90);
  put('pendants-white', 7.6, 14.3, 90);

  add('phone-booth', def('Phone booth', 1.8, 1.8, 2.5, [
    box(0, 1.25, -0.87, 1.8, 2.5, 0.06, DRYWALL),
    box(-0.87, 1.25, 0, 0.06, 2.5, 1.8, DRYWALL),
    box(0.87, 1.25, 0, 0.06, 2.5, 1.8, DRYWALL),
    box(0, 2.48, 0, 1.8, 0.04, 1.8, '#f2f2f0'),
    box(0, 1.25, 0.88, 1.74, 2.45, 0.02, GLASS_IN, { opacity: 0.3, rough: 0.1 }),
    box(0, 1.35, 0.89, 1.74, 0.9, 0.015, FROST, { opacity: 0.75, rough: 0.4 }),
    box(0, 2.45, 0.88, 1.8, 0.06, 0.06, BLACK),
    box(0.2, 1.25, 0.88, 0.05, 2.5, 0.06, BLACK),
    rbox(0, 0.25, -0.5, 0.8, 0.5, 0.6, '#5e6b7a', 0.06),
    cyl(0.5, 0.3, 0.35, 0.2, 0.6, '#f2f2f0'),
  ]));
  for (const x of [6.5, 8.4, 10.3, 12.2, 14.1, 21.4]) put('phone-booth', x, FACE + 0.9);

  // ----- the rooms you book -----

  add('boat-6', meetingDef('Boat table, six chairs', 2.4, 1.1, 2, true, WALNUT, 'setu'));
  add('table-212', meetingDef('Conference table, ten chairs', 4.2, 1.1, 5, false, WALNUT, 'bucket'));
  add('table-302', meetingDef('Conference table, twelve chairs', 4.8, 1.2, 5, true, '#7a5c44', 'bucket'));
  const tv = (w: number) => def('TV', w, 0.08, 2.2, [box(0, 1.55, 0, w, w * 0.57, 0.05, '#151515', { rough: 0.3 }), box(0, 1.55, 0.027, w - 0.05, w * 0.57 - 0.05, 0.004, '#1f262d', { rough: 0.15 })]);
  add('tv-55', tv(1.22));
  add('tv-65', tv(1.44));
  add('tv-85', tv(1.88));
  add('whiteboard', def('Whiteboard', 1.8, 0.04, 2.1, [box(0, 1.5, 0, 1.8, 1.2, 0.02, '#f8f8f6', { rough: 0.2 }), box(0, 0.88, 0.03, 1.8, 0.03, 0.06, '#b0b0b0')]));
  add('glass-boards', def('Glass whiteboards', 6.2, 0.04, 2.1, [-2.3, -0.77, 0.77, 2.3].map((x) => box(x, 1.5, 0, 1.4, 1.2, 0.015, '#f2f6f5', { rough: 0.1 }))));

  // 203: a brick end wall with the TV on it.
  paint('brick-203', 'Exposed brick', '#a24b2e', 'e', 22.5, 9.1, 12.9, [], brickE, 0.02);
  put('boat-6', 25.6, 11);
  onWall('tv-55', 'e', 22.5, 11, 0.05);
  onWall('whiteboard', 'n', 13, 25.6, 0.03);
  // 311: orange end wall, brick long wall.
  paint('orange-311', 'Orange wall', '#e27a1e', 's', 8, 18.6, 22.4, [], {}, 0.02);
  paint('brick-311', 'Exposed brick', '#9c4a2f', 'w', 22.5, 8.1, 13.4, [], brickE, 0.02);
  put('boat-6', 20.5, 10.9, 90);
  onWall('tv-55', 's', 8, 20.5, 0.05);
  onWall('whiteboard', 'e', 18.5, 11.6, 0.03);
  // 208: twelve 6 ft tables facing a big screen.
  add('train-mesh', trainingDef(MESH, MESH, FRAME_GREY));
  for (const x of [37, 39.3, 41.6, 43.9]) for (const y of [2.3, 4.5, 6.7]) put('train-mesh', x, y, 270);
  onWall('tv-85', 'w', 47, 4.5, 0.05);
  for (const x of [37.4, 39.6, 41.8]) onWall('whiteboard', 's', 0, x, 0.03);
  for (const x of [39.6, 44.2]) onWall('whiteboard', 'n', 9, x, 0.03);
  add('carpet-208', def('Carpet', 6.15, 8, 0.025, [
    box(0, 0.016, 0, 6.15, 0.012, 8, '#6c6a68'),
    ...[-2.4, 0.4, 2.8].map((z) => box(0.5, 0.0225, z, 4.0, 0.002, 0.25, '#a8b54a')),
    ...[-1.2, 1.6].map((z) => box(-0.6, 0.0225, z, 3.0, 0.002, 0.25, '#3a3836')),
  ]));
  put('carpet-208', 37.675, 4.5);
  put('carpet-208', 43.825, 4.5, 180);
  // 212: two walnut tables end to end, ten bucket chairs, glass boards on the long wall.
  put('table-212', 44.35, 13.5, 90);
  onWall('tv-65', 's', 9, 44.25, 0.05);
  onWall('glass-boards', 'w', 47, 13.5, 0.03);
  add('cart', def('Cart', 0.8, 0.5, 0.95, [
    box(0, 0.9, 0, 0.8, 0.03, 0.5, '#1a98a8'),
    box(0, 0.5, 0, 0.8, 0.03, 0.5, '#1a98a8'),
    box(0, 0.15, 0, 0.8, 0.03, 0.5, '#1a98a8'),
    ...[-0.38, 0.38].map((x) => box(x, 0.5, 0, 0.03, 0.85, 0.48, '#1a98a8')),
  ]));
  put('cart', 46.3, 17.2, 90);
  // 302: a blue long wall with glass boards, twelve chairs, ten canvases.
  paint('blue-302', 'Blue wall', '#1a86d6', 'w', 20, 29.6, 36.9, [{ t0: 30.05, t1: 30.95, y0: 0, y1: 2.15 }], {}, 0.02);
  put('table-302', 17, 33.4, 90);
  onWall('glass-boards', 'w', 20, 34, 0.03);
  onWall('tv-65', 'n', 37, 17, 0.05);
  add('canvases', def('Canvases', 3.2, 0.05, 2.4, [0, 1, 2, 3, 4].flatMap((k) =>
    [1.25, 1.95].map((y, r) => box(-1.3 + k * 0.65, y, 0, 0.5, 0.5, 0.04, ['#e8792a', '#2f7fbf', '#c8222b', '#f3b21a', '#5aa36a', '#7a2a6c', '#e0207a', '#1ba3ae', '#f0ece4', '#3a3a3a'][(k * 2 + r) % 10])),
  )));
  onWall('canvases', 'e', 14, 33.4, 0.03);
  // Student rooms: a table for four, a blue wall with a TV; glass fronts onto the corridor.
  add('study-4', def('Table for four', 1.8, 2.3, 1.0, [
    box(0, 0.74, 0, 1.8, 0.03, 0.9, '#f0f0ee'),
    box(-0.8, 0.36, 0, 0.05, 0.72, 0.7, '#9a9a9a'),
    box(0.8, 0.36, 0, 0.05, 0.72, 0.7, '#9a9a9a'),
    ...[-0.45, 0.45].flatMap((x) => [...shellChair(x, -0.75, 0, '#6a6a6a').slice(0, 2), ...shellChair(x, 0.75, 180, '#6a6a6a').slice(0, 2)]),
  ]));
  add('blue-tv', def('Blue wall', 3.8, 0.08, WALL_HEIGHT, [box(0, WALL_HEIGHT / 2, 0, 3.8, WALL_HEIGHT, 0.02, '#1f6fd0', { rough: 0.95 }), ...tv(1.22).parts.map((p) => ({ ...p, z: q(p.z + 0.03) }))]));
  for (const x of [24.5, 28.5, 32.5]) {
    put('study-4', x, 2.2);
    onWall('blue-tv', 's', 0, x, 0.02);
  }
  put('study-4', 30.5, 11.3, 90);
  add('glaze-front', glazeDef('Glass front', 2.2, 0.1, 2.9, 0, 3));
  add('glaze-door', glazeDef('Transom', 0.9, 2.1, 2.9, 0, 1));
  for (const [d, w] of STUDENT_FRONTS) {
    put('glaze-door', d, 4, 0);
    put('glaze-front', w, 4, 0);
  }
  put('glaze-door', 29.3, 9, 0);
  put('glaze-front', 31.2, 9, 0);
  put('glaze-front', 34.5, 6.6, 90);
  put('glaze-front', 41.5, 12.0, 90);
  put('glaze-front', 41.5, 14.55, 90);
  put('glaze-door', 41.5, 16.75, 90);

  // 303: a tall hall under oxblood trusses, glazed overhead doors onto the coworking floor, rows facing the screen.
  add('glaze-303-int', glazeDef('Glazed overhead door', 2.4, 0.02, 3.0, 0, 3));
  for (const x of GARAGE_303) put('glaze-303-int', x, 29.5, 0);
  paint('teal-303a', 'Dark teal wall', '#145457', 'w', 14, 29.6, 35, [{ t0: 30.55, t1: 31.45, y0: 0, y1: 2.15 }], {}, 0.02);
  paint('teal-303b', 'Dark teal wall', '#145457', 'w', 14, 35, 40.4, [], {}, 0.02);
  onWall('whiteboard', 'w', 14, 34.2, 0.04);
  onWall('whiteboard', 'w', 14, 36.1, 0.04);
  for (const y of [32, 34, 36, 38]) for (const x of [2.4, 4.3, 8.6, 10.5]) put('train-mesh', x, y);
  add('screen', def('Projection screen', 3.8, 0.15, 4.1, [
    box(0, 2.9, 0, 3.6, 2.0, 0.02, '#d7231f', { glow: 0.25 }),
    box(0, 3.95, 0.03, 3.8, 0.12, 0.12, '#e8e8e8'),
    box(0.25, 3.0, 0.012, 1.5, 0.18, 0.005, '#ffffff', { glow: 0.3 }),
    box(-0.85, 3.0, 0.012, 0.3, 0.5, 0.005, '#ffffff', { glow: 0.3 }),
  ]));
  onWall('screen', 'n', 40.5, 6, 0.07);
  add('podium', def('Podium', 0.6, 0.6, 1.4, [
    cyl(0, 1.1, 0, 0.3, 0.05, '#f2f2f0'),
    cyl(0, 0.55, 0, 0.04, 1.1, '#c0c0c0', { metal: 0.7 }),
    cyl(0, 0.02, 0, 0.25, 0.03, '#c0c0c0', { metal: 0.7 }),
    cyl(0.1, 1.27, 0, 0.008, 0.3, BLACK),
  ]));
  put('podium', 8.6, 39.6);
  add('credenza', def('Credenza', 1.8, 0.45, 1.65, [
    box(0, 0.35, 0, 1.8, 0.7, 0.45, '#8a5a35', { rough: 0.6 }),
    cyl(-0.6, 0.85, 0, 0.13, 0.3, '#22325a'),
    cyl(0.6, 0.85, 0, 0.13, 0.3, '#22325a'),
    cone(-0.6, 1.3, 0, 0.13, 0.7, '#4a6b3a'),
    cone(0.6, 1.3, 0, 0.13, 0.7, '#4a6b3a'),
  ]));
  onWall('credenza', 'n', 40.5, 3.3, 0.23);
  add('partition', def('Rolling partition', 1.6, 0.4, 1.9, [box(0, 0.98, 0, 1.6, 1.8, 0.06, '#5e5f61'), box(0, 0.04, 0, 1.4, 0.06, 0.35, '#333333')]));
  put('partition', 13.2, 37.4, 90);
  put('partition', 13.2, 39.1, 90);
  {
    // An oxblood steel truss spanning the room north–south: pitched top chord, flat bottom chord, webs.
    const color = '#7b3a26';
    const top = (z: number) => 4.9 - (0.65 * Math.abs(z)) / 5.4;
    const parts: Part[] = [
      box(0, 4.2, -2.7, 0.1, 0.1, 5.4, color),
      box(0, 4.2, 2.7, 0.1, 0.1, 5.4, color),
      box(0, 4.575, -2.7, 0.12, 0.12, 5.44, color, { rot: [deg(-6.87), 0, 0] }),
      box(0, 4.575, 2.7, 0.12, 0.12, 5.44, color, { rot: [6.87, 0, 0] }),
    ];
    for (const z of [-4.3, -2.15, 0, 2.15, 4.3]) parts.push(box(0, (4.2 + top(z)) / 2, z, 0.05, top(z) - 4.2, 0.05, color));
    for (const [z0, z1] of [[-4.3, -2.15], [-2.15, 0], [2.15, 0], [4.3, 2.15]] as const) {
      const dy = top(z1) - 4.2;
      const dz = z1 - z0;
      const a = (Math.atan2(dz, dy) * 180) / Math.PI;
      parts.push(box(0, 4.2 + dy / 2, (z0 + z1) / 2, 0.04, Math.hypot(dy, dz), 0.04, color, { rot: [deg(a), 0, 0] }));
    }
    add('truss', def('Steel truss', 0.2, 8, 4.95, parts));
  }
  for (const x of [3.5, 7, 10.5]) put('truss', x, 35);
  floor('floor-303', 'Stained concrete', '#3b3734', 0.1, 29.6, 13.9, 40.4, 0.35);
  {
    // Half of a truss across the coworking floor, low at the outside wall, rising to the middle.
    const len = 9.1;
    const color = '#7b3a26';
    const [lo, hi, bottom] = [4.45, 4.95, 4.2];
    const top = (z: number) => lo + ((hi - lo) * (z + len / 2)) / len;
    const slope = (Math.atan2(hi - lo, len) * 180) / Math.PI;
    const parts: Part[] = [];
    for (const sgn of [-1, 1]) {
      const zc = (sgn * len) / 4;
      parts.push(box(0, bottom, zc, 0.1, 0.1, len / 2, color));
      parts.push(box(0, top(zc), zc, 0.12, 0.12, len / 2 + 0.02, color, { rot: [deg(-slope), 0, 0] }));
    }
    const zs = [-len / 2 + 0.15, -len / 6, len / 6, len / 2 - 0.08];
    for (const z of zs) parts.push(box(0, (bottom + top(z)) / 2, z, 0.05, top(z) - bottom, 0.05, color));
    for (let k = 0; k + 1 < zs.length; k++) {
      const dy = top(zs[k + 1]) - bottom;
      const dz = zs[k + 1] - zs[k];
      parts.push(box(0, bottom + dy / 2, (zs[k] + zs[k + 1]) / 2, 0.04, Math.hypot(dy, dz), 0.04, color, { rot: [deg((Math.atan2(dz, dy) * 180) / Math.PI), 0, 0] }));
    }
    add('truss-half', def('Steel truss', 0.2, 8, 4.95, parts));
  }
  for (const y of [9.6, 13.6, 17.6]) {
    put('truss-half', 4.65, y, 270);
    put('truss-half', 13.85, y, 90);
  }

  // Carpet in the rooms you book.
  carpet('carpet-203', '#55524e', 22.6, 9.1, 28.4, 12.9);
  carpet('carpet-311', '#55524e', 18.6, 8.1, 22.4, 13.4);
  carpet('carpet-212', '#6e6a65', 41.6, 9.1, 46.9, 17.9);
  carpet('carpet-302', '#5e6f7c', 14.1, 29.6, 19.9, 36.9);
  carpet('carpet-sr', '#6e6a65', 22.6, 0.1, 26.4, 3.9);
  for (const x of [26.6, 30.6]) put('carpet-sr', x + 1.9, 2.0);
  carpet('carpet-sr1', '#6e6a65', 28.6, 9.1, 32.4, 13.4);
  for (const y of [32.4, 35.4, 38.4]) {
    put('pendants-white', 3.6, y);
    put('pendants-white', 10.4, y);
  }

  return { defs, placed };
}

// ---------- what the rectangles cannot say ----------

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const lengthOf = (w: Wall): number => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);

/** How far along `w` the point nearest `p` is, and how far off the wall `p` lies. */
function along(w: Wall, p: Point): { offset: number; off: number } {
  const len = lengthOf(w) || 1;
  const ux = (w.b.x - w.a.x) / len;
  const uy = (w.b.y - w.a.y) / len;
  const offset = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy;
  return { offset, off: Math.abs((p.x - w.a.x) * -uy + (p.y - w.a.y) * ux) };
}

const pointAt = (w: Wall, offset: number): Point => {
  const len = lengthOf(w) || 1;
  return { x: w.a.x + ((w.b.x - w.a.x) * offset) / len, y: w.a.y + ((w.b.y - w.a.y) * offset) / len };
};

/**
 * Join straight runs the generator left in pieces (it splits a wall wherever a
 * room rectangle ends, even where no wall meets it), so an opening can sit
 * anywhere along a real wall. Openings keep their place.
 */
function joinRuns(walls: Wall[], openings: Opening[]): { walls: Wall[]; openings: Opening[] } {
  let ws = walls.slice();
  let os = openings.slice();
  const key = (p: Point) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  for (let guard = 0; guard < 1000; guard++) {
    const count = new Map<string, number>();
    for (const w of ws) for (const p of [w.a, w.b]) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
    let joined = false;
    for (let i = 0; i < ws.length && !joined; i++) {
      for (let j = i + 1; j < ws.length && !joined; j++) {
        const [p, s] = [ws[i], ws[j]];
        const pair = ([['a', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'b']] as const).find(([u, v]) => key(p[u]) === key(s[v]));
        if (!pair) continue;
        const [u, v] = pair;
        const mid = p[u];
        if (count.get(key(mid)) !== 2) continue;
        const far1 = p[u === 'a' ? 'b' : 'a'];
        const far2 = s[v === 'a' ? 'b' : 'a'];
        const cross = (far1.x - mid.x) * (far2.y - mid.y) - (far1.y - mid.y) * (far2.x - mid.x);
        const dot = (far1.x - mid.x) * (far2.x - mid.x) + (far1.y - mid.y) * (far2.y - mid.y);
        if (Math.abs(cross) > 1e-6 || dot >= 0) continue;
        const merged: Wall = { id: p.id, a: far1, b: far2 };
        os = os.map((o) => {
          if (o.wallId !== p.id && o.wallId !== s.id) return o;
          const c = pointAt(o.wallId === p.id ? p : s, o.offset);
          return { ...o, wallId: merged.id, offset: r3(along(merged, c).offset) };
        });
        ws = [...ws.filter((w) => w !== p && w !== s), merged];
        joined = true;
      }
    }
    if (!joined) break;
  }
  return { walls: ws, openings: os };
}

let furnished: ReturnType<typeof furnish> | null = null;

const finish: TemplateFinish = (plan, { rooms: placed, newId }) => {
  const origin = placed.get(PRIVATE);
  if (!origin) return plan;
  // The layout was re-centred: where a diagram point ended up.
  const dx = origin.x - 0;
  const dy = origin.y - 8;
  const at = (x: number, y: number): Point => ({ x: r3(x + dx), y: r3(y + dy) });

  const joined = joinRuns(
    plan.walls,
    plan.openings.filter((o) => o.type === 'door' && o.label !== 'Entrance'),
  );
  const walls = joined.walls;
  let openings = joined.openings;
  // The brick wall behind the coffee bar: it stops short of the lab corridor, which runs on into the commons.
  walls.push({ id: newId(), a: at(26.5, 34), b: at(41.5, 34) });
  // The south-east block's corner pier, out at the front of the porch.
  walls.push({ id: newId(), a: at(53.5, 44), b: at(53.5, 47) });

  const wallAt = (p: Point): Wall | undefined =>
    walls.find((w) => {
      const { offset, off } = along(w, p);
      return off < 0.05 && offset > 0.05 && offset < lengthOf(w) - 0.05;
    });
  /** An opening centred on a point of a wall, replacing whatever was in its way. */
  const set = (type: 'door' | 'window', x: number, y: number, width: number, label?: string): void => {
    const p = at(x, y);
    const wall = wallAt(p);
    if (!wall) return;
    const offset = Math.min(lengthOf(wall) - width / 2 - 0.1, Math.max(width / 2 + 0.1, along(wall, p).offset));
    openings = openings.filter((o) => o.wallId !== wall.id || Math.abs(o.offset - offset) >= (o.width + width) / 2 + 0.25);
    openings.push({ id: newId(), wallId: wall.id, type, offset: r3(offset), width, ...(label ? { label } : {}) });
  };

  // Ways in from outside.
  set('door', 28.6, 44, 1.8, 'Front entrance');
  set('door', 10.8, 47, 1.8);
  set('door', 17.5, 0, 1.8);
  set('door', 41.5, LAB_PATIO_DOOR, 1.8);
  set('door', 43, 34, 0.9);
  set('door', 45.6, 18, 0.9);
  // Doors the photographs place.
  set('door', 41.5, 40, 1.6);
  set('door', 22.5, 35.7, 0.9);
  set('door', 22.5, 20.5, 0.9);
  set('door', 36.2, 9, 1.8);
  set('door', 41.5, 16.75, 0.9);
  set('door', 27.6, 9, 0.9);
  set('door', 12.6, 29.5, 0.9);
  set('door', 14, 31, 0.9);
  set('door', 20, 30.5, 0.9);
  set('door', 15, 24.5, 0.9);
  for (const [d] of STUDENT_FRONTS) set('door', d, 4, 0.9);
  set('door', 29.3, 9, 0.9);

  // Windows: the bays of the photographs, not two to a room.
  set('window', 24.3, 44, 1.4);
  for (const x of COMMONS_GARAGE) set('window', x, 44, 2.6);
  for (const x of SE_FRONT) set('window', x, 44, 2.4);
  set('window', 53.5, 39.6, 2.3);
  set('window', 46.5, 34, 1.4);
  for (const y of LAB_EAST) set('window', 41.5, y, 1.6);
  set('window', 43.3, 18, 1.8);
  for (const x of [2.8, 6.2]) set('window', x, 47, 1.8);
  set('window', 0, 43.8, 1.2);
  for (const y of WEST_COWORK) set('window', 0, y, 2.0);
  for (const y of WEST_303) set('window', 0, y, 1.3);
  set('window', 2.7, 0, 1.8);
  set('window', 47, 2.2, 1.8);
  // Glass inside: 303's overhead doors, the student rooms' fronts, the corner of 208, the front of 212.
  for (const x of GARAGE_303) set('window', x, 29.5, 2.4);
  for (const [, w] of STUDENT_FRONTS) set('window', w, 4, 2.2);
  set('window', 31.2, 9, 2.2);
  set('window', 34.5, 6.6, 2.2);
  set('window', 41.5, 12, 2.2);
  set('window', 41.5, 14.55, 2.2);

  // Names: the spaces drawn as several rectangles are one room each.
  const roomNames: Record<string, string> = {};
  const detected = detectRooms(walls);
  const named: [Point, string][] = [];
  for (const r of placed.values()) named.push([{ x: r.x + r.w / 2, y: r.y + r.h / 2 }, r.name]);
  const whole: Record<string, string> = {
    [LAB]: 'Innovation Lab & Social Commons',
    [PRIVATE]: PRIVATE,
    'Phone rooms': 'Phone rooms',
  };
  for (const room of detected) {
    const inside = named.filter(([p]) => pointInPolygon(p, room.polygon)).map(([, name]) => name);
    if (inside.length === 0) continue;
    const lead = Object.keys(whole).find((k) => inside.includes(k));
    roomNames[room.key] = lead ? whole[lead] : inside[0];
  }

  // The Hub's own furniture.
  furnished ??= furnish();
  const customItems: Record<string, CustomItem> = {};
  const furniture: Furniture[] = plan.furniture.slice();
  for (const p of furnished.placed) {
    // Stable ids, so a plan that copies the Hub in (a whole campus) keeps the same definitions.
    const id = `hub-${p.key}`;
    const d = furnished.defs[p.key];
    // Each plan gets its own copy of the parts: nothing is shared between plans built from the template.
    customItems[id] ??= { ...d, parts: d.parts.map((part) => ({ ...part, ...(part.rot ? { rot: [...part.rot] as [number, number, number] } : {}) })), id, createdAt: 0 };
    const pos = at(p.x, p.y);
    furniture.push({
      id: newId(),
      kind: `custom:${id}`,
      x: pos.x,
      y: pos.y,
      rotation: r3((p.rot * Math.PI) / 180),
      rest: p.rest ?? 'floor',
      ...(p.label ? { label: p.label } : {}),
    });
  }

  return {
    ...plan,
    walls,
    openings,
    roomNames,
    furniture,
    customItems: { ...plan.customItems, ...customItems },
    settings: { ...plan.settings, wallHeight: WALL_HEIGHT, wallThickness: WALL_THICKNESS },
    // Brick outside, dark steel trim, a flat roof hidden behind the parapets.
    look: { style: 'industrial', roof: 'flat' },
  };
};

export const HURT_HUB: Template = {
  id: 'hurt-hub',
  name: 'Hurt Hub',
  note: 'Davidson’s innovation hub',
  layout: { rooms, links },
  items,
  finish,
};
