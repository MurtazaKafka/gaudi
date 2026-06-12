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
}

/** A room is derived from a closed wall loop; `key` is stable across re-detection. */
export interface Room {
  key: string;
  polygon: Point[];
  area: number;
}

export interface PlanSettings {
  /** m */ wallHeight: number;
  /** m */ wallThickness: number;
  /** m */ gridSize: number;
}

export type Tool = 'select' | 'wall' | 'door' | 'window';
