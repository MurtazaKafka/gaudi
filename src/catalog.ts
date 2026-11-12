/**
 * Parametric furniture catalog. Each piece is a real-world footprint
 * (w across × d deep, meters) plus 3D parts composed from primitives in a
 * local frame: x right, y up from the floor, z deep — rotated/positioned
 * by the item's plan transform. No mesh assets; everything stays maquette.
 */

export type PartShape = 'box' | 'rbox' | 'cylinder' | 'cone' | 'sphere' | 'torus';

/**
 * One primitive of a furniture model, in the item's local frame (meters):
 * x right, y up from the floor, z toward the item's front. (x, y, z) is the
 * part's CENTER.
 *
 *   box / rbox  w × h × d              (rbox adds `bevel`, a corner radius)
 *   cylinder    r, h; optional r2 = top radius for a taper (axis along y)
 *   cone        r (base), h            (axis along y, apex up)
 *   sphere      r; or w/h/d as ellipsoid diameters
 *   torus       r (ring radius), r2 (tube radius); lies flat, axis along y
 */
export interface Part {
  shape: PartShape;
  x: number;
  y: number;
  z: number;
  /** box dims */ w?: number;
  d?: number;
  /** box/cylinder/cone height */ h?: number;
  /** cylinder/cone/sphere/torus radius */ r?: number;
  /** cylinder top radius, or torus tube radius */ r2?: number;
  /** rbox corner radius */ bevel?: number;
  /** Euler rotation in degrees, applied X then Y then Z about the part center. */
  rot?: [number, number, number];
  color: string;
  /** 0..1, default 0.9 (matte) */ rough?: number;
  /** 0..1, default 0 */ metal?: number;
  /** emissive strength 0..2 — lamps, screens */ glow?: number;
  /** 0..1 — glass */ opacity?: number;
}

export interface FurnitureDef {
  label: string;
  w: number;
  d: number;
  h: number;
  parts: Part[];
}

const wood = '#c8b89a';
const woodDk = '#a08e6f';
const fabric = '#dcd6ca';
const fabricDk = '#c8c1b2';
const linen = '#eee9df';
const white = '#f4f2ec';
const dark = '#55514a';
const screen = '#3a3733';
const steel = '#b9b5ac';
const leaf = '#8a9176';
const pot = '#b65c3f';

function box(x: number, y: number, z: number, w: number, h: number, d: number, color: string): Part {
  return { shape: 'box', x, y, z, w, h, d, color };
}

function cyl(x: number, y: number, z: number, r: number, h: number, color: string): Part {
  return { shape: 'cylinder', x, y, z, r, h, color };
}

function legs(w: number, d: number, h: number, t = 0.05, color = woodDk): Part[] {
  const x = w / 2 - t / 2 - 0.02;
  const z = d / 2 - t / 2 - 0.02;
  return [
    box(-x, h / 2, -z, t, h, t, color),
    box(x, h / 2, -z, t, h, t, color),
    box(-x, h / 2, z, t, h, t, color),
    box(x, h / 2, z, t, h, t, color),
  ];
}

function bed(w: number, d: number): FurnitureDef {
  return {
    label: w > 1.2 ? 'Double bed' : 'Single bed',
    w,
    d,
    h: 0.85,
    parts: [
      box(0, 0.175, 0, w, 0.35, d, wood),
      box(0, 0.42, 0.02, w - 0.08, 0.14, d - 0.12, linen),
      box(0, 0.6, -d / 2 + 0.04, w, 0.5, 0.08, woodDk),
      ...(w > 1.2
        ? [
            box(-w / 4, 0.53, -d / 2 + 0.28, w / 2 - 0.18, 0.09, 0.4, white),
            box(w / 4, 0.53, -d / 2 + 0.28, w / 2 - 0.18, 0.09, 0.4, white),
          ]
        : [box(0, 0.53, -d / 2 + 0.28, w - 0.3, 0.09, 0.4, white)]),
    ],
  };
}

