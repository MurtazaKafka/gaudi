/** How well a layout met the brief — the one-line scorecard on each option card. Pure. */
import { bounds } from './audit';
import { layoutArea, type Layout, type RoomType } from './layout';
import { SPACES, type Brief, type SpaceId } from './brief';

export interface Scorecard {
  bedrooms: { asked: number; got: number };
  bathrooms: { asked: number; got: number };
  /** Asked-for spaces the layout lacks (labels). */
  missing: string[];
  /** m² */ area: number;
  /** m² asked, or null for "any" */ target: number | null;
  /** Signed share over (+) or under (−) the target; null when there is none. */
  areaOff: number | null;
  /** null when no lot was given */
  fitsLot: boolean | null;
  /** Overall size of the outline, m. */
  footprint: { w: number; h: number };
}

const SPACE_TYPE: Partial<Record<SpaceId, RoomType>> = {
  kitchen: 'kitchen', living: 'living', dining: 'dining', office: 'office',
  entry: 'entry', laundry: 'laundry', pantry: 'pantry', garage: 'garage',
};

export function scoreLayout(layout: Layout, brief: Brief): Scorecard {
  const count = (...types: RoomType[]) => layout.rooms.filter((r) => types.includes(r.type)).length;
  const missing: string[] = [];
  for (const s of SPACES) {
    const type = SPACE_TYPE[s.id];
    if (type && brief.spaces[s.id] && count(type) === 0) missing.push(s.label.toLowerCase());
  }
  if (brief.spaces.primary && brief.bedrooms >= 1 && count('primary_bedroom') === 0) missing.push('primary suite');
  const area = layoutArea(layout);
  const box = bounds(layout.rooms);
  return {
    bedrooms: { asked: brief.bedrooms, got: count('bedroom', 'primary_bedroom') },
    bathrooms: { asked: brief.bathrooms, got: count('bathroom', 'primary_bath') },
    missing,
    area,
    target: brief.area,
    areaOff: brief.area ? (area - brief.area) / brief.area : null,
    fitsLot: brief.lot ? box.w <= brief.lot.w + 1e-6 && box.h <= brief.lot.d + 1e-6 : null,
    footprint: { w: box.w, h: box.h },
  };
}

/** True when nothing asked for is missing or off. */
export function scoreClean(s: Scorecard): boolean {
  return (
    s.bedrooms.got === s.bedrooms.asked &&
    s.bathrooms.got === s.bathrooms.asked &&
    s.missing.length === 0 &&
    (s.areaOff === null || Math.abs(s.areaOff) <= 0.1) &&
    s.fitsLot !== false
  );
}

/** "All rooms · 4% over target · fits lot" */
export function scoreLine(s: Scorecard): string {
  const parts: string[] = [];
  const short: string[] = [];
  if (s.bedrooms.got !== s.bedrooms.asked) short.push(`${s.bedrooms.got} of ${s.bedrooms.asked} bedrooms`);
  if (s.bathrooms.got !== s.bathrooms.asked) short.push(`${s.bathrooms.got} of ${s.bathrooms.asked} baths`);
  if (s.missing.length) short.push(`no ${s.missing.join(', ')}`);
  parts.push(short.length ? short.join(', ') : 'All rooms');
  if (s.areaOff !== null) {
    const pct = Math.round(Math.abs(s.areaOff) * 100);
    parts.push(pct < 3 ? 'on target' : `${pct}% ${s.areaOff > 0 ? 'over' : 'under'} target`);
  }
  if (s.fitsLot !== null) parts.push(s.fitsLot ? 'fits lot' : 'too big for lot');
  return parts.join(' · ');
}
