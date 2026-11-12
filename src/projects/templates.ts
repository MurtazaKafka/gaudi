/**
 * Starter plans. Each is authored the way the generator thinks — room
 * rectangles and the connections between them (generate/layout.ts) — plus a
 * few pieces of furniture placed relative to the room they belong to.
 *
 * Pure: no store, no DOM. `buildTemplate` returns a complete PlanData.
 */
import { FURNITURE, type BuiltinKind } from '../catalog';
import { layoutToPlan, normalizeLayout, OUTSIDE, type Layout, type LayoutRoom } from '../generate/layout';
import type { Furniture, PlanData, Units } from '../types';

type Side = 'n' | 'e' | 's' | 'w';

/**
 * One piece of furniture, in meters from its room's north-west corner.
 *  - against a wall: `{ wall, at }` — back to that wall, centered `at` meters
 *    along it (from the west end of n/s walls, the north end of e/w walls);
 *  - free-standing:  `{ x, y, rot }` — center, and clockwise degrees (0 = facing south).
 */
export type TemplateItem = { room: string; kind: BuiltinKind; label?: string } & (
  | { wall: Side; at: number }
  | { x: number; y: number; rot?: number }
);

export interface Template {
  id: string;
  name: string;
  /** A few words for the tile. */
  note: string;
  layout: Layout;
  items: TemplateItem[];
}

/** Clear distance kept between a wall's centerline and furniture set against it. */
const WALL_GAP = 0.1;
const SIDE_ROT: Record<Side, number> = { n: 0, e: 90, s: 180, w: 270 };

const door = (a: string, b: string) => ({ a, b, kind: 'door' as const });
const open = (a: string, b: string) => ({ a, b, kind: 'open' as const });
const entrance = (a: string) => ({ a, b: OUTSIDE, kind: 'door' as const });

/** A kitchen run along one wall, starting `from` meters along it. */
function kitchenRun(room: string, wall: Side, from: number, kinds: BuiltinKind[]): TemplateItem[] {
  let at = from;
  return kinds.map((kind) => {
    const w = FURNITURE[kind].w;
    const item: TemplateItem = { room, kind, wall, at: at + w / 2 };
    at += w;
    return item;
  });
}

/** Bed with its head to `wall`, a nightstand on each side that fits. */
function bed(room: string, wall: Side, at: number, kind: 'bed_double' | 'bed_single', stands: 1 | 2 = 2): TemplateItem[] {
  const half = FURNITURE[kind].w / 2 + FURNITURE.nightstand.w / 2 + 0.05;
  const out: TemplateItem[] = [{ room, kind, wall, at }, { room, kind: 'nightstand', wall, at: at - half }];
  if (stands === 2) out.push({ room, kind: 'nightstand', wall, at: at + half });
  return out;
}

/** A table (long side north–south) with chairs down both long sides. */
function diningSet(room: string, x: number, y: number, chairsPerSide: 1 | 2): TemplateItem[] {
  const out: TemplateItem[] = [{ room, kind: 'dining_table', x, y, rot: 90 }];
  const ys = chairsPerSide === 1 ? [y] : [y - 0.4, y + 0.4];
  for (const cy of ys) {
    out.push({ room, kind: 'chair', x: x - 0.8, y: cy, rot: 270 });
    out.push({ room, kind: 'chair', x: x + 0.8, y: cy, rot: 90 });
  }
  return out;
}

