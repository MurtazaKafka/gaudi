/**
 * Everything the file writers need to know about a plan, worked out once:
 * the wall body, rooms with their names and sizes, openings as cut, furniture
 * with plan symbols, and the exterior dimension chains. All in plan meters
 * (+x east, +y south). Pure: no store, no DOM.
 */
import { FURNITURE, customId, isBuiltinKind, isCustomKind, type FurnitureDef, type FurnitureKind } from '../catalog';
import { pointInPolygon } from '../geometry';
import { detectRooms } from '../rooms';
import { liftOf, restOf } from '../stacking';
import type { PlanData, PlanSettings, Point, ProductSource, Units } from '../types';
import { buildWallBody, loopArea, type WallBody, type WallGap } from './walls';

export interface RoomInfo {
  key: string;
  /** The given name, or "Room 3". */
  name: string;
  named: boolean;
  /** Along wall centerlines. */
  polygon: Point[];
  /** Inside face of the walls, when it could be worked out. */
  net: Point[] | null;
  /** m², to wall centerlines — the figure the app shows. */
  area: number;
  /** A point safely inside the room, for its label. */
  labelAt: Point;
  /** Bounding box, m. */
  width: number;
  depth: number;
  doors: number;
  windows: number;
}

/** Plan linework for one item, in plan meters. */
export type Sym =
  | { k: 'poly'; pts: Point[]; closed: boolean; light?: boolean; dash?: boolean }
  | { k: 'circle'; c: Point; r: number; light?: boolean; dash?: boolean };

export interface FurnitureInfo {
  id: string;
  kind: FurnitureKind;
  /** Catalog or product name. */
  label: string;
  /** The item's own annotation on the plan, if any. */
  tag?: string;
  x: number;
  y: number;
  rotation: number;
  /** How high its base stands: 0 on the floor, the table top for something on a table (stacking.ts). */
  z: number;
  w: number;
  d: number;
  h: number;
  source?: ProductSource;
  symbol: Sym[];
}

export interface ProductRow {
  id: string;
  label: string;
  w: number;
  d: number;
  h: number;
  /** How many are placed on the plan. */
  count: number;
  source: ProductSource;
}

export type Side = 'N' | 'E' | 'S' | 'W';

