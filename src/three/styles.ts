/**
 * Named looks for the 3D model. Pure data — no three.js — so the plan side
 * (menus, the command bar, generators) can import the list without pulling
 * the renderer into the first bundle.
 *
 * `plan.look.style` holds an id from here; unknown ids fall back to maquette.
 */
import type { RoofKind } from '../types';
import { roomKindFromName } from '../roomTypes';
import type { RoomKind } from '../roomTypes';
import type { TextureId } from './surfaces';
import type { Roofing } from './roofPieces';
import type { Siding } from './wallPieces';

/** The floor finishes a style defines; every room kind maps onto one (see FLOOR_ZONE). */
export type FloorZone = 'living' | 'kitchen' | 'bath' | 'bedroom' | 'garage' | 'outdoor';

export type FloorKind = 'plain' | 'wood' | 'tile' | 'stone' | 'carpet' | 'concrete';

export interface FloorSpec {
  kind: FloorKind;
  /** base color */ color: string;
  /** seams, grout, flecks */ line: string;
  /** meters covered by one repeat of the pattern */ size: number;
  rough: number;
  /** Photographed material laid over the colour; none keeps the drawn pattern. */
  tex?: TextureId;
}

/** The catalog's neutral part colors, by role. A style remaps each role. */
export interface FurniturePalette {
  wood: string;
  woodDark: string;
  fabric: string;
  fabricDark: string;
  linen: string;
  white: string;
  dark: string;
  screen: string;
  steel: string;
  leaf: string;
  pot: string;
}

export interface HouseStyle {
  id: string;
  label: string;
  /** interior wall faces */ wall: string;
  /** exterior wall faces */ cladding: string;
  /** Photographed materials for the walls and roof (none = flat colour, the maquette). */
  wallTex?: TextureId;
  claddingTex?: TextureId;
  roofTex?: TextureId;
  /** What the outside walls are made of, piece by piece (none: a smooth rendered wall). */
  siding?: Siding;
  /** What the roof is laid with (none: a smooth sheet). */
  roofing?: Roofing;
  /** the cut top of the walls, seen from above */ cap: string;
  /** door and window frames, sills */ trim: string;
  door: string;
  roof: string;
  glass: string;
  glassOpacity: number;
  /** Ink line along wall edges (the maquette's cut-card look); null for none. */
  edges: string | null;
  floors: Record<FloorZone, FloorSpec>;
  /** null keeps the catalog's own colors. */
  furniture: FurniturePalette | null;
  ground: string;
  /** background at midday */ sky: string;
  /** −1 cool … +1 warm: tints the key light. */
  warmth: number;
  /** Multiplier on the fill light (moody looks sit lower). */
  ambient: number;
  roofDefault: Exclude<RoofKind, 'none'>;
}

/** The catalog's neutrals (src/catalog.ts), keyed by role. */
const NEUTRAL: FurniturePalette = {
  wood: '#c8b89a',
  woodDark: '#a08e6f',
  fabric: '#dcd6ca',
  fabricDark: '#c8c1b2',
  linen: '#eee9df',
  white: '#f4f2ec',
  dark: '#55514a',
  screen: '#3a3733',
  steel: '#b9b5ac',
  leaf: '#8a9176',
  pot: '#b65c3f',
};

/** Other literals the catalog uses, folded onto the nearest role. */
const NEUTRAL_ALIASES: Record<string, keyof FurniturePalette> = {
  '#efe9db': 'linen',
  '#e8e2d4': 'white',
  '#dfe5e4': 'white',
  '#cdbfa4': 'fabricDark',
};

const plain = (color: string): FloorSpec => ({ kind: 'plain', color, line: color, size: 1, rough: 1 });
const wood = (color: string, line: string, rough = 0.72, tex: TextureId = 'oak'): FloorSpec => ({ kind: 'wood', color, line, size: 1.2, rough, tex });
const tile = (color: string, line: string, size = 1.2, rough = 0.45): FloorSpec => ({ kind: 'tile', color, line, size, rough, tex: size < 1 ? 'mosaic' : 'tile' });
const stone = (color: string, line: string, size = 1.6, rough = 0.7): FloorSpec => ({ kind: 'stone', color, line, size, rough, tex: 'stone' });
const carpet = (color: string, line: string): FloorSpec => ({ kind: 'carpet', color, line, size: 0.8, rough: 1, tex: 'carpet' });
const concrete = (color: string, line: string, rough = 0.85): FloorSpec => ({ kind: 'concrete', color, line, size: 2.4, rough, tex: 'concrete' });

