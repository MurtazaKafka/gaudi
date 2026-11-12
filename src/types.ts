import type { FurnitureDef, FurnitureKind } from './catalog';

/** All coordinates are real-world meters. Plan space: x → east, y → south (screen-down). */
export interface Point {
  x: number;
  y: number;
}

export interface Wall {
  id: string;
  a: Point;
  b: Point;
}

export type OpeningType = 'door' | 'window';

/** An opening lives on a wall: `offset` is the distance (m) from endpoint A to the opening's center. */
export interface Opening {
  id: string;
  wallId: string;
  type: OpeningType;
  offset: number;
  width: number;
  /** Optional annotation shown beside the opening (e.g. "Main Entrance"). */
  label?: string;
}

/** A placed furniture item: center position in plan meters, rotation in radians. */
export interface Furniture {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  rotation: number;
  /** Optional annotation shown on the plan (e.g. "#7", "Stage"). */
  label?: string;
}

/** Display units. Everything is stored in meters; this only changes how lengths read. */
export type Units = 'm' | 'ft';

export interface PlanSettings {
  /** m */ wallHeight: number;
  /** m */ wallThickness: number;
  /** m */ gridSize: number;
  units: Units;
}

/** Where a custom item came from — a product page the model was built from. */
export interface ProductSource {
  url: string;
  title?: string;
  brand?: string;
  price?: string;
  /** product photo URL */ image?: string;
  asin?: string;
  /** the dimension text as found on the page */ dims?: string;
}

/**
 * A furniture definition stored in the plan itself rather than the static
 * catalog. Placed items reference it as kind `custom:{id}`.
 */
export interface CustomItem extends FurnitureDef {
  id: string;
  source?: ProductSource;
  /** epoch ms */ createdAt: number;
}

export type RoofKind = 'none' | 'flat' | 'gable' | 'hip';

/** How the model is dressed in 3D. Style ids are defined in src/three/styles.ts. */
export interface PlanLook {
  style: string;
  roof: RoofKind;
}

/** The whole document: everything that is saved, shared, exported and undone. */
export interface PlanData {
  name: string;
  walls: Wall[];
  openings: Opening[];
  furniture: Furniture[];
  roomNames: Record<string, string>;
  settings: PlanSettings;
  customItems: Record<string, CustomItem>;
  look: PlanLook;
}

export type Tool = 'select' | 'wall' | 'door' | 'window' | 'furniture' | 'measure';