/** A string of dimensions along one side: positions on that side's axis (x for N/S, y for E/W). */
export interface DimChain {
  side: Side;
  stops: number[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlanModel {
  name: string;
  units: Units;
  settings: PlanSettings;
  body: WallBody;
  /** Outer faces of the wall body. */
  bounds: Bounds;
  /** Extent of the wall centerlines — what the overall dimensions measure. */
  axes: Bounds;
  rooms: RoomInfo[];
  openings: WallGap[];
  furniture: FurnitureInfo[];
  products: ProductRow[];
  chains: DimChain[];
  /** m² */ totalArea: number;
}

const MISSING: FurnitureDef = { label: 'Item', w: 0.6, d: 0.6, h: 0.6, parts: [] };

/** Resolve a kind against the plan itself (not the live store), so any plan can be exported. */
export function defOf(plan: PlanData, kind: FurnitureKind): FurnitureDef {
  if (isBuiltinKind(kind)) return FURNITURE[kind];
  if (isCustomKind(kind)) return plan.customItems?.[customId(kind)] ?? MISSING;
  return MISSING;
}

// ---------- furniture symbols ----------

const P = (x: number, y: number): Point => ({ x, y });

function rect(x0: number, y0: number, x1: number, y1: number, light = false): Sym {
  return { k: 'poly', pts: [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], closed: true, ...(light ? { light } : {}) };
}

function line(x0: number, y0: number, x1: number, y1: number, light = false): Sym {
  return { k: 'poly', pts: [P(x0, y0), P(x1, y1)], closed: false, ...(light ? { light } : {}) };
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Sym {
  const pts: Point[] = [];
  for (let i = 0; i < 32; i++) {
    const t = (i / 32) * Math.PI * 2;
    pts.push(P(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry));
  }
  return { k: 'poly', pts, closed: true };
}

function roundRect(x0: number, y0: number, x1: number, y1: number, r: number): Sym {
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const pts: Point[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 6; i++) {
      const t = from + (i / 6) * (Math.PI / 2);
      pts.push(P(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr));
    }
  };
  corner(x1 - rr, y0 + rr, -Math.PI / 2);
  corner(x1 - rr, y1 - rr, 0);
  corner(x0 + rr, y1 - rr, Math.PI / 2);
  corner(x0 + rr, y0 + rr, Math.PI);
  return { k: 'poly', pts, closed: true };
}

/**
 * Plan symbol in the item's own frame: meters, center at 0,0, front toward +y.
 * Mirrors the linework drawn on the canvas; custom items show their footprint.
 */
export function furnitureSymbol(kind: FurnitureKind, w: number, d: number): Sym[] {
  const hw = w / 2;
  const hd = d / 2;
  const base = rect(-hw, -hd, hw, hd);
  const circle = (r: number, extra: Partial<Sym> = {}): Sym => ({ k: 'circle', c: P(0, 0), r, ...extra }) as Sym;
  switch (kind) {
    case 'bed_double':
    case 'bed_single':
      return [base, line(-hw, -hd + 0.55, hw, -hd + 0.55), line(-hw, -hd + 0.8, hw, -hd + 0.8, true)];
    case 'sofa':
    case 'armchair':
      return [
        base,
        line(-hw, -hd + 0.16, hw, -hd + 0.16),
        line(-hw + 0.14, -hd + 0.16, -hw + 0.14, hd),
        line(hw - 0.14, -hd + 0.16, hw - 0.14, hd),
      ];
    case 'chair':
      return [base, line(-hw, -hd + 0.08, hw, -hd + 0.08)];
    case 'dining_table':
    case 'coffee_table':
    case 'desk':
    case 'event_table':
      return [base];
    case 'stage':
      return [base, rect(-hw + 0.15, -hd + 0.15, hw - 0.15, hd - 0.15, true)];
    case 'speaker':
      return [base, { k: 'circle', c: P(0, 0.02), r: Math.min(hw, hd) * 0.55 }];
    case 'mic':
      return [circle(hw * 0.8), circle(hw * 0.28, { light: true })];
    case 'trash_bin':
      return [circle(hw), line(-hw * 0.45, 0, hw * 0.45, 0, true)];
    case 'rug':
      return [circle(hw, { dash: true })];
    case 'plant':
      return [circle(hw), circle(hw * 0.45, { light: true })];
    case 'toilet':
      return [rect(-hw, -hd, hw, -hd + 0.16), ellipse(0, 0.08, 0.19, 0.24)];
    case 'bathroom_sink':
      return [base, ellipse(0, 0.02, Math.max(0.02, hw - 0.08), Math.max(0.02, hd - 0.1))];
    case 'kitchen_sink':
      return [base, rect(-hw + 0.08, -hd + 0.1, hw - 0.08, hd - 0.1)];
    case 'bathtub':
      return [base, roundRect(-hw + 0.09, -hd + 0.09, hw - 0.09, hd - 0.09, 0.18)];
    case 'stove':
      return [
        base,
        { k: 'circle', c: P(-0.14, -0.14), r: 0.09 },
        { k: 'circle', c: P(0.14, -0.14), r: 0.09 },
        { k: 'circle', c: P(-0.14, 0.14), r: 0.09 },
        { k: 'circle', c: P(0.14, 0.14), r: 0.09 },
      ];
    case 'wardrobe':
      return [base, line(0, -hd, 0, hd)];
    default:
      return [base, line(-hw, -hd, hw, hd, true)];
  }
}

function placeSymbol(symbol: Sym[], x: number, y: number, rotation: number): Sym[] {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const tx = (p: Point): Point => ({ x: x + p.x * c - p.y * s, y: y + p.x * s + p.y * c });
  return symbol.map((sym) => (sym.k === 'circle' ? { ...sym, c: tx(sym.c) } : { ...sym, pts: sym.pts.map(tx) }));
}

// ---------- rooms ----------

/** A point inside the polygon near its centroid (the centroid itself unless the room wraps around it). */
function insidePoint(polygon: Point[], centroid: Point): Point {
  if (pointInPolygon(centroid, polygon)) return centroid;
  const xs: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a.y > centroid.y !== b.y > centroid.y) {
      xs.push(a.x + ((centroid.y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  xs.sort((p, q) => p - q);
  let best: Point | null = null;
  let bestW = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > bestW) {
      bestW = xs[i + 1] - xs[i];
      best = { x: (xs[i] + xs[i + 1]) / 2, y: centroid.y };
    }
  }
  return best ?? centroid;
}

// ---------- dimension chains ----------

/**
 * The joints you would measure to from one side of the building: those with
 * nothing between them and that side. Returned as sorted positions along the side.
 */
function sideStops(body: WallBody, side: Side): number[] {
  const { nodes, edges } = body.graph;
  // Rotate so the side being looked from is always "up" (−v), reading along u.
  const uv = (p: Point): { u: number; v: number } =>
    side === 'N' ? { u: p.x, v: p.y } : side === 'S' ? { u: p.x, v: -p.y } : side === 'W' ? { u: p.y, v: p.x } : { u: p.y, v: -p.x };
  const pts = nodes.map(uv);
  const stops: number[] = [];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    let hidden = false;
    for (const e of edges) {
      const a = pts[e.a];
      const b = pts[e.b];
      if (e.a === k || e.b === k) {
        const o = e.a === k ? b : a;
        if (Math.abs(o.u - p.u) < 0.01 && o.v < p.v - 0.01) hidden = true; // a wall runs straight out from here
      } else if (p.u >= Math.min(a.u, b.u) - 1e-6 && p.u <= Math.max(a.u, b.u) + 1e-6) {
        const v = Math.abs(b.u - a.u) < 1e-6 ? Math.min(a.v, b.v) : a.v + ((p.u - a.u) / (b.u - a.u)) * (b.v - a.v);
        if (v < p.v - 0.01) hidden = true;
      }
      if (hidden) break;
    }
    if (!hidden) stops.push(p.u);
  }
  stops.sort((a, b) => a - b);
  return stops.filter((s, i) => i === 0 || s - stops[i - 1] > 0.02);
}

const sameStops = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.02);

// ---------- the model ----------

export function buildModel(plan: PlanData): PlanModel {
  const settings = plan.settings;
  const body = buildWallBody(plan.walls, plan.openings, settings.wallThickness);
  const half = body.thickness / 2;

  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const loop of body.loops) {
    for (const p of loop) {
      bounds.minX = Math.min(bounds.minX, p.x);
      bounds.minY = Math.min(bounds.minY, p.y);
      bounds.maxX = Math.max(bounds.maxX, p.x);
      bounds.maxY = Math.max(bounds.maxY, p.y);
    }
  }
  const axes: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const e of body.graph.edges) {
    for (const p of [body.graph.nodes[e.a], body.graph.nodes[e.b]]) {
      axes.minX = Math.min(axes.minX, p.x);
      axes.minY = Math.min(axes.minY, p.y);
      axes.maxX = Math.max(axes.maxX, p.x);
      axes.maxY = Math.max(axes.maxY, p.y);
    }
  }
  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.minY = bounds.maxX = bounds.maxY = 0;
    axes.minX = axes.minY = axes.maxX = axes.maxY = 0;
  }

  // Rooms. The net outline is the matching inner loop of the wall body drawn without openings.
  const solid = buildWallBody(plan.walls, [], settings.wallThickness);
  const detected = detectRooms(plan.walls);
  let unnamed = 0;
  const rooms: RoomInfo[] = detected.map((r) => {
    const given = (plan.roomNames?.[r.key] ?? '').trim();
    const labelAt = insidePoint(r.polygon, r.centroid);
    let net: Point[] | null = null;
    if (solid.clean) {
      let best = Infinity;
      for (const loop of solid.loops) {
        const a = Math.abs(loopArea(loop));
        if (a < best && a <= r.area + 1e-6 && pointInPolygon(labelAt, loop)) {
          best = a;
          net = loop;
        }
      }
    }
    const xs = r.polygon.map((p) => p.x);
    const ys = r.polygon.map((p) => p.y);
    return {
      key: r.key,
      name: given || `Room ${++unnamed}`,
      named: !!given,
      polygon: r.polygon,
      net,
      area: r.area,
      labelAt,
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...ys) - Math.min(...ys),
      doors: 0,
      windows: 0,
    };
  });
  for (const g of body.gaps) {
    for (const sign of [1, -1]) {
      const probe = {
        x: g.center.x + g.normal.x * sign * (half + 0.15),
        y: g.center.y + g.normal.y * sign * (half + 0.15),
      };
      const room = rooms.find((r) => pointInPolygon(probe, r.polygon));
      if (room) {
        if (g.type === 'door') room.doors++;
        else room.windows++;
      }
    }
  }

  const furniture: FurnitureInfo[] = [];
  const placed = new Map<string, number>();
  const rest = restOf(plan.furniture, (kind) => defOf(plan, kind));
  for (const f of plan.furniture) {
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.rotation)) continue;
    const def = defOf(plan, f.kind);
    const custom = isCustomKind(f.kind) ? plan.customItems?.[customId(f.kind)] : undefined;
    if (custom) placed.set(custom.id, (placed.get(custom.id) ?? 0) + 1);
    furniture.push({
      id: f.id,
      kind: f.kind,
      label: def.label,
      ...(f.label ? { tag: f.label } : {}),
      x: f.x,
      y: f.y,
      rotation: f.rotation,
      z: liftOf(rest, f.id),
      w: def.w,
      d: def.d,
      h: def.h,
      ...(custom?.source ? { source: custom.source } : {}),
      symbol: placeSymbol(furnitureSymbol(f.kind, def.w, def.d), f.x, f.y, f.rotation),
    });
  }

  const products: ProductRow[] = Object.values(plan.customItems ?? {})
    .filter((c) => !!c.source?.url)
    .map((c) => ({
      id: c.id,
      label: c.label,
      w: c.w,
      d: c.d,
      h: c.h,
      count: placed.get(c.id) ?? 0,
      source: c.source as ProductSource,
    }));

  // Overall dimensions sit on the north and west; the per-segment chains go
  // there too, and on the other two sides only where they would read differently.
  const chains: DimChain[] = [];
  if (body.graph.edges.length > 0) {
    const n = sideStops(body, 'N');
    const s = sideStops(body, 'S');
    const w = sideStops(body, 'W');
    const e = sideStops(body, 'E');
    if (n.length > 2) chains.push({ side: 'N', stops: n });
    if (s.length > 2 && !sameStops(n, s)) chains.push({ side: 'S', stops: s });
    if (w.length > 2) chains.push({ side: 'W', stops: w });
    if (e.length > 2 && !sameStops(w, e)) chains.push({ side: 'E', stops: e });
  }

  return {
    name: plan.name,
    units: settings.units,
    settings,
    body,
    bounds,
    axes,
    rooms,
    openings: body.gaps,
    furniture,
    products,
    chains,
    totalArea: rooms.reduce((sum, r) => sum + r.area, 0),
  };
}