const MAQUETTE_FLOOR = plain('#d9d3c5');

export const MAQUETTE: HouseStyle = {
  id: 'maquette',
  label: 'Maquette',
  wall: '#efebe1',
  cladding: '#efebe1',
  cap: '#efebe1',
  trim: '#f6f3ec',
  door: '#e3ddcf',
  roof: '#e6e1d5',
  glass: '#dfe7e6',
  glassOpacity: 0.3,
  edges: '#b6ae9e',
  floors: {
    living: MAQUETTE_FLOOR,
    kitchen: MAQUETTE_FLOOR,
    bath: MAQUETTE_FLOOR,
    bedroom: MAQUETTE_FLOOR,
    garage: MAQUETTE_FLOOR,
    outdoor: MAQUETTE_FLOOR,
  },
  furniture: null,
  ground: '#eae6dc',
  sky: '#F5F2EB',
  warmth: 0,
  ambient: 1,
  roofDefault: 'flat',
};

export const STYLES: readonly HouseStyle[] = [
  MAQUETTE,
  {
    id: 'scandinavian',
    siding: 'v-board',
    roofing: 'seam',
    label: 'Scandinavian',
    wallTex: 'plaster',
    claddingTex: 'timber',
    roofTex: 'metal',
    wall: '#f7f5ef',
    cladding: '#4d555b',
    cap: '#fbfaf6',
    trim: '#fbfaf6',
    door: '#d9bf99',
    roof: '#4a4b4d',
    glass: '#cfe0e6',
    glassOpacity: 0.32,
    edges: null,
    floors: {
      living: wood('#dcc29a', '#bfa57c'),
      kitchen: tile('#e9e7e1', '#cfccc4'),
      bath: tile('#e3e8e8', '#c3cbcb', 0.6),
      bedroom: wood('#e2cba6', '#c6ad86'),
      garage: concrete('#c9c8c3', '#b4b3ad'),
      outdoor: wood('#c9b08a', '#a8906c', 0.85),
    },
    furniture: {
      wood: '#dcc29a',
      woodDark: '#b99b6e',
      fabric: '#e6e3dc',
      fabricDark: '#c9cdd0',
      linen: '#f5f3ee',
      white: '#fbfaf7',
      dark: '#4f5357',
      screen: '#2e3134',
      steel: '#c3c6c7',
      leaf: '#7f9a78',
      pot: '#d9d5cc',
    },
    ground: '#dfe2d6',
    sky: '#e8eef1',
    warmth: -0.15,
    ambient: 1.05,
    roofDefault: 'gable',
  },
  {
    id: 'warm-modern',
    siding: 'h-board',
    roofing: 'seam',
    label: 'Warm modern',
    wallTex: 'plaster',
    claddingTex: 'timber',
    roofTex: 'metal',
    wall: '#ead7ba',
    cladding: '#b08a62',
    cap: '#4f4035',
    trim: '#4f4035',
    door: '#8a5f3c',
    roof: '#5a5049',
    glass: '#d6dcd4',
    glassOpacity: 0.3,
    edges: null,
    floors: {
      living: wood('#b98758', '#96693f', 0.72, 'walnut'),
      kitchen: stone('#d8cdbd', '#bdb09d', 1.2),
      bath: tile('#d9cfc2', '#b9ad9d', 0.6),
      bedroom: carpet('#d6c7b2', '#c4b39c'),
      garage: concrete('#bdb6ab', '#a7a094'),
      outdoor: stone('#c9bca8', '#aa9d89'),
    },
    furniture: {
      wood: '#b98758',
      woodDark: '#7d5535',
      fabric: '#d9c3a5',
      fabricDark: '#b98e69',
      linen: '#f1e6d5',
      white: '#f6efe3',
      dark: '#4a3a2f',
      screen: '#2c2622',
      steel: '#b3a48f',
      leaf: '#7d8a5c',
      pot: '#b4573a',
    },
    ground: '#ddd3bf',
    sky: '#f1e9dc',
    warmth: 0.45,
    ambient: 1,
    roofDefault: 'flat',
  },
  {
    id: 'industrial',
    siding: 'brick',
    roofing: 'seam',
    label: 'Industrial loft',
    wallTex: 'plaster',
    claddingTex: 'brick',
    roofTex: 'metal',
    wall: '#c6c9ca',
    cladding: '#9a5a45',
    cap: '#2b2d2f',
    trim: '#2b2d2f',
    door: '#3b3e41',
    roof: '#3d4043',
    glass: '#c5d2d6',
    glassOpacity: 0.34,
    edges: null,
    floors: {
      living: concrete('#b3b1ac', '#9a9892', 0.6),
      kitchen: concrete('#aeaca7', '#96948e', 0.5),
      bath: tile('#c9c9c6', '#8f8f8c', 0.6),
      bedroom: wood('#8e6f52', '#6d5239', 0.72, 'walnut'),
      garage: concrete('#a5a39e', '#8d8b86'),
      outdoor: concrete('#b9b7b1', '#a09e98'),
    },
    furniture: {
      wood: '#8e6f52',
      woodDark: '#5c4634',
      fabric: '#b9b6b0',
      fabricDark: '#8b8a86',
      linen: '#dedbd4',
      white: '#e9e7e2',
      dark: '#2f3133',
      screen: '#1f2022',
      steel: '#8f9498',
      leaf: '#6f8266',
      pot: '#9c5f4a',
    },
    ground: '#cfcdc6',
    sky: '#dfe2e3',
    warmth: -0.05,
    ambient: 0.95,
    roofDefault: 'flat',
  },
  {
    id: 'coastal',
    siding: 'lap',
    roofing: 'shingle',
    label: 'Coastal',
    wallTex: 'plaster',
    claddingTex: 'plaster',
    roofTex: 'shingle',
    wall: '#edf4f3',
    cladding: '#9fc0cf',
    cap: '#ffffff',
    trim: '#ffffff',
    door: '#6f97a8',
    roof: '#8d9aa0',
    glass: '#c6e2ea',
    glassOpacity: 0.34,
    edges: null,
    floors: {
      living: wood('#e3d3b7', '#c8b697'),
      kitchen: tile('#eef0ee', '#cfd6d6'),
      bath: tile('#dcebee', '#b6ccd1', 0.6),
      bedroom: wood('#e8dac0', '#cdbd9f'),
      garage: concrete('#cfd0cc', '#b9bab6'),
      outdoor: wood('#d3c4a8', '#b5a587', 0.9),
    },
    furniture: {
      wood: '#e0cfb0',
      woodDark: '#bda67f',
      fabric: '#eef0ec',
      fabricDark: '#a9c3cd',
      linen: '#f8f7f2',
      white: '#ffffff',
      dark: '#3f5966',
      screen: '#27353c',
      steel: '#c5ccce',
      leaf: '#86a58a',
      pot: '#6f97a8',
    },
    ground: '#e6dfc9',
    sky: '#dfeef3',
    warmth: 0.05,
    ambient: 1.08,
    roofDefault: 'hip',
  },
  {
    id: 'mediterranean',
    roofing: 'barrel',
    label: 'Mediterranean',
    wallTex: 'plaster',
    claddingTex: 'render',
    roofTex: 'clay',
    wall: '#f6e3c1',
    cladding: '#ecd0a2',
    cap: '#b8603f',
    trim: '#8a4a2c',
    door: '#3f6f73',
    roof: '#b8603f',
    glass: '#cfe0dc',
    glassOpacity: 0.3,
    edges: null,
    floors: {
      living: tile('#c98a62', '#a66f4c', 0.7, 0.6),
      kitchen: tile('#d7a47c', '#b07f5a', 0.7, 0.55),
      bath: tile('#e7dcc6', '#3f6f73', 0.6),
      bedroom: wood('#b58a5f', '#946d45', 0.72, 'walnut'),
      garage: concrete('#cdbfa9', '#b6a892'),
      outdoor: stone('#d9c6a5', '#bba784'),
    },
    furniture: {
      wood: '#a97b52',
      woodDark: '#70492d',
      fabric: '#ead9bb',
      fabricDark: '#c9925f',
      linen: '#f6eddc',
      white: '#faf4e8',
      dark: '#4b3527',
      screen: '#2b2420',
      steel: '#a89a84',
      leaf: '#6f8a57',
      pot: '#b8603f',
    },
    ground: '#e0cfa9',
    sky: '#f3ead6',
    warmth: 0.6,
    ambient: 1.02,
    roofDefault: 'hip',
  },
  {
    id: 'nocturne',
    siding: 'v-board',
    roofing: 'slate',
    label: 'Nocturne',
    wallTex: 'plaster',
    claddingTex: 'charred',
    roofTex: 'slate',
    wall: '#3c4045',
    // Dark, but not so dark the boards and their shadows vanish into one silhouette.
    cladding: '#34373b',
    cap: '#17191b',
    trim: '#1b1d20',
    door: '#6b4a34',
    roof: '#2a2c30',
    glass: '#8fb0c4',
    glassOpacity: 0.3,
    edges: null,
    floors: {
      living: wood('#5a4334', '#3f2e23', 0.6, 'walnut'),
      kitchen: stone('#484b4f', '#35373a', 1.2, 0.4),
      bath: tile('#4b4f54', '#2e3033', 0.6, 0.35),
      bedroom: carpet('#4a4744', '#3c3936'),
      garage: concrete('#55575a', '#444649'),
      outdoor: stone('#4f5154', '#3b3d40'),
    },
    furniture: {
      wood: '#6b4a34',
      woodDark: '#3f2c20',
      fabric: '#6a6d72',
      fabricDark: '#8a5a44',
      linen: '#b9b4aa',
      white: '#d3cfc6',
      dark: '#1f2124',
      screen: '#101113',
      steel: '#7d8287',
      leaf: '#5f7a5c',
      pot: '#b0764a',
    },
    ground: '#2c2e31',
    sky: '#23262b',
    warmth: 0.3,
    ambient: 0.9,
    roofDefault: 'flat',
  },
];

