/**
 * Validation + geometry helpers for furniture definitions that arrive from
 * outside the static catalog (AI-built product models, imported plan files,
 * shared links). Everything here is pure — no store, no three.js.
 */
import type { FurnitureDef, Part, PartShape } from './catalog';
import type { CustomItem, ProductSource } from './types';

export const MAX_PARTS = 80;
const SHAPES: readonly PartShape[] = ['box', 'rbox', 'cylinder', 'cone', 'sphere', 'torus'];
const FALLBACK_COLOR = '#cfc8b8';

function clampNum(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

function optNum(v: unknown, lo: number, hi: number): number | undefined {
  return clampNum(v, lo, hi) ?? undefined;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Accepts #rgb / #rrggbb only — anything else becomes a neutral maquette tone. */
export function sanitizeColor(v: unknown): string {
  if (typeof v !== 'string') return FALLBACK_COLOR;
  const t = v.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t.toLowerCase() : FALLBACK_COLOR;
}

/** Coerce one raw part into a renderable Part, or null if it can't be salvaged. */
export function sanitizePart(raw: unknown): Part | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const shape = r.shape as PartShape;
  if (!SHAPES.includes(shape)) return null;
  const x = clampNum(r.x, -5, 5);
  const y = clampNum(r.y, -1, 6);
  const z = clampNum(r.z, -5, 5);
  if (x === null || y === null || z === null) return null;

  const part: Part = { shape, x: round4(x), y: round4(y), z: round4(z), color: sanitizeColor(r.color) };
  const w = optNum(r.w, 0.002, 8);
  const h = optNum(r.h, 0.002, 6);
  const d = optNum(r.d, 0.002, 8);
  const rad = optNum(r.r, 0.002, 4);
  const r2 = optNum(r.r2, 0, 4);

  switch (shape) {
    case 'box':
    case 'rbox': {
      if (w === undefined || h === undefined || d === undefined) return null;
      Object.assign(part, { w: round4(w), h: round4(h), d: round4(d) });
      if (shape === 'rbox') {
        const bevel = optNum(r.bevel, 0, Math.min(w, h, d) / 2) ?? Math.min(w, h, d) * 0.15;
        part.bevel = round4(bevel);
      }
      break;
    }
    case 'cylinder': {
      if (rad === undefined || h === undefined) return null;
      Object.assign(part, { r: round4(rad), h: round4(h) });
      if (r2 !== undefined) part.r2 = round4(r2);
      break;
    }
    case 'cone': {
      if (rad === undefined || h === undefined) return null;
      Object.assign(part, { r: round4(rad), h: round4(h) });
      break;
    }
    case 'sphere': {
      if (w !== undefined && h !== undefined && d !== undefined) {
        Object.assign(part, { w: round4(w), h: round4(h), d: round4(d) });
      } else if (rad !== undefined) {
        part.r = round4(rad);
      } else return null;
      break;
    }
    case 'torus': {
      if (rad === undefined) return null;
      part.r = round4(rad);
      part.r2 = round4(Math.max(0.002, Math.min(r2 ?? rad * 0.15, rad)));
      break;
    }
  }

  if (Array.isArray(r.rot) && r.rot.length === 3) {
    const rot = r.rot.map((a) => clampNum(a, -360, 360) ?? 0) as [number, number, number];
    if (rot.some((a) => Math.abs(a) > 1e-6)) part.rot = rot;
  }
  const rough = optNum(r.rough, 0, 1);
  const metal = optNum(r.metal, 0, 1);
  const glow = optNum(r.glow, 0, 2);
  const opacity = optNum(r.opacity, 0.05, 1);
  if (rough !== undefined) part.rough = rough;
  if (metal !== undefined && metal > 0) part.metal = metal;
  if (glow !== undefined && glow > 0) part.glow = glow;
  if (opacity !== undefined && opacity < 1) part.opacity = opacity;
  return part;
}

/** Coerce a raw definition (label, footprint, parts). Null when nothing usable remains. */
export function sanitizeDef(raw: unknown): FurnitureDef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const w = clampNum(r.w, 0.03, 8);
  const d = clampNum(r.d, 0.03, 8);
  const h = clampNum(r.h, 0.01, 5);
  if (w === null || d === null || h === null) return null;
  const parts = (Array.isArray(r.parts) ? r.parts : [])
    .slice(0, MAX_PARTS)
    .map(sanitizePart)
    .filter((p): p is Part => p !== null);
  if (parts.length === 0) return null;
  const label =
    typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : 'Custom item';
  return { label, w: round4(w), d: round4(d), h: round4(h), parts };
}

function cleanStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function sanitizeSource(raw: unknown): ProductSource | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const url = cleanStr(r.url, 600);
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const image = cleanStr(r.image, 600);
  return {
    url,
    title: cleanStr(r.title, 300),
    brand: cleanStr(r.brand, 80),
    price: cleanStr(r.price, 40),
    image: image && /^https?:\/\//i.test(image) ? image : undefined,
    asin: cleanStr(r.asin, 20),
    dims: cleanStr(r.dims, 160),
  };
}