/** A door as drawn: hinged at the jamb nearer the wall's start, opening to the −normal side (as on the canvas). */
export interface DoorSwing {
  gap: WallGap;
  hinge: Point;
  /** Free end of the open leaf. */
  tip: Point;
  /** Where the leaf lands when shut. */
  end: Point;
}

export function doorSwings(model: PlanModel): DoorSwing[] {
  const half = model.body.thickness / 2;
  return model.openings
    .filter((g) => g.type === 'door')
    .map((g) => {
      const w = g.width;
      const hinge = {
        x: g.center.x - g.dir.x * (w / 2) - g.normal.x * half,
        y: g.center.y - g.dir.y * (w / 2) - g.normal.y * half,
      };
      return {
        gap: g,
        hinge,
        tip: { x: hinge.x - g.normal.x * w, y: hinge.y - g.normal.y * w },
        end: { x: hinge.x + g.dir.x * w, y: hinge.y + g.dir.y * w },
      };
    });
}

/** Everything drawn: walls, door swings and furniture. */
export function drawnExtent(model: PlanModel, swings: DoorSwing[] = doorSwings(model)): Bounds {
  const ext: Bounds = { ...model.bounds };
  const grow = (x: number, y: number) => {
    ext.minX = Math.min(ext.minX, x);
    ext.minY = Math.min(ext.minY, y);
    ext.maxX = Math.max(ext.maxX, x);
    ext.maxY = Math.max(ext.maxY, y);
  };
  for (const d of swings) {
    grow(d.tip.x, d.tip.y);
    grow(d.end.x, d.end.y);
    grow(d.tip.x + d.gap.dir.x * d.gap.width, d.tip.y + d.gap.dir.y * d.gap.width);
  }
  for (const f of model.furniture) {
    for (const s of f.symbol) {
      if (s.k === 'circle') {
        grow(s.c.x - s.r, s.c.y - s.r);
        grow(s.c.x + s.r, s.c.y + s.r);
      } else for (const p of s.pts) grow(p.x, p.y);
    }
  }
  return ext;
}