const BY_ID = new Map(STYLES.map((s) => [s.id, s]));

/** Resolve a style id; anything unknown is the maquette. */
export function styleById(id: unknown): HouseStyle {
  return (typeof id === 'string' && BY_ID.get(id)) || MAQUETTE;
}

/** True for ids this build knows. */
export const isStyleId = (id: unknown): boolean => typeof id === 'string' && BY_ID.has(id);

/**
 * Which finish each kind of room gets. The kind comes from the one shared
 * classifier (src/roomTypes.ts), so the model's floors and the plan's room
 * colours always agree about what a room is.
 */
export const FLOOR_ZONE: Record<RoomKind, FloorZone> = {
  bedroom: 'bedroom',
  bathroom: 'bath',
  kitchen: 'kitchen',
  dining: 'living',
  living: 'living',
  office: 'bedroom',
  circulation: 'living',
  utility: 'bath',
  storage: 'bedroom',
  garage: 'garage',
  outdoor: 'outdoor',
  event: 'living',
  other: 'living',
};

/** The floor for a room, read from its name. `openAir` forces the outdoor finish (an unnamed courtyard). */
export function floorFor(style: HouseStyle, roomName: string | undefined | null, openAir = false): FloorSpec {
  const zone = openAir ? 'outdoor' : FLOOR_ZONE[roomKindFromName(roomName)];
  return style.floors[zone] ?? style.floors.living;
}