export const FURNITURE = {
  bed_double: bed(1.6, 2.0),
  bed_single: bed(0.9, 2.0),
  nightstand: {
    label: 'Nightstand',
    w: 0.45,
    d: 0.45,
    h: 0.5,
    parts: [box(0, 0.25, 0, 0.45, 0.5, 0.45, wood)],
  },
  wardrobe: {
    label: 'Wardrobe',
    w: 1.2,
    d: 0.6,
    h: 2.0,
    parts: [
      box(0, 1, 0, 1.2, 2, 0.6, wood),
      box(-0.3, 1, 0.305, 0.56, 1.9, 0.02, woodDk),
      box(0.3, 1, 0.305, 0.56, 1.9, 0.02, woodDk),
    ],
  },
  sofa: {
    label: 'Sofa',
    w: 1.8,
    d: 0.85,
    h: 0.78,
    parts: [
      box(0, 0.22, 0.06, 1.8, 0.44, 0.73, fabric),
      box(0, 0.55, -0.345, 1.8, 0.46, 0.16, fabric),
      box(-0.825, 0.52, 0.06, 0.15, 0.3, 0.73, fabricDk),
      box(0.825, 0.52, 0.06, 0.15, 0.3, 0.73, fabricDk),
      box(-0.42, 0.49, 0.1, 0.78, 0.1, 0.62, linen),
      box(0.42, 0.49, 0.1, 0.78, 0.1, 0.62, linen),
    ],
  },
  armchair: {
    label: 'Armchair',
    w: 0.85,
    d: 0.85,
    h: 0.75,
    parts: [
      box(0, 0.22, 0.05, 0.85, 0.44, 0.72, fabric),
      box(0, 0.52, -0.34, 0.85, 0.4, 0.16, fabric),
      box(-0.37, 0.5, 0.05, 0.12, 0.26, 0.72, fabricDk),
      box(0.37, 0.5, 0.05, 0.12, 0.26, 0.72, fabricDk),
    ],
  },
  coffee_table: {
    label: 'Coffee table',
    w: 1.0,
    d: 0.6,
    h: 0.4,
    parts: [box(0, 0.38, 0, 1.0, 0.04, 0.6, wood), ...legs(1.0, 0.6, 0.36)],
  },
  tv_stand: {
    label: 'TV stand',
    w: 1.4,
    d: 0.4,
    h: 1.05,
    parts: [
      box(0, 0.225, 0, 1.4, 0.45, 0.4, wood),
      box(0, 0.83, 0.02, 1.1, 0.64, 0.05, screen),
    ],
  },
  dining_table: {
    label: 'Dining table',
    w: 1.6,
    d: 0.9,
    h: 0.74,
    parts: [box(0, 0.72, 0, 1.6, 0.04, 0.9, wood), ...legs(1.6, 0.9, 0.7, 0.06)],
  },
  chair: {
    label: 'Chair',
    w: 0.45,
    d: 0.5,
    h: 0.85,
    parts: [
      box(0, 0.45, 0.02, 0.45, 0.05, 0.45, wood),
      box(0, 0.66, -0.21, 0.45, 0.42, 0.04, wood),
      ...legs(0.45, 0.48, 0.43, 0.04),
    ],
  },
  desk: {
    label: 'Desk',
    w: 1.2,
    d: 0.6,
    h: 0.74,
    parts: [
      box(0, 0.72, 0, 1.2, 0.04, 0.6, wood),
      box(-0.56, 0.35, 0, 0.04, 0.7, 0.56, woodDk),
      box(0.56, 0.35, 0, 0.04, 0.7, 0.56, woodDk),
    ],
  },
  bookshelf: {
    label: 'Bookshelf',
    w: 0.8,
    d: 0.3,
    h: 1.8,
    parts: [
      box(0, 0.9, 0, 0.8, 1.8, 0.3, wood),
      box(0, 0.9, 0.03, 0.7, 1.7, 0.26, '#efe9db'),
      box(0, 0.47, 0.03, 0.7, 0.03, 0.26, wood),
      box(0, 0.9, 0.03, 0.7, 0.03, 0.26, wood),
      box(0, 1.33, 0.03, 0.7, 0.03, 0.26, wood),
    ],
  },
  fridge: {
    label: 'Fridge',
    w: 0.6,
    d: 0.65,
    h: 1.8,
    parts: [
      box(0, 0.9, 0, 0.6, 1.8, 0.65, white),
      box(-0.24, 1.2, 0.34, 0.03, 0.5, 0.03, steel),
    ],
  },
  stove: {
    label: 'Stove',
    w: 0.6,
    d: 0.6,
    h: 0.9,
    parts: [
      box(0, 0.45, 0, 0.6, 0.9, 0.6, white),
      box(0, 0.905, 0, 0.58, 0.015, 0.58, dark),
      cyl(-0.14, 0.92, -0.14, 0.09, 0.012, steel),
      cyl(0.14, 0.92, -0.14, 0.09, 0.012, steel),
      cyl(-0.14, 0.92, 0.14, 0.09, 0.012, steel),
      cyl(0.14, 0.92, 0.14, 0.09, 0.012, steel),
    ],
  },
  counter: {
    label: 'Counter',
    w: 1.2,
    d: 0.6,
    h: 0.9,
    parts: [
      box(0, 0.44, 0, 1.2, 0.88, 0.6, wood),
      box(0, 0.9, 0, 1.24, 0.04, 0.64, '#e8e2d4'),
    ],
  },
  kitchen_sink: {
    label: 'Kitchen sink',
    w: 0.6,
    d: 0.6,
    h: 0.9,
    parts: [
      box(0, 0.44, 0, 0.6, 0.88, 0.6, wood),
      box(0, 0.9, 0, 0.64, 0.04, 0.64, '#e8e2d4'),
      box(0, 0.92, 0, 0.44, 0.04, 0.4, steel),
      cyl(0, 1.02, -0.18, 0.02, 0.2, steel),
    ],
  },
  bathroom_sink: {
    label: 'Bathroom sink',
    w: 0.5,
    d: 0.45,
    h: 0.85,
    parts: [
      box(0, 0.42, 0, 0.18, 0.8, 0.18, white),
      box(0, 0.81, 0, 0.5, 0.09, 0.45, white),
      cyl(0, 0.9, -0.14, 0.02, 0.14, steel),
    ],
  },
  toilet: {
    label: 'Toilet',
    w: 0.4,
    d: 0.65,
    h: 0.78,
    parts: [
      cyl(0, 0.21, 0.1, 0.19, 0.42, white),
      box(0, 0.55, -0.24, 0.4, 0.45, 0.16, white),
    ],
  },
  bathtub: {
    label: 'Bathtub',
    w: 0.8,
    d: 1.7,
    h: 0.55,
    parts: [
      box(0, 0.275, 0, 0.8, 0.55, 1.7, white),
      box(0, 0.51, 0, 0.62, 0.08, 1.52, '#dfe5e4'),
    ],
  },
  rug: {
    label: 'Rug',
    w: 1.6,
    d: 1.6,
    h: 0.02,
    parts: [cyl(0, 0.01, 0, 0.8, 0.02, '#cdbfa4')],
  },
  stage: {
    label: "Stage riser (6'×8')",
    w: 2.4,
    d: 1.8,
    h: 0.45,
    parts: [
      box(0, 0.21, 0, 2.4, 0.42, 1.8, wood),
      box(0, 0.44, 0, 2.5, 0.04, 1.9, woodDk),
    ],
  },
  event_table: {
    label: 'Event table',
    w: 1.8,
    d: 0.75,
    h: 0.75,
    parts: [box(0, 0.73, 0, 1.8, 0.04, 0.75, wood), ...legs(1.8, 0.75, 0.71)],
  },
  speaker: {
    label: 'Speaker',
    w: 0.6,
    d: 0.5,
    h: 1.8,
    parts: [
      box(0, 0.9, 0, 0.6, 1.8, 0.5, dark),
      box(0, 1.15, 0.24, 0.5, 1.1, 0.03, screen),
    ],
  },
  mic: {
    label: 'Microphone',
    w: 0.4,
    d: 0.4,
    h: 1.5,
    parts: [
      cyl(0, 0.015, 0, 0.18, 0.03, steel),
      cyl(0, 0.72, 0, 0.025, 1.4, steel),
      { shape: 'sphere', x: 0, y: 1.45, z: 0, r: 0.06, color: dark },
    ],
  },
  trash_bin: {
    label: 'Trash bin',
    w: 0.5,
    d: 0.5,
    h: 0.85,
    parts: [cyl(0, 0.425, 0, 0.25, 0.85, steel)],
  },
  plant: {
    label: 'Plant',
    w: 0.45,
    d: 0.45,
    h: 1.2,
    parts: [
      cyl(0, 0.16, 0, 0.16, 0.32, pot),
      { shape: 'sphere', x: 0, y: 0.78, z: 0, r: 0.3, color: leaf },
      { shape: 'sphere', x: 0.1, y: 0.98, z: 0.06, r: 0.2, color: leaf },
    ],
  },
} as const satisfies Record<string, FurnitureDef>;