/** Validate a stored custom item (plan import / shared link). */
export function sanitizeCustomItem(id: string, raw: unknown): CustomItem | null {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const def = sanitizeDef(raw);
  if (!def) return null;
  const r = raw as Record<string, unknown>;
  const item: CustomItem = {
    ...def,
    id,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
  };
  const source = sanitizeSource(r.source);
  if (source) item.source = source;
  return item;
}

export const newCustomId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

// ---------- geometry ----------

export interface Bounds3 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Half extents of a part's own (unrotated) bounding box. */
export function partHalfExtents(p: Part): [number, number, number] {
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

/** Rotate a local offset by the part's Euler angles (matches THREE.Euler order 'XYZ'). */
export function rotatePartOffset(
  v: [number, number, number],
  rot: [number, number, number] | undefined,
): [number, number, number] {
  if (!rot) return v;
  const [rx, ry, rz] = rot.map((a) => (a * Math.PI) / 180);
  let [x, y, z] = v;
  // matrix = Rx · Ry · Rz  →  apply Rz first
  let c = Math.cos(rz), s = Math.sin(rz);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(ry); s = Math.sin(ry);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(rx); s = Math.sin(rx);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
}

/** Axis-aligned bounds of a set of parts in the item's local frame (rotation-aware). */
export function partsBounds(parts: Part[]): Bounds3 {
  const b: Bounds3 = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };
  for (const p of parts) {
    const [hx, hy, hz] = partHalfExtents(p);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const [ox, oy, oz] = rotatePartOffset([sx * hx, sy * hy, sz * hz], p.rot);
      b.minX = Math.min(b.minX, p.x + ox); b.maxX = Math.max(b.maxX, p.x + ox);
      b.minY = Math.min(b.minY, p.y + oy); b.maxY = Math.max(b.maxY, p.y + oy);
      b.minZ = Math.min(b.minZ, p.z + oz); b.maxZ = Math.max(b.maxZ, p.z + oz);
    }
  }
  if (!Number.isFinite(b.minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  return b;
}

/**
 * Normalize a model so it sits on the floor, is centered on its footprint, and
 * its declared w/d/h match what the parts actually occupy. Optionally scales
 * the whole model so its bounds match a target size (real product dimensions).
 */
export function fitDef(def: FurnitureDef, target?: { w?: number; d?: number; h?: number }): FurnitureDef {
  let parts = def.parts;
  let b = partsBounds(parts);
  const size = () => ({ w: b.maxX - b.minX, h: b.maxY - b.minY, d: b.maxZ - b.minZ });

  if (target) {
    const s = size();
    const sx = target.w && s.w > 1e-6 ? target.w / s.w : 1;
    const sy = target.h && s.h > 1e-6 ? target.h / s.h : 1;
    const sz = target.d && s.d > 1e-6 ? target.d / s.d : 1;
    if (Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005 || Math.abs(sz - 1) > 0.005) {
      // Round primitives can only scale uniformly in their cross-section.
      const sr = Math.sqrt(sx * sz);
      parts = parts.map((p) => {
        const q: Part = { ...p, x: p.x * sx, y: p.y * sy, z: p.z * sz };
        if (p.shape === 'box' || p.shape === 'rbox' || (p.shape === 'sphere' && p.w !== undefined)) {
          q.w = (p.w ?? 0) * sx; q.h = (p.h ?? 0) * sy; q.d = (p.d ?? 0) * sz;
          if (q.bevel !== undefined) q.bevel = Math.min(q.bevel * Math.min(sx, sy, sz), Math.min(q.w, q.h, q.d) / 2);
        } else if (p.shape === 'sphere') {
          q.r = (p.r ?? 0) * Math.cbrt(sx * sy * sz);
        } else if (p.shape === 'torus') {
          q.r = (p.r ?? 0) * sr; q.r2 = (p.r2 ?? 0) * Math.min(sr, sy);
        } else {
          q.r = (p.r ?? 0) * sr; q.h = (p.h ?? 0) * sy;
          if (p.r2 !== undefined) q.r2 = p.r2 * sr;
        }
        return q;
      });
      b = partsBounds(parts);
    }
  }

  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const lift = -b.minY;
  if (Math.abs(cx) > 1e-4 || Math.abs(cz) > 1e-4 || Math.abs(lift) > 1e-4) {
    parts = parts.map((p) => ({ ...p, x: p.x - cx, y: p.y + lift, z: p.z - cz }));
  }
  const s = size();
  return {
    label: def.label,
    w: round4(Math.max(0.03, s.w)),
    d: round4(Math.max(0.03, s.d)),
    h: round4(Math.max(0.01, s.h)),
    parts: parts.map((p) => ({ ...p, x: round4(p.x), y: round4(p.y), z: round4(p.z) })),
  };
}
