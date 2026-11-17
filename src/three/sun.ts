/**
 * Time of day → light. Pure numbers and hex strings (no three.js).
 *
 * At noon the maquette's key light sits exactly where its studio lamp always
 * has, behind the model; earlier and later it swings low toward east and
 * west, warms up and dims, and the sky follows. A styled house gets the same
 * arc mirrored to the front, so the sun lights the entrance side.
 */
import type { HouseStyle } from './styles';
import { SUN_MAX, SUN_MIN, SUN_NOON } from './viewStore';

export interface SunState {
  /** Unit vector from the scene toward the sun (x east, y up, z south). */
  dir: [number, number, number];
  keyColor: string;
  keyIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  fillIntensity: number;
  background: string;
  ground: string;
}

/** The lamp position the maquette has always used, per unit of plan radius. */
export const NOON_LAMP: [number, number, number] = [1.2, 2.6, -1.4];
export const LAMP_DISTANCE = Math.hypot(...NOON_LAMP);

const NOON_ELEVATION = Math.asin(NOON_LAMP[1] / LAMP_DISTANCE);
const NOON_AZIMUTH = Math.atan2(NOON_LAMP[2], NOON_LAMP[0]);
const DEG = Math.PI / 180;

export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [200, 200, 200];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/** Blend two hex colors: t = 0 gives `a`, t = 1 gives `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k === 0) return a;
  const pa = parseHex(a);
  const pb = parseHex(b);
  return toHex([pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k]);
}

/** Perceived lightness 0..1. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** −1 at the earliest hour, 0 at noon, +1 at the latest. */
export function sunPhase(hour: number): number {
  const h = Math.max(SUN_MIN, Math.min(SUN_MAX, Number.isFinite(hour) ? hour : SUN_NOON));
  return h < SUN_NOON ? (h - SUN_NOON) / (SUN_NOON - SUN_MIN) : (h - SUN_NOON) / (SUN_MAX - SUN_NOON);
}

export function sunState(hour: number, style: HouseStyle): SunState {
  const phase = sunPhase(hour);
  const elevation = NOON_ELEVATION * Math.cos(phase * 1.46);
  const azimuth = NOON_AZIMUTH - phase * (phase < 0 ? 55 : 125) * DEG;
  const ce = Math.cos(elevation);
  // The maquette keeps its studio lamp behind the model, where its shadows read from above. A styled
  // house stands under a real sky: the sun crosses in front of it, so the entrance side is the lit one.
  const side = style.id === 'maquette' ? 1 : -1;
  const dir: [number, number, number] = [ce * Math.cos(azimuth), Math.sin(elevation), side * ce * Math.sin(azimuth)];

  // 0 at noon → ~0.87 with the sun on the horizon.
  const low = 1 - Math.sin(elevation) / Math.sin(NOON_ELEVATION);
  const morning = phase < 0;
  const dark = luminance(style.sky) < 0.35;

  let key = '#fff4e0';
  if (style.warmth > 0) key = mixHex(key, '#ffd7a3', style.warmth * 0.5);
  else if (style.warmth < 0) key = mixHex(key, '#eaf2ff', -style.warmth * 0.5);
  key = mixHex(key, morning ? '#ffb27a' : '#ff9350', Math.pow(low, 1.5) * 0.9);

  return {
    dir,
    keyColor: key,
    // Holds up well into the evening and only gives way right at the horizon, so long warm raking shadows survive.
    keyIntensity: 1.9 * (1 - 0.42 * Math.pow(low, 3.2)),
    hemiSky: mixHex('#fdf9ef', morning ? '#f7dccb' : '#eec3ad', low * 0.6),
    hemiGround: '#cfc8b8',
    hemiIntensity: 0.9 * style.ambient * (1 - 0.35 * low),
    // The fill casts no shadow, so at a low sun it would flatten the long shadows: let it go.
    // (Only the maquette's studio uses it; the styled looks take their shade light from the sky.)
    fillIntensity: 0.35 * style.ambient * (1 - 0.8 * low),
    background: mixHex(style.sky, morning ? '#f6cfae' : '#eda77e', Math.pow(low, 1.6) * (dark ? 0.22 : 0.55)),
    ground: mixHex(style.ground, morning ? '#e9c7a6' : '#d99a72', Math.pow(low, 1.6) * (dark ? 0.1 : 0.25)),
  };
}
