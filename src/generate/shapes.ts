/**
 * Preset footprints as real outlines: each shape sized for a floor area, on
 * the half-metre grid, centred on the origin. The same outlines are drawn on
 * the canvas ("Draw outline") and handed to the footprint filler. Pure.
 */
import type { Point } from '../types';
import type { ShapeId } from './brief';
import { unionOutline, type Rect } from './outline';

const g = (v: number) => Math.round(v * 2) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type PresetShape = Exclude<ShapeId, 'any'>;

export interface Preset {
  shape: PresetShape;
  /** which proportions: 'even', 'long', 'tall', … */
  variant: string;
  rects: Rect[];
  polygon: Point[];
  /** m² */
  area: number;
  box: { w: number; h: number };
}

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const turn = (rects: Rect[]): Rect[] => rects.map((r) => ({ x: r.y, y: r.x, w: r.h, h: r.w }));

/** The rectangles of one shape at one set of proportions, north-west corner at the origin; null if they don't work at this size. */
function build(shape: PresetShape, A: number, variant: string): Rect[] | null {
  const d0 = clamp(g(Math.sqrt(A) * 0.48), 4.5, 7.5);
  switch (shape) {
    case 'rect': {
      const h = g(Math.sqrt(A / (variant === 'wide' ? 1.75 : 1.35)));
      return [R(0, 0, g(A / h), h)];
    }
    case 'bar': {
      const d = clamp(g(Math.sqrt(A / (variant === 'slim' ? 4.4 : 3.4))), 4.5, 7.5);
      const w = g(A / d);
      return w / d >= 2.3 ? [R(0, 0, w, d)] : null;
    }
    case 'L': {
      // A bar across the south with an arm running north from its west end.
      const d = variant === 'tall' ? d0 + 0.5 : d0;
      const aw = variant === 'long' ? d0 + 0.5 : d0;
      const share = variant === 'long' ? 0.7 : variant === 'tall' ? 0.46 : 0.58;
      const w = g((share * A) / d);
      const a = g((A - w * d) / aw);
      if (a < 3 || w < aw + 3) return null;
      return [R(0, 0, aw, a), R(0, a, w, d)];
    }
    case 'T': {
      const d = d0;
      const sw = variant === 'long' ? d0 : d0 + 0.5;
      const w = g(((variant === 'long' ? 0.68 : 0.58) * A) / d);
      const a = g((A - w * d) / sw);
      if (a < 3 || w < sw + 5) return null;
      return [R(g((w - sw) / 2), 0, sw, a), R(0, a, w, d)];
    }
    case 'U':
    case 'C': {
      const d = clamp(d0 - (variant === 'deep' ? 0.5 : 0), 4, 7);
      const dw = clamp(g(d0 - 0.5), 4, 6);
      let w = Math.max(2 * dw + 3.5, g(((variant === 'deep' ? 0.42 : 0.5) * A) / d));
      let a = g((A - w * d) / (2 * dw));
      if (a < 3) {
        a = 3;
        w = Math.max(2 * dw + 3, g((A - 2 * dw * a) / d));
      }
      if (w < 2 * dw + 3) return null;
      const rects = [R(0, 0, dw, a), R(w - dw, 0, dw, a), R(0, a, w, d)];
      return shape === 'U' ? rects : turn(rects);
    }
    case 'H': {
      const lw = variant === 'wide' ? d0 + 0.5 : d0;
      const ch = clamp(g(d0 * 0.8), 3.5, 5);
      const cw = variant === 'wide' ? clamp(g(d0), 4, 6) : clamp(g(d0 * 0.75), 3.5, 5);
      const lh = g((A - cw * ch) / (2 * lw));
      if (lh < ch + 3) return null;
      const y0 = g((lh - ch) / 2);
      return [R(0, 0, lw, lh), R(lw, y0, cw, ch), R(lw + cw, 0, lw, lh)];
    }
    case 'Z': {
      const d = d0;
      const w = g(A / (2 * d));
      const shift = g(w * (variant === 'slip' ? 0.33 : 0.5));
      if (w < 6 || w - shift < 3) return null;
      return [R(shift, 0, w, d), R(0, d, w, d)];
    }
    case 'plus': {
      const d = d0;
      const sw = variant === 'broad' ? d0 + 1.5 : d0 + 0.5;
      const w = g(((variant === 'broad' ? 0.52 : 0.6) * A) / d);
      const sh = g((A - w * d) / (2 * sw));
      if (sh < 2.5 || w < sw + 5) return null;
      const x0 = g((w - sw) / 2);
      return [R(x0, 0, sw, sh), R(0, sh, w, d), R(x0, sh + d, sw, sh)];
    }
    case 'step': {
      const sw = clamp(g(Math.sqrt(A / 3 / (variant === 'steep' ? 1.2 : 1.6))), 4, 7.5);
      const mean = A / (3 * sw);
      const dh = Math.max(1.5, g(mean * (variant === 'steep' ? 0.4 : 0.28)));
      const h0 = g(mean - dh);
      if (h0 < 3) return null;
      return [0, 1, 2].map((i) => R(i * sw, (2 - i) * dh, sw, h0 + i * dh));
    }
  }
}

const VARIANTS: Record<PresetShape, string[]> = {
  rect: ['even', 'wide'],
  bar: ['even', 'slim'],
  L: ['even', 'long', 'tall'],
  T: ['even', 'long'],
  U: ['even', 'deep'],
  C: ['even', 'deep'],
  H: ['even', 'wide'],
  Z: ['even', 'slip'],
  plus: ['even', 'broad'],
  step: ['even', 'steep'],
};

function finish(shape: PresetShape, variant: string, raw: Rect[], want: number): Preset | null {
  // Smallest sizes can't always be met: a shape drawn a tenth off the asked area is not that shape at that size.
  if (Math.abs(raw.reduce((s, r) => s + r.w * r.h, 0) - want) > want * 0.08) return null;
  const minX = Math.min(...raw.map((r) => r.x));
  const minY = Math.min(...raw.map((r) => r.y));
  const maxX = Math.max(...raw.map((r) => r.x + r.w));
  const maxY = Math.max(...raw.map((r) => r.y + r.h));
  const dx = g((minX + maxX) / 2);
  const dy = g((minY + maxY) / 2);
  const rects = raw.map((r) => ({ x: r.x - dx, y: r.y - dy, w: r.w, h: r.h }));
  if (rects.some((r) => Math.min(r.w, r.h) < 2.5)) return null;
  const polygon = unionOutline(rects);
  if (!polygon) return null;
  return {
    shape,
    variant,
    rects,
    polygon,
    area: rects.reduce((s, r) => s + r.w * r.h, 0),
    box: { w: maxX - minX, h: maxY - minY },
  };
}

/** Every proportion of a shape that works at this floor area (the first is the default). */
export function presetOutlines(shape: PresetShape, area: number): Preset[] {
  const out: Preset[] = [];
  for (const variant of VARIANTS[shape]) {
    const raw = build(shape, area, variant);
    const p = raw && finish(shape, variant, raw, area);
    if (p && !out.some((o) => Math.abs(o.box.w - p.box.w) < 0.75 && Math.abs(o.box.h - p.box.h) < 0.75)) out.push(p);
  }
  return out;
}

/** The outline "Draw outline" puts on the canvas for a shape: at the asked area, or the nearest larger one the shape works at. */
export function presetOutline(shape: PresetShape, area: number): Preset | null {
  for (const k of [1, 1.1, 1.2, 1.35, 1.5, 1.75, 2]) {
    const p = presetOutlines(shape, area * k)[0];
    if (p) return p;
  }
  return null;
}
