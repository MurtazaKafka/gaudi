/**
 * Where a product comes to rest. Dropped onto a table, counter or nightstand
 * on the plan, it stands on the top instead of on the floor underneath.
 * Worked out from x/y alone whenever the model is built, so nothing is
 * stored: move the table away and the product is back on the floor.
 * Pure — no store, no three.js.
 */
import { furnitureDef, isBuiltinKind, isCustomKind, type BuiltinKind, type FurnitureDef, type Part } from './catalog';
import type { Furniture } from './types';

/**
 * Catalog pieces with a top to put things on: the top's height as a share of
 * the piece's `h` (their models are scaled to it). Beds, sofas, chairs and
 * shelves are left out — a product dropped on them stays where it is put.
 */
const SURFACE: Partial<Record<BuiltinKind, number>> = {
  dining_table: 1,
  desk: 1,
  coffee_table: 1,
  event_table: 1,
  nightstand: 1,
  counter: 1,
  stove: 1,
  stage: 1,
  tv_stand: 0.45, // the cabinet, not the screen on it
};

/** Parts thinner than this (legs, stems, a faucet) are not something to stand on. */
const MIN_PART = 0.05;
const DEG = Math.PI / 180;

interface Placed {
  f: Furniture;
  def: FurnitureDef;
  area: number;
}

/** Plan point → the item's local frame (x right, z toward its front), as house.ts places it. */
function toLocal(f: Furniture, x: number, y: number): { x: number; z: number } {
  const dx = x - f.x;
  const dy = y - f.y;
  const c = Math.cos(f.rotation);
  const s = Math.sin(f.rotation);
  return { x: dx * c + dy * s, z: -dx * s + dy * c };
}

/** Half-extents of a part before its own rotation. */
function halfSize(p: Part): [number, number, number] {
  switch (p.shape) {
    case 'box':
    case 'rbox':
      return [(p.w ?? 0) / 2, (p.h ?? 0) / 2, (p.d ?? 0) / 2];
    case 'cylinder': {
      const r = Math.max(p.r ?? 0, p.r2 ?? 0);
      return [r, (p.h ?? 0) / 2, r];
    }
    case 'cone':
      return [p.r ?? 0, (p.h ?? 0) / 2, p.r ?? 0];
    case 'sphere':
      return p.w !== undefined && p.h !== undefined && p.d !== undefined
        ? [p.w / 2, p.h / 2, p.d / 2]
        : [p.r ?? 0, p.r ?? 0, p.r ?? 0];
    case 'torus': {
      const r = (p.r ?? 0) + (p.r2 ?? 0);
      return [r, p.r2 ?? 0, r];
    }
  }
}

/** A part's box in the item's frame: x/z extents and its top. Rotated parts get the box around them. */
function partBounds(p: Part): { x0: number; x1: number; z0: number; z1: number; top: number } {
  let [hx, hy, hz] = halfSize(p);
  if (p.rot && p.rot.some((a) => a !== 0)) {
    // three's 'XYZ' Euler: v' = Rx · Ry · Rz · v
    const [a, b, c] = p.rot.map((d) => d * DEG);
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          let x = sx * hx;
          let y = sy * hy;
          let z = sz * hz;
          [x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
          [x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)];
          [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
          mx = Math.max(mx, Math.abs(x));
          my = Math.max(my, Math.abs(y));
          mz = Math.max(mz, Math.abs(z));
        }
      }
    }
    [hx, hy, hz] = [mx, my, mz];
  }
  return { x0: p.x - hx, x1: p.x + hx, z0: p.z - hz, z1: p.z + hz, top: p.y + hy };
}

/** How high `support`'s top is at plan point (x, y), or null when the point is not over it. */
function surfaceAt(support: Placed, x: number, y: number): number | null {
  const { f, def } = support;
  const p = toLocal(f, x, y);
  if (Math.abs(p.x) > def.w / 2 || Math.abs(p.z) > def.d / 2) return null;
  if (isBuiltinKind(f.kind)) {
    const share = SURFACE[f.kind];
    return share === undefined ? null : def.h * share;
  }
  // A product's own parts are what is drawn, so its top is the highest one under the point.
  let top: number | null = null;
  for (const part of def.parts) {
    const b = partBounds(part);
    if (b.x1 - b.x0 < MIN_PART || b.z1 - b.z0 < MIN_PART) continue;
    if (p.x < b.x0 || p.x > b.x1 || p.z < b.z0 || p.z > b.z1) continue;
    top = Math.max(top ?? 0, b.top);
  }
  return top;
}

/**
 * How far above the floor each product stands (m), for the ones resting on
 * something: a product whose center is over a table top, a counter or a
 * larger product sits on its top, stacked on whatever that sits on.
 * Catalog pieces always stand on the floor (a chair pushed under a table
 * stays there). Items not in the map are on the floor.
 */
export function restHeights(furniture: readonly Furniture[]): Map<string, number> {
  const placed: Placed[] = [];
  for (const f of furniture) {
    if (![f.x, f.y, f.rotation].every(Number.isFinite)) continue;
    const def = furnitureDef(f.kind);
    if (!def || !(def.w > 0) || !(def.d > 0) || !Array.isArray(def.parts)) continue;
    placed.push({ f, def, area: def.w * def.d });
  }
  const rest = new Map<string, number>();
  if (!placed.some((p) => isCustomKind(p.f.kind))) return rest;

  // Larger things first, so a support's own height is known before anything is put on it.
  placed.sort((a, b) => b.area - a.area);
  for (let i = 0; i < placed.length; i++) {
    const item = placed[i];
    if (!isCustomKind(item.f.kind)) continue;
    let best = 0;
    for (let j = 0; j < i; j++) {
      const support = placed[j];
      // Only something bigger holds it — a large rug laid under a coffee table stays on the floor.
      if (support.area <= item.area) continue;
      const top = surfaceAt(support, item.f.x, item.f.y);
      if (top === null) continue;
      best = Math.max(best, (rest.get(support.f.id) ?? 0) + top);
    }
    if (best > 0) rest.set(item.f.id, Math.round(best * 1000) / 1000);
  }
  return rest;
}
