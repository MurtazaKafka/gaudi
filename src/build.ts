import type { Opening, PlanSettings, Wall } from './types';
import { wallAngle, wallLength } from './geometry';

/** One axis-aligned box in a wall's local frame, ready for the 3D scene. */
export interface WallBox {
  key: string;
  /** world center */ x: number;
  y: number;
  z: number;
  /** along the wall */ length: number;
  height: number;
  thickness: number;
  rotY: number;
}

/** A span of wall: [start, end] along the segment, [y0, y1] vertically. */
interface Span {
  start: number;
  end: number;
  y0: number;
  y1: number;
}

const MIN_PIECE = 0.01;

/**
 * Convert walls (+ openings, slice 4) into boxes. Openings never use CSG:
 * each wall splits into side pieces, lintels and sills as separate spans.
 */
export function buildWallBoxes(
  walls: Wall[],
  openings: Opening[],
  settings: PlanSettings,
): WallBox[] {
  const boxes: WallBox[] = [];

  for (const wall of walls) {
    const len = wallLength(wall);
    if (len < MIN_PIECE) continue;
    const angle = wallAngle(wall);
    const dx = (wall.b.x - wall.a.x) / len;
    const dy = (wall.b.y - wall.a.y) / len;

    const spans = wallSpans(wall, openings, len, settings);

    spans.forEach((s, i) => {
      const mid = (s.start + s.end) / 2;
      boxes.push({
        key: `${wall.id}:${i}`,
        x: wall.a.x + dx * mid,
        y: (s.y0 + s.y1) / 2,
        z: wall.a.y + dy * mid,
        length: s.end - s.start,
        height: s.y1 - s.y0,
        thickness: settings.wallThickness,
        rotY: -angle,
      });
    });
  }

  return boxes;
}

function wallSpans(
  wall: Wall,
  openings: Opening[],
  len: number,
  settings: PlanSettings,
): Span[] {
  const H = settings.wallHeight;
  const mine = openings
    .filter((o) => o.wallId === wall.id)
    .sort((a, b) => a.offset - b.offset);

  if (mine.length === 0) return [{ start: 0, end: len, y0: 0, y1: H }];

  const spans: Span[] = [];
  let cursor = 0;

  for (const o of mine) {
    const half = o.width / 2;
    const left = Math.max(cursor, o.offset - half);
    const right = Math.min(len, o.offset + half);
    if (right - left < MIN_PIECE) continue;

    // Full-height piece before the opening.
    if (left - cursor > MIN_PIECE) spans.push({ start: cursor, end: left, y0: 0, y1: H });

    if (o.type === 'door') {
      const doorTop = Math.min(2.1, H - 0.15);
      // Lintel above the door.
      if (H - doorTop > MIN_PIECE) spans.push({ start: left, end: right, y0: doorTop, y1: H });
    } else {
      const sill = 0.9;
      const head = Math.min(2.1, H - 0.15);
      // Wall below the sill and above the header.
      if (sill > MIN_PIECE) spans.push({ start: left, end: right, y0: 0, y1: sill });
      if (H - head > MIN_PIECE) spans.push({ start: left, end: right, y0: head, y1: H });
    }
    cursor = right;
  }

  if (len - cursor > MIN_PIECE) spans.push({ start: cursor, end: len, y0: 0, y1: H });
  return spans;
}