/** An event table (long side east–west) with two chairs on each long side. */
function eventTable(room: string, x: number, y: number, label: string): TemplateItem[] {
  const out: TemplateItem[] = [{ room, kind: 'event_table', x, y, rot: 0, label }];
  for (const dx of [-0.45, 0.45]) {
    out.push({ room, kind: 'chair', x: x + dx, y: y - 0.7, rot: 0 });
    out.push({ room, kind: 'chair', x: x + dx, y: y + 0.7, rot: 180 });
  }
  return out;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: 'studio',
    name: 'Studio',
    note: 'One room, kitchen, bath',
    layout: {
      rooms: [
        { name: 'Studio', type: 'living', x: 0, y: 0, w: 4.5, h: 5.5 },
        { name: 'Kitchen', type: 'kitchen', x: 4.5, y: 0, w: 2.5, h: 3 },
        { name: 'Bathroom', type: 'bathroom', x: 4.5, y: 3, w: 2.5, h: 2.5 },
      ],
      links: [open('Studio', 'Kitchen'), door('Studio', 'Bathroom'), entrance('Studio')],
    },
    items: [
      { room: 'Studio', kind: 'bed_double', wall: 's', at: 1.0 },
      { room: 'Studio', kind: 'nightstand', wall: 's', at: 2.1 },
      { room: 'Studio', kind: 'wardrobe', wall: 's', at: 3.6 },
      { room: 'Studio', kind: 'sofa', wall: 'n', at: 1.7 },
      { room: 'Studio', kind: 'rug', x: 1.7, y: 1.8 },
      { room: 'Studio', kind: 'coffee_table', x: 1.7, y: 1.7 },
      { room: 'Studio', kind: 'plant', x: 0.4, y: 0.4 },
      { room: 'Kitchen', kind: 'kitchen_sink', wall: 'n', at: 0.9 },
      ...kitchenRun('Kitchen', 'e', 0.15, ['fridge', 'stove', 'counter']),
      { room: 'Bathroom', kind: 'toilet', wall: 'e', at: 0.6 },
      { room: 'Bathroom', kind: 'bathroom_sink', wall: 'e', at: 1.35 },
      { room: 'Bathroom', kind: 'bathtub', x: 0.95, y: 2.0, rot: 90 },
    ],
  },
  {
    id: 'one-bed',
    name: 'One-bed flat',
    note: 'Open living and kitchen',
    layout: {
      rooms: [
        { name: 'Living', type: 'living', x: 0, y: 0, w: 5, h: 4 },
        { name: 'Kitchen', type: 'kitchen', x: 5, y: 0, w: 2.5, h: 4 },
        { name: 'Bedroom', type: 'bedroom', x: 0, y: 4, w: 3.5, h: 3.5 },
        { name: 'Hall', type: 'hall', x: 3.5, y: 4, w: 1.5, h: 3.5 },
        { name: 'Bathroom', type: 'bathroom', x: 5, y: 4, w: 2.5, h: 3.5 },
      ],
      links: [
        open('Living', 'Kitchen'),
        door('Hall', 'Living'),
        door('Hall', 'Bedroom'),
        door('Hall', 'Bathroom'),
        entrance('Hall'),
      ],
    },
    items: [
      { room: 'Living', kind: 'sofa', wall: 's', at: 1.6 },
      { room: 'Living', kind: 'tv_stand', wall: 'n', at: 1.6 },
      { room: 'Living', kind: 'rug', x: 1.6, y: 2.3 },
      { room: 'Living', kind: 'coffee_table', x: 1.6, y: 2.4 },
      { room: 'Living', kind: 'armchair', wall: 'w', at: 2.2 },
      { room: 'Living', kind: 'plant', x: 0.4, y: 0.4 },
      ...diningSet('Living', 3.85, 1.7, 1),
      ...kitchenRun('Kitchen', 'e', 0.2, ['fridge', 'counter', 'stove', 'kitchen_sink']),
      ...bed('Bedroom', 'w', 1.75, 'bed_double'),
      { room: 'Bedroom', kind: 'wardrobe', wall: 's', at: 2.6 },
      { room: 'Bathroom', kind: 'toilet', wall: 'e', at: 0.7 },
      { room: 'Bathroom', kind: 'bathroom_sink', wall: 'e', at: 1.6 },
      { room: 'Bathroom', kind: 'bathtub', x: 1.25, y: 2.95, rot: 90 },
    ],
  },
  {
    id: 'two-bed',
    name: 'Two-bed bungalow',
    note: 'Bedrooms off a small hall',
    layout: {
      rooms: [
        { name: 'Living', type: 'living', x: 0, y: 0, w: 6, h: 4.5 },
        { name: 'Kitchen', type: 'kitchen', x: 6, y: 0, w: 4, h: 4.5 },
        { name: 'Bedroom 1', type: 'primary_bedroom', x: 0, y: 4.5, w: 3.5, h: 4 },
        { name: 'Hall', type: 'hall', x: 3.5, y: 4.5, w: 2.5, h: 1.5 },
        { name: 'Bathroom', type: 'bathroom', x: 3.5, y: 6, w: 2.5, h: 2.5 },
        { name: 'Bedroom 2', type: 'bedroom', x: 6, y: 4.5, w: 4, h: 4 },
      ],
      links: [
        open('Living', 'Kitchen'),
        entrance('Living'),
        door('Hall', 'Living'),
        door('Hall', 'Bedroom 1'),
        door('Hall', 'Bedroom 2'),
        door('Hall', 'Bathroom'),
      ],
    },
    items: [
      { room: 'Living', kind: 'sofa', wall: 's', at: 1.8 },
      { room: 'Living', kind: 'tv_stand', wall: 'n', at: 1.4 },
      { room: 'Living', kind: 'rug', x: 1.8, y: 2.5 },
      { room: 'Living', kind: 'coffee_table', x: 1.8, y: 2.6 },
      { room: 'Living', kind: 'armchair', wall: 'w', at: 2.3 },
      ...diningSet('Living', 4.7, 2.2, 2),
      ...kitchenRun('Kitchen', 'e', 0.2, ['fridge', 'counter', 'stove', 'kitchen_sink', 'counter']),
      { room: 'Kitchen', kind: 'plant', x: 0.5, y: 4.1 },
      ...bed('Bedroom 1', 'w', 2.2, 'bed_double'),
      { room: 'Bedroom 1', kind: 'wardrobe', wall: 's', at: 2.7 },
      ...bed('Bedroom 2', 'e', 2.2, 'bed_double', 1),
      { room: 'Bedroom 2', kind: 'desk', wall: 'n', at: 2.4 },
      { room: 'Bedroom 2', kind: 'chair', x: 2.4, y: 1.05, rot: 180 },
      { room: 'Bedroom 2', kind: 'wardrobe', wall: 's', at: 1.0 },
      { room: 'Bathroom', kind: 'toilet', wall: 'e', at: 0.6 },
      { room: 'Bathroom', kind: 'bathroom_sink', wall: 'e', at: 1.35 },
      { room: 'Bathroom', kind: 'bathtub', x: 0.95, y: 2.0, rot: 90 },
    ],
  },
  {
    id: 'family',
    name: 'Three-bed family house',
    note: 'Living, dining, kitchen in a row',
    layout: {
      rooms: [
        { name: 'Living', type: 'living', x: 0, y: 0, w: 5.5, h: 5 },
        { name: 'Dining', type: 'dining', x: 5.5, y: 0, w: 3, h: 5 },
        { name: 'Kitchen', type: 'kitchen', x: 8.5, y: 0, w: 4, h: 5 },
        { name: 'Entry', type: 'entry', x: 0, y: 5, w: 2, h: 1.5 },
        { name: 'Hall', type: 'hall', x: 2, y: 5, w: 8.5, h: 1.5 },
        { name: 'Laundry', type: 'laundry', x: 10.5, y: 5, w: 2, h: 1.5 },
        { name: 'Primary bedroom', type: 'primary_bedroom', x: 0, y: 6.5, w: 4, h: 4 },
        { name: 'Bathroom', type: 'bathroom', x: 4, y: 6.5, w: 2, h: 4 },
        { name: 'Bedroom 2', type: 'bedroom', x: 6, y: 6.5, w: 3, h: 4 },
        { name: 'Bedroom 3', type: 'bedroom', x: 9, y: 6.5, w: 3.5, h: 4 },
      ],
      links: [
        open('Living', 'Dining'),
        open('Dining', 'Kitchen'),
        entrance('Entry'),
        door('Entry', 'Hall'),
        door('Hall', 'Living'),
        door('Hall', 'Laundry'),
        door('Hall', 'Primary bedroom'),
        door('Hall', 'Bathroom'),
        door('Hall', 'Bedroom 2'),
        door('Hall', 'Bedroom 3'),
      ],
    },
    items: [
      { room: 'Living', kind: 'sofa', wall: 'n', at: 3.9 },
      { room: 'Living', kind: 'rug', x: 3.9, y: 2.2 },
      { room: 'Living', kind: 'coffee_table', x: 3.9, y: 2.2 },
      { room: 'Living', kind: 'tv_stand', wall: 's', at: 4.2 },
      { room: 'Living', kind: 'armchair', wall: 'w', at: 2.3 },
      { room: 'Living', kind: 'bookshelf', wall: 's', at: 1.0 },
      { room: 'Living', kind: 'plant', x: 0.4, y: 0.4 },
      ...diningSet('Dining', 1.5, 2.5, 2),
      ...kitchenRun('Kitchen', 'e', 0.2, ['fridge', 'counter', 'stove', 'kitchen_sink', 'counter']),
      ...kitchenRun('Kitchen', 'n', 0.4, ['counter', 'counter']),
      { room: 'Laundry', kind: 'counter', wall: 'e', at: 0.75 },
      ...bed('Primary bedroom', 'w', 2.2, 'bed_double'),
      { room: 'Primary bedroom', kind: 'wardrobe', wall: 's', at: 2.9 },
      { room: 'Bathroom', kind: 'toilet', wall: 'e', at: 1.4 },
      { room: 'Bathroom', kind: 'bathroom_sink', wall: 'w', at: 1.4 },
      { room: 'Bathroom', kind: 'bathtub', x: 1.0, y: 3.45, rot: 90 },
      ...bed('Bedroom 2', 'e', 2.0, 'bed_single', 1),
      { room: 'Bedroom 2', kind: 'wardrobe', wall: 'n', at: 2.2 },
      { room: 'Bedroom 2', kind: 'desk', wall: 's', at: 1.0 },
      { room: 'Bedroom 2', kind: 'chair', x: 1.0, y: 2.95 },
      ...bed('Bedroom 3', 'e', 2.0, 'bed_single', 1),
      { room: 'Bedroom 3', kind: 'wardrobe', wall: 'n', at: 2.6 },
      { room: 'Bedroom 3', kind: 'desk', wall: 's', at: 1.0 },
      { room: 'Bedroom 3', kind: 'chair', x: 1.0, y: 2.95 },
    ],
  },
  {
    id: 'courtyard',
    name: 'L-shaped courtyard house',
    note: 'Two wings around a garden',
    layout: {
      rooms: [
        { name: 'Kitchen', type: 'kitchen', x: 0, y: 0, w: 5, h: 4.5 },
        { name: 'Living', type: 'living', x: 5, y: 0, w: 6.5, h: 4.5 },
        { name: 'Bathroom', type: 'bathroom', x: 0, y: 4.5, w: 3.5, h: 2.5 },
        { name: 'Hall', type: 'hall', x: 3.5, y: 4.5, w: 1.5, h: 7 },
        { name: 'Bedroom 1', type: 'primary_bedroom', x: 0, y: 7, w: 3.5, h: 4.5 },
        { name: 'Bedroom 2', type: 'bedroom', x: 0, y: 11.5, w: 5, h: 3.5 },
      ],
      links: [
        open('Kitchen', 'Living'),
        entrance('Living'),
        door('Hall', 'Kitchen'),
        door('Hall', 'Bathroom'),
        door('Hall', 'Bedroom 1'),
        door('Hall', 'Bedroom 2'),
      ],
    },
    items: [
      ...kitchenRun('Kitchen', 'w', 0.2, ['fridge', 'counter', 'stove', 'kitchen_sink']),
      { room: 'Kitchen', kind: 'counter', wall: 'n', at: 1.5 },
      { room: 'Kitchen', kind: 'dining_table', x: 3.0, y: 2.4 },
      { room: 'Kitchen', kind: 'chair', x: 2.6, y: 1.65 },
      { room: 'Kitchen', kind: 'chair', x: 3.4, y: 1.65 },
      { room: 'Kitchen', kind: 'chair', x: 2.6, y: 3.15, rot: 180 },
      { room: 'Kitchen', kind: 'chair', x: 3.4, y: 3.15, rot: 180 },
      { room: 'Living', kind: 'sofa', wall: 'e', at: 2.25 },
      { room: 'Living', kind: 'rug', x: 4.6, y: 2.25 },
      { room: 'Living', kind: 'coffee_table', x: 4.6, y: 2.25, rot: 90 },
      { room: 'Living', kind: 'armchair', wall: 's', at: 4.4 },
      { room: 'Living', kind: 'bookshelf', wall: 'n', at: 5.5 },
      { room: 'Living', kind: 'plant', x: 6.1, y: 4.1 },
      { room: 'Bathroom', kind: 'toilet', wall: 'w', at: 0.6 },
      { room: 'Bathroom', kind: 'bathroom_sink', wall: 'w', at: 1.35 },
      { room: 'Bathroom', kind: 'bathtub', x: 1.9, y: 2.0, rot: 90 },
      ...bed('Bedroom 1', 'w', 2.4, 'bed_double'),
      { room: 'Bedroom 1', kind: 'wardrobe', wall: 's', at: 2.6 },
      ...bed('Bedroom 2', 's', 1.6, 'bed_double'),
      { room: 'Bedroom 2', kind: 'wardrobe', wall: 'w', at: 0.8 },
      { room: 'Bedroom 2', kind: 'desk', wall: 'e', at: 2.4 },
      { room: 'Bedroom 2', kind: 'chair', x: 3.95, y: 2.4, rot: 270 },
    ],
  },
  {
    id: 'event-hall',
    name: 'Event hall',
    note: 'Stage, tables, foyer',
    layout: {
      rooms: [
        { name: 'Main hall', type: 'other', x: 0, y: 0, w: 14, h: 9 },
        { name: 'Storage', type: 'closet', x: 0, y: 9, w: 4, h: 2.5 },
        { name: 'Foyer', type: 'entry', x: 4, y: 9, w: 6, h: 2.5 },
        { name: 'Restrooms', type: 'bathroom', x: 10, y: 9, w: 4, h: 2.5 },
      ],
      links: [
        entrance('Foyer'),
        door('Foyer', 'Main hall'),
        door('Storage', 'Main hall'),
        door('Restrooms', 'Foyer'),
      ],
    },
    items: [
      { room: 'Main hall', kind: 'stage', wall: 'n', at: 5.8, label: 'Stage' },
      { room: 'Main hall', kind: 'stage', wall: 'n', at: 8.2 },
      { room: 'Main hall', kind: 'mic', x: 7.0, y: 2.35 },
      { room: 'Main hall', kind: 'speaker', wall: 'n', at: 4.0 },
      { room: 'Main hall', kind: 'speaker', wall: 'n', at: 10.0 },
      ...eventTable('Main hall', 3, 4.3, '1'),
      ...eventTable('Main hall', 7, 4.3, '2'),
      ...eventTable('Main hall', 11, 4.3, '3'),
      ...eventTable('Main hall', 3, 6.6, '4'),
      ...eventTable('Main hall', 7, 6.6, '5'),
      ...eventTable('Main hall', 11, 6.6, '6'),
      { room: 'Main hall', kind: 'trash_bin', wall: 's', at: 2.2 },
      { room: 'Main hall', kind: 'trash_bin', wall: 's', at: 12.0 },
      { room: 'Main hall', kind: 'plant', x: 0.45, y: 0.45 },
      { room: 'Main hall', kind: 'plant', x: 13.55, y: 0.45 },
      { room: 'Foyer', kind: 'event_table', wall: 'n', at: 3.5, label: 'Welcome' },
      { room: 'Foyer', kind: 'plant', x: 5.55, y: 2.05 },
      { room: 'Foyer', kind: 'trash_bin', wall: 'w', at: 2.0 },
      { room: 'Storage', kind: 'event_table', wall: 's', at: 1.2 },
      { room: 'Storage', kind: 'event_table', wall: 's', at: 3.0 },
      { room: 'Storage', kind: 'speaker', wall: 'e', at: 0.6 },
      { room: 'Restrooms', kind: 'toilet', wall: 'n', at: 1.6 },
      { room: 'Restrooms', kind: 'toilet', wall: 'n', at: 2.6 },
      { room: 'Restrooms', kind: 'bathroom_sink', wall: 's', at: 1.6 },
      { room: 'Restrooms', kind: 'bathroom_sink', wall: 's', at: 2.6 },
    ],
  },
];

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Where an item lands in plan coordinates, given its room's final rectangle. */
export function placeItem(item: TemplateItem, room: LayoutRoom): Omit<Furniture, 'id'> {
  const def = FURNITURE[item.kind];
  let x: number;
  let y: number;
  let deg: number;
  if ('wall' in item) {
    deg = SIDE_ROT[item.wall];
    const inset = WALL_GAP + def.d / 2;
    if (item.wall === 'n') [x, y] = [room.x + item.at, room.y + inset];
    else if (item.wall === 's') [x, y] = [room.x + item.at, room.y + room.h - inset];
    else if (item.wall === 'w') [x, y] = [room.x + inset, room.y + item.at];
    else [x, y] = [room.x + room.w - inset, room.y + item.at];
  } else {
    [x, y, deg] = [room.x + item.x, room.y + item.y, item.rot ?? 0];
  }
  return {
    kind: item.kind,
    x: r3(x),
    y: r3(y),
    rotation: (deg * Math.PI) / 180,
    ...(item.label ? { label: item.label } : {}),
  };
}

export interface BuiltTemplate {
  plan: PlanData;
  warnings: string[];
  /** Each room's final rectangle (the layout is re-centered on the origin). */
  rooms: LayoutRoom[];
  /** Index-aligned with `plan.furniture`: the room each piece was placed in. */
  itemRooms: string[];
}

export function buildTemplate(
  template: Template,
  opts: { units?: Units; newId?: () => string } = {},
): BuiltTemplate {
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const { plan, warnings } = layoutToPlan({ ...template.layout, title: template.name }, { newId });
  const rooms = normalizeLayout(template.layout).layout.rooms;
  const byName = new Map(rooms.map((r) => [r.name, r]));

  const furniture: Furniture[] = [];
  const itemRooms: string[] = [];
  for (const item of template.items) {
    const room = byName.get(item.room);
    if (!room) {
      warnings.push(`No room called ${item.room} for the ${item.kind}.`);
      continue;
    }
    furniture.push({ id: newId(), ...placeItem(item, room) });
    itemRooms.push(room.name);
  }

  return {
    plan: {
      ...plan,
      name: template.name,
      furniture,
      settings: { ...plan.settings, units: opts.units ?? plan.settings.units },
    },
    warnings,
    rooms,
    itemRooms,
  };
}

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