/** The colours catalog furniture takes under a style (the catalog's own neutrals for the maquette). */
export function furniturePalette(style: HouseStyle): FurniturePalette {
  return style.furniture ?? NEUTRAL;
}

/**
 * Color mapping for catalog furniture under a style, or undefined when the
 * style leaves furniture alone. Colors that aren't catalog neutrals pass through.
 */
export function furnitureTint(style: HouseStyle): ((color: string) => string) | undefined {
  const palette = style.furniture;
  if (!palette) return undefined;
  const map = new Map<string, string>();
  for (const role of Object.keys(NEUTRAL) as (keyof FurniturePalette)[]) map.set(NEUTRAL[role], palette[role]);
  for (const [hex, role] of Object.entries(NEUTRAL_ALIASES)) map.set(hex, palette[role]);
  return (color) => map.get(color.toLowerCase()) ?? color;
}

/**
 * The roof actually shown — a choice made while drawing, never written to the
 * plan. Exterior never shows a bare box: with roof 'none' it uses the style's
 * own (every roof follows the footprint, so any of them fits any house).
 */
export function effectiveRoof(roof: RoofKind, style: HouseStyle, exterior: boolean): RoofKind {
  if (!exterior) return 'none';
  return roof !== 'none' ? roof : style.roofDefault;
}

export const ROOF_LABELS: Record<RoofKind, string> = {
  none: 'None',
  flat: 'Flat',
  gable: 'Gable',
  hip: 'Hip',
};
