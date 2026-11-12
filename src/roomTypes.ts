/**
 * What kind of room is this? One classifier, read from the room's name, shared
 * by the 2D plan (fill colors), the 3D model (floor materials), generation and
 * exports so they always agree. Pure — no store, no DOM.
 */
export type RoomKind =
  | 'bedroom'
  | 'bathroom'
  | 'kitchen'
  | 'dining'
  | 'living'
  | 'office'
  | 'circulation'
  | 'utility'
  | 'storage'
  | 'garage'
  | 'outdoor'
  | 'event'
  | 'other';

/** Checked in order; the first match wins (so "Primary bath" is a bathroom, not a bedroom). */
const KIND_WORDS: readonly [RoomKind, RegExp][] = [
  ['bathroom', /\b(bath|bathroom|ensuite|en-suite|wc|toilet|powder|shower|restroom|lavatory)\b/],
  ['storage', /\b(closet|wardrobe|pantry|storage|store|larder|cupboard|linen)\b/],
  ['garage', /\b(garage|carport|workshop)\b/],
  ['utility', /\b(laundry|utility|mud ?room|mechanical|boiler|plant room)\b/],
  ['outdoor', /\b(porch|patio|deck|terrace|balcony|veranda|courtyard|garden|outdoor)\b/],
  ['bedroom', /\b(bed|bedroom|primary|master|guest|nursery|kids?|suite)\b/],
  ['kitchen', /\b(kitchen|kitchenette|scullery|breakfast|nook)\b/],
  ['dining', /\b(dining|dinette)\b/],
  ['office', /\b(office|study|den|library|studio)\b/],
  ['circulation', /\b(hall|hallway|corridor|entry|entrance|foyer|lobby|landing|passage|vestibule|stair|stairs)\b/],
  ['event', /\b(event|ballroom|auditorium|stage|venue|banquet|conference|classroom|gallery)\b/],
  ['living', /\b(living|lounge|family|great room|sitting|sunroom|rec|media|theater|theatre|play)\b/],
];

/**
 * Classify a room from its name. Open-plan names joined by the generator
 * ("Living + Kitchen") classify by their first part. Unnamed or unrecognised
 * rooms are 'other'.
 */
export function roomKindFromName(name: string | undefined | null): RoomKind {
  const full = (name ?? '').toLowerCase().trim();
  if (!full) return 'other';
  const first = full.split(/\s*[+/&,]\s*/)[0] || full;
  for (const text of first === full ? [full] : [first, full]) {
    for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  }
  return 'other';
}

export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
  bedroom: 'Bedroom',
  bathroom: 'Bathroom',
  kitchen: 'Kitchen',
  dining: 'Dining',
  living: 'Living',
  office: 'Office',
  circulation: 'Hall',
  utility: 'Utility',
  storage: 'Storage',
  garage: 'Garage',
  outdoor: 'Outdoor',
  event: 'Event space',
  other: 'Room',
};

/**
 * Plan fill per room kind: soft pastels tuned to sit on Gaudí's warm paper
 * (#f5f2eb) under ink linework. `fill` is the room wash, `edge` a slightly
 * deeper tone for hover/selection and small swatches.
 */
export const ROOM_KIND_COLORS: Record<RoomKind, { fill: string; edge: string }> = {
  bedroom: { fill: '#f6ddd2', edge: '#e9bfae' },
  bathroom: { fill: '#d3e4ee', edge: '#aecbdb' },
  kitchen: { fill: '#f7e7b8', edge: '#e8d08a' },
  dining: { fill: '#f5e3c2', edge: '#e4c896' },
  living: { fill: '#f3ecc9', edge: '#e0d49b' },
  office: { fill: '#e2dcec', edge: '#c6bcd9' },
  circulation: { fill: '#f2ecdd', edge: '#ddd3bb' },
  utility: { fill: '#d9ebe3', edge: '#b5d3c6' },
  storage: { fill: '#ecdccb', edge: '#d8c0a6' },
  garage: { fill: '#e3e1dc', edge: '#c9c6be' },
  outdoor: { fill: '#dcebd3', edge: '#bbd6ac' },
  event: { fill: '#f1dde0', edge: '#deb9bf' },
  other: { fill: '#ebe7dd', edge: '#d6d0c2' },
};