export type BuiltinKind = keyof typeof FURNITURE;
/** A plan-local item (e.g. modelled from a product link): `custom:{id}` → plan.customItems[id]. */
export type CustomKind = `custom:${string}`;
export type FurnitureKind = BuiltinKind | CustomKind;

export const FURNITURE_KINDS = Object.keys(FURNITURE) as BuiltinKind[];

export const isBuiltinKind = (k: unknown): k is BuiltinKind =>
  typeof k === 'string' && Object.hasOwn(FURNITURE, k);
export const isCustomKind = (k: unknown): k is CustomKind =>
  typeof k === 'string' && k.startsWith('custom:') && k.length > 7;
export const customKind = (id: string): CustomKind => `custom:${id}`;
export const customId = (kind: CustomKind): string => kind.slice(7);

/**
 * Custom definitions live in the plan (store.customItems); the store mirrors
 * them here so every `furnitureDef(kind)` call site resolves both sources.
 */
let customDefs: Record<string, FurnitureDef> = {};
export function setCustomDefs(defs: Record<string, FurnitureDef>): void {
  customDefs = defs;
}

/** Stand-in for a custom kind whose definition is gone (deleted, or a partial import). */
const MISSING: FurnitureDef = {
  label: 'Missing item',
  w: 0.6,
  d: 0.6,
  h: 0.6,
  parts: [box(0, 0.3, 0, 0.6, 0.6, 0.6, '#cfc8b8')],
};

export function furnitureDef(kind: FurnitureKind): FurnitureDef {
  if (isBuiltinKind(kind)) return FURNITURE[kind];
  const id = customId(kind);
  return Object.hasOwn(customDefs, id) ? customDefs[id] : MISSING;
}

/** True when `kind` resolves to a real definition (builtin, or a custom item present in the plan). */
export function kindExists(kind: unknown): kind is FurnitureKind {
  return isBuiltinKind(kind) || (isCustomKind(kind) && Object.hasOwn(customDefs, customId(kind)));
}
