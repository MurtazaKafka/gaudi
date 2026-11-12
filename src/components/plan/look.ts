/**
 * The two looks of the 2D plan — "Color" (pastel rooms, solid walls, furnished)
 * and "Paper" (the monochrome line drawing) — and the colour maths of the
 * first. Pure: no store, no DOM beyond a guarded read of the saved preference.
 */
import { ROOM_KIND_COLORS, roomKindFromName, type RoomKind } from '../../roomTypes';
import { theme } from '../../theme';

export type DrawingLook = 'color' | 'paper';

export const DRAWING_LOOK_PREF = 'gaudi-pref-plan-look';

/** The saved per-browser choice; Color unless Paper was picked. Safe where there is no storage. */
export function readDrawingLook(): DrawingLook {
  try {
    return globalThis.localStorage?.getItem(DRAWING_LOOK_PREF) === 'paper' ? 'paper' : 'color';
  } catch {
    return 'color';
  }
}

export function storeDrawingLook(look: DrawingLook): void {
  try {
    globalThis.localStorage?.setItem(DRAWING_LOOK_PREF, look);
  } catch {
    /* private mode: the choice lasts for this visit */
  }
}

// ---------- colour ----------

export type Rgb = [number, number, number];

/** #rgb / #rrggbb → channels; null for anything else. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const clamp255 = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;
}

const NEUTRAL: Rgb = [207, 200, 184];

/** `a` moved `t` of the way to `b` (0 = a, 1 = b). Unreadable colours count as a neutral tone. */
export function mix(a: string, b: string, t: number): string {
  const p = parseHex(a) ?? NEUTRAL;
  const q = parseHex(b) ?? NEUTRAL;
  const k = Math.min(1, Math.max(0, t));
  return toHex([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k]);
}

/** Perceived lightness, 0 (black) … 1 (white). */
export function lightness(hex: string): number {
  const [r, g, b] = parseHex(hex) ?? NEUTRAL;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The translucent colour that reads as `target` once laid over the paper at
 * `alpha` — so a room keeps its exact tone while the grid still shows through
 * at (1 − alpha) of its strength.
 */
export function overPaper(target: string, alpha: number, paper: string = theme.paper): string {
  const t = parseHex(target) ?? NEUTRAL;
  const p = parseHex(paper) ?? [245, 242, 235];
  const a = Math.min(1, Math.max(0.05, alpha));
  const c = t.map((v, i) => clamp255(p[i] + (v - p[i]) / a));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

// ---------- rooms ----------

/** How opaque a room's wash is; the grid recedes to the rest. */
export const ROOM_FILL_ALPHA = 0.62;

export interface RoomTone {
  kind: RoomKind;
  /** the room's resting colour */ fill: string;
  /** under the pointer */ hover: string;
  /** selected: the same tone warmed toward the accent */ selected: string;
}

const toneCache = new Map<RoomKind, RoomTone>();

/** Colours for a room, from its name. Unnamed and unrecognised rooms get the neutral tone. */
export function roomTone(name: string | undefined | null): RoomTone {
  const kind = roomKindFromName(name);
  let tone = toneCache.get(kind);
  if (!tone) {
    const { fill, edge } = ROOM_KIND_COLORS[kind];
    tone = { kind, fill, hover: mix(fill, edge, 0.7), selected: mix(fill, theme.accent, 0.2) };
    toneCache.set(kind, tone);
  }
  return tone;
}

// ---------- furniture ----------

const WARM_WHITE = '#f8f4ec';

/**
 * A part's colour as it sits on the plan: its own hue, lifted toward warm white
 * so dark and saturated pieces don't punch holes in the drawing.
 */
export function plannedColor(color: string): string {
  const l = lightness(color);
  return mix(color, WARM_WHITE, 0.16 + 0.3 * (1 - l));
}

/** The hairline around a part: its planned colour, deepened toward ink. */
export function plannedEdge(color: string): string {
  return mix(plannedColor(color), theme.ink, 0.36);
}
