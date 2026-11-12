/** What a room's label says about its size, in the plan's display units. */
import type { DetectedRoom } from '../../rooms';
import type { Units } from '../../types';
import { formatArea, formatLengthShort, unitSuffix } from '../../units';

/** "3.5 × 4.2 m" · "11′6″ × 13′9″" — width × depth. */
export function formatRoomSize(w: number, d: number, units: Units): string {
  const size = `${formatLengthShort(w, units)} × ${formatLengthShort(d, units)}`;
  return units === 'm' ? `${size} ${unitSuffix(units)}` : size;
}

/** A room's size (the bounding width × depth of its outline, to wall centerlines) and its area. */
export function roomText(room: DetectedRoom, units: Units): { dims: string; area: string } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of room.polygon) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { dims: formatRoomSize(maxX - minX, maxY - minY, units), area: formatArea(room.area, units) };
}
