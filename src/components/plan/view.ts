/**
 * The plan viewport: world meters ↔ screen pixels, zoom-to-fit, grid lines.
 * Pure — no store, no DOM.
 */
import type { Point, Wall } from '../../types';
import { rectCorners } from '../../geometry';

export interface View {
  /** px per meter */ scale: number;
  /** px */ tx: number;
  /** px */ ty: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_SCALE = 16;
export const MAX_SCALE = 320;
export const DEFAULT_SCALE = 60;
/** Zoom-to-fit never zooms in past this, so a single small room doesn't fill the screen. */
export const FIT_MAX_SCALE = 110;
/** px kept clear around a fitted plan (room for banners and labels). */
export const FIT_PAD = 72;
export const SNAP_RADIUS_PX = 12;

export const toWorld = (v: View, sx: number, sy: number): Point => ({
  x: (sx - v.tx) / v.scale,
  y: (sy - v.ty) / v.scale,
});

export const toScreen = (v: View, p: Point): Point => ({
  x: p.x * v.scale + v.tx,
  y: p.y * v.scale + v.ty,
});

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Zoom by `factor` keeping the world point under screen (sx, sy) fixed. */
export function zoomAbout(v: View, sx: number, sy: number, factor: number): View {
  const scale = clampScale(v.scale * factor);
  const w = toWorld(v, sx, sy);
  return { scale, tx: sx - w.x * scale, ty: sy - w.y * scale };
}

export interface Footprint {
  x: number;
  y: number;
  w: number;
  d: number;
  rotation: number;
}

/** Extent of everything drawn (walls and furniture footprints). Null for an empty plan. */
export function planBounds(walls: Wall[], items: Footprint[]): Bounds | null {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (p: Point) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    b.minX = Math.min(b.minX, p.x);
    b.maxX = Math.max(b.maxX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxY = Math.max(b.maxY, p.y);
  };
  for (const w of walls) {
    add(w.a);
    add(w.b);
  }
  for (const f of items) rectCorners(f.x, f.y, f.w, f.d, f.rotation).forEach(add);
  return Number.isFinite(b.minX) ? b : null;
}

/** The view that centers `bounds` in a `size` viewport. An empty plan centers the origin. */
export function fitView(bounds: Bounds | null, size: Size, pad = FIT_PAD): View {
  if (!bounds) return { scale: DEFAULT_SCALE, tx: size.w / 2, ty: size.h / 2 };
  const bw = Math.max(bounds.maxX - bounds.minX, 0.5);
  const bh = Math.max(bounds.maxY - bounds.minY, 0.5);
  // Small viewports give up padding before they give up the plan.
  const p = Math.min(pad, size.w / 5, size.h / 5);
  const fit = Math.min((size.w - 2 * p) / bw, (size.h - 2 * p) / bh);
  const scale = Math.min(FIT_MAX_SCALE, clampScale(fit));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, tx: size.w / 2 - cx * scale, ty: size.h / 2 - cy * scale };
}

export interface GridLines {
  minor: number[][];
  major: number[][];
  axes: number[][];
}

const MAX_GRID_LINES = 400;

export function buildGridLines(view: View, size: Size, gridSize: number): GridLines {
  const minor: number[][] = [];
  const major: number[][] = [];
  const axes: number[][] = [];
  if (size.w <= 0 || size.h <= 0 || !(view.scale > 0)) return { minor, major, axes };

  const x0 = (0 - view.tx) / view.scale;
  const x1 = (size.w - view.tx) / view.scale;
  const y0 = (0 - view.ty) / view.scale;
  const y1 = (size.h - view.ty) / view.scale;

  // A bad grid size (0, negative, NaN, microscopic) must never hang the loop.
  let step = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 0.5;
  while (Math.max(x1 - x0, y1 - y0) / step > MAX_GRID_LINES) step *= 2;

  const showMinor = step * view.scale >= 7;
  const isMajor = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;

  for (let i = Math.floor(x0 / step); i <= Math.ceil(x1 / step); i++) {
    const x = i * step;
    const pts = [x, y0, x, y1];
    if (i === 0) axes.push(pts);
    else if (isMajor(x)) major.push(pts);
    else if (showMinor) minor.push(pts);
  }
  for (let j = Math.floor(y0 / step); j <= Math.ceil(y1 / step); j++) {
    const y = j * step;
    const pts = [x0, y, x1, y];
    if (j === 0) axes.push(pts);
    else if (isMajor(y)) major.push(pts);
    else if (showMinor) minor.push(pts);
  }
  return { minor, major, axes };
}
