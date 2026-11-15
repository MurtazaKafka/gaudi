/**
 * Plan → three.js objects. The one set of builders behind both the live
 * scene (mounted with <primitive>) and the GLB exporter, so what you export
 * is what you see.
 *
 * Every builder returns a Group of named meshes. Materials come from a
 * per-style kit that is created once and shared; only geometry is made fresh,
 * and `disposeGroup` frees it.
 */
import * as THREE from 'three';
import type { WallModel, WallPiece, PlacedOpening } from '../build';
import { buildWallModel } from '../build';
import { DOUBLE_DOOR_MIN, TRIPLE_WINDOW_MIN } from '../openingSizes';
import { detectRooms } from '../rooms';
import type { DetectedRoom } from '../rooms';
import { furnitureDef, isBuiltinKind } from '../catalog';
import type { Furniture, PlanData, PlanSettings, Point, RoofKind, Wall } from '../types';
import { openAirRooms } from './footprint';
import { buildItemGroup } from './partGeometry';
import { buildRoof } from './roof';
import type { RoofModel, RoofPart } from './roof';
import { buildRoofMeshes } from './roofMesh';
import { floorFor, furnitureTint, furniturePalette } from './styles';
import { buildModelItem } from './furnitureModels';
import type { FloorSpec, HouseStyle } from './styles';
import { floorTexture } from './textures';
import { tintFor, type TextureId } from './surfaces';
import { surfaceMaps } from './textureSet';
import { mixHex } from './sun';

// ---------- materials ----------

/** Every material a style needs, made once. */
export interface MaterialKit {
  style: HouseStyle;
  /** [interior, cladding, cap] — wall pieces index into these: faces indoors, faces outdoors, the cut top. */
  walls: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  trim: THREE.MeshStandardMaterial;
  door: THREE.MeshStandardMaterial;
  handle: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  ceiling: THREE.MeshStandardMaterial;
  roof: Record<RoofPart, THREE.MeshStandardMaterial>;
  edges: THREE.LineBasicMaterial | null;
  floor: (spec: FloorSpec) => THREE.MeshStandardMaterial;
  furniture: Map<string, THREE.MeshStandardMaterial>;
  tint: ((color: string) => string) | undefined;
}

const kits = new Map<string, MaterialKit>();

function named<T extends THREE.Material>(material: T, name: string): T {
  material.name = name;
  return material;
}

/** The shared material kit for a style (cached for the life of the page). */
export function materialKit(style: HouseStyle): MaterialKit {
  const hit = kits.get(style.id);
  if (hit) return hit;

  const std = (name: string, color: string, roughness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
    named(new THREE.MeshStandardMaterial({ color, roughness, ...extra }), name);

  /** A photographed surface tinted to read as `color` overall; flat colour when there is no photo (or no browser). */
  const surface = (
    name: string,
    color: string,
    roughness: number,
    tex: TextureId | undefined,
    extra: THREE.MeshStandardMaterialParameters = {},
  ) => {
    const maps = tex ? surfaceMaps(tex) : null;
    if (!tex || !maps) return std(name, color, roughness, extra);
    const m = std(name, '#ffffff', 1, { ...maps, ...extra });
    m.color.setRGB(...tintFor(color, tex));
    return m;
  };

  const floors = new Map<string, THREE.MeshStandardMaterial>();
  const kit: MaterialKit = {
    style,
    walls: [
      surface('wall', style.wall, 0.92, style.wallTex),
      surface('cladding', style.cladding, 0.9, style.claddingTex),
      std('wall-cap', style.cap, 0.92),
    ],
    trim: std('trim', style.trim, 0.7),
    door: surface('door', style.door, 0.6, style.id === 'maquette' ? undefined : 'walnut'),
    handle: std('handle', '#b9b5ac', 0.35, { metalness: 0.6 }),
    // Styled looks get glass that catches the sky; the maquette keeps its soft film.
    glass: std('glass', style.glass, style.id === 'maquette' ? 0.08 : 0.03, {
      transparent: true,
      opacity: style.id === 'maquette' ? style.glassOpacity : Math.min(0.6, style.glassOpacity + 0.14),
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.7,
    }),
    ceiling: std('ceiling', mixHex(style.wall, '#ffffff', 0.35), 1),
    roof: {
      roof: surface('roof', style.roof, 0.85, style.roofTex, { side: THREE.DoubleSide }),
      gable: surface('roof-gable', style.cladding, 0.9, style.claddingTex, { side: THREE.DoubleSide }),
      soffit: std('roof-soffit', style.trim, 0.9, { side: THREE.DoubleSide }),
    },
    edges: style.edges ? named(new THREE.LineBasicMaterial({ color: style.edges }), 'edges') : null,
    floor: (spec) => {
      const key = `${spec.kind}|${spec.color}|${spec.line}|${spec.rough}|${spec.tex ?? ''}`;
      let m = floors.get(key);
      if (!m && spec.tex && surfaceMaps(spec.tex)) {
        m = surface(`floor-${spec.kind}`, spec.color, spec.rough, spec.tex, { side: THREE.DoubleSide });
        floors.set(key, m);
      }
      if (!m) {
        const map = floorTexture(spec);
        m = std(`floor-${spec.kind}`, map ? '#ffffff' : spec.color, spec.rough, { side: THREE.DoubleSide, map });
        floors.set(key, m);
      }
      return m;
    },
    furniture: new Map(),
    tint: furnitureTint(style),
  };
  kits.set(style.id, kit);
  return kit;
}

// ---------- helpers ----------

/** Free a group's geometry. Materials and shared furniture geometry stay. */
export function disposeGroup(group: THREE.Object3D | null | undefined): void {
  group?.traverse((o) => {
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (geo && !geo.userData.shared) geo.dispose();
  });
}

function shadows(mesh: THREE.Mesh, cast = true, receive = true): THREE.Mesh {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

const finite = (...v: number[]): boolean => v.every((n) => Number.isFinite(n));

/** Node names end up in exported files: keep them short and plain. */
function nodeName(prefix: string, text: string | undefined, fallback: string): string {
  const clean = (text ?? '').replace(/[^\p{L}\p{N} _.'#-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
  return `${prefix}${clean || fallback}`;
}

// ---------- walls ----------

/** One wall piece as a prism with three material groups: 0 interior, 1 cladding, 2 the cut top. */
function pieceGeometry(piece: WallPiece): THREE.BufferGeometry {
  const { poly, y0, y1 } = piece;
  const n = poly.length;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / n;
    cz += p.y / n;
  }
  const positions: number[][] = [[], [], []];
  const normals: number[][] = [[], [], []];
  // UVs in meters: along the face and up it for sides, plan x/z for the top.
  const uvs: number[][] = [[], [], []];

  // Emit a triangle wound to face along (nx, ny, nz).
  const tri = (
    g: number,
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    nx: number,
    ny: number,
    nz: number,
  ) => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const facing = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    const [p, q] = facing >= 0 ? [b, c] : [c, b];
    positions[g].push(...a, ...p, ...q);
    normals[g].push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    for (const v of [a, p, q]) {
      if (Math.abs(ny) > 0.5) uvs[g].push(v[0], v[2]);
      else uvs[g].push(v[0] * -nz + v[2] * nx, v[1]);
    }
  };

  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b.x - a.x;
    const ez = b.y - a.y;
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    // Outward = away from the piece's middle.
    let nx = ez / len;
    let nz = -ex / len;
    if (nx * ((a.x + b.x) / 2 - cx) + nz * ((a.y + b.y) / 2 - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const side = piece.sides[i];
    const g = (side === 'p' && piece.pOuter) || (side === 'm' && piece.mOuter) ? 1 : 0;
    tri(g, [a.x, y0, a.y], [b.x, y0, b.y], [b.x, y1, b.y], nx, 0, nz);
    tri(g, [a.x, y0, a.y], [b.x, y1, b.y], [a.x, y1, a.y], nx, 0, nz);
  }
  // Top and underside (the piece is convex: a fan is enough).
  for (let i = 1; i < n - 1; i++) {
    tri(2, [poly[0].x, y1, poly[0].y], [poly[i].x, y1, poly[i].y], [poly[i + 1].x, y1, poly[i + 1].y], 0, 1, 0);
    if (y0 > 1e-4) {
      tri(0, [poly[0].x, y0, poly[0].y], [poly[i].x, y0, poly[i].y], [poly[i + 1].x, y0, poly[i + 1].y], 0, -1, 0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals.flat(), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs.flat(), 2));
  let start = 0;
  positions.forEach((list, g) => {
    const count = list.length / 3;
    if (count > 0) geo.addGroup(start, count, g);
    start += count;
  });
  return geo;
}

export function buildWalls(model: WallModel, kit: MaterialKit, edges = true): THREE.Group {
  const group = new THREE.Group();
  group.name = 'walls';
  for (const piece of model.pieces) {
    if (piece.poly.length < 3 || !(piece.y1 - piece.y0 > 1e-4)) continue;
    if (!piece.poly.every((p) => finite(p.x, p.y))) continue;
    const geo = pieceGeometry(piece);
    const mesh = shadows(new THREE.Mesh(geo, kit.walls));
    mesh.name = `wall-${piece.key}`;
    if (edges && kit.edges) {
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), kit.edges);
      lines.name = 'edges';
      lines.raycast = () => {};
      mesh.add(lines);
    }
    group.add(mesh);
  }
  return group;
}

// ---------- doors and windows ----------

const boxCache = new Map<string, THREE.BoxGeometry>();

/** Frames are built from a handful of box sizes: share them. */
function box(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  let geo = boxCache.get(key);
  if (!geo) {
    if (boxCache.size > 2000) boxCache.clear();
    geo = new THREE.BoxGeometry(w, h, d);
    geo.userData.shared = true;
    boxCache.set(key, geo);
  }
  return geo;
}

function boxMesh(
  name: string,
  material: THREE.Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  cast = true,
): THREE.Mesh {
  const mesh = shadows(new THREE.Mesh(box(Math.max(w, 0.002), Math.max(h, 0.002), Math.max(d, 0.002)), material), cast);
  mesh.position.set(x, y, z);
  mesh.name = name;
  return mesh;
}

/** How far a door stands open (radians). */
export const DOOR_AJAR = 0.55;

function buildDoor(o: PlacedOpening, kit: MaterialKit): THREE.Group {
  const g = new THREE.Group();
  const w = o.width;
  const h = o.y1 - o.y0;
  const ft = Math.min(0.045, w / 6);
  const depth = o.thickness + 0.03;
  g.add(boxMesh('frame', kit.trim, ft, h, depth, -w / 2 + ft / 2, o.y0 + h / 2, 0));
  g.add(boxMesh('frame', kit.trim, ft, h, depth, w / 2 - ft / 2, o.y0 + h / 2, 0));
  g.add(boxMesh('frame', kit.trim, w - 2 * ft, ft, depth, 0, o.y1 - ft / 2, 0));

  // The leaf hangs on the jamb nearer the wall's A end and opens to the same
  // side as the swing arc drawn on the plan. A wide doorway gets a pair.
  const clear = Math.max(0.05, w - 2 * ft - 0.01);
  const lh = Math.max(0.05, h - ft - 0.012);
  const hy = Math.min(1.0, lh * 0.5);
  const hang = (name: string, lw: number, hingeX: number, dir: 1 | -1): void => {
    const leaf = new THREE.Group();
    leaf.name = name;
    leaf.position.set(hingeX, o.y0, 0);
    leaf.rotation.y = DOOR_AJAR * dir;
    leaf.add(boxMesh('leaf', kit.door, lw, lh, 0.04, (dir * lw) / 2, lh / 2 + 0.006, 0));
    leaf.add(boxMesh('handle', kit.handle, 0.1, 0.022, 0.03, dir * (lw - 0.1), hy, 0.035, false));
    leaf.add(boxMesh('handle', kit.handle, 0.1, 0.022, 0.03, dir * (lw - 0.1), hy, -0.035, false));
    g.add(leaf);
  };
  if (w >= DOUBLE_DOOR_MIN) {
    const lw = clear / 2 - 0.003;
    hang('leaf', lw, -w / 2 + ft, 1);
    hang('leaf-2', lw, w / 2 - ft, -1);
  } else {
    hang('leaf', clear, -w / 2 + ft, 1);
  }
  return g;
}

function buildWindow(o: PlacedOpening, kit: MaterialKit): THREE.Group {
  const g = new THREE.Group();
  const w = o.width;
  const h = o.y1 - o.y0;
  const yc = o.y0 + h / 2;
  const ft = Math.min(0.05, w / 6, h / 6);
  const depth = o.thickness + 0.03;
  g.add(boxMesh('frame', kit.trim, ft, h, depth, -w / 2 + ft / 2, yc, 0));
  g.add(boxMesh('frame', kit.trim, ft, h, depth, w / 2 - ft / 2, yc, 0));
  g.add(boxMesh('frame', kit.trim, w - 2 * ft, ft, depth, 0, o.y1 - ft / 2, 0));
  g.add(boxMesh('frame', kit.trim, w - 2 * ft, ft, depth, 0, o.y0 + ft / 2, 0));
  if (w >= TRIPLE_WINDOW_MIN) {
    // Three lights.
    for (const x of [-w / 6, w / 6]) g.add(boxMesh('mullion', kit.trim, 0.035, h - 2 * ft, 0.05, x, yc, 0));
  } else if (w > 1.3) g.add(boxMesh('mullion', kit.trim, 0.035, h - 2 * ft, 0.05, 0, yc, 0));
  if (o.y0 > 0.05) g.add(boxMesh('sill', kit.trim, w + 0.08, 0.035, o.thickness + 0.14, 0, o.y0 + 0.012, 0));
  const glass = boxMesh('glass', kit.glass, w - 2 * ft, h - 2 * ft, 0.012, 0, yc, 0, false);
  glass.receiveShadow = false;
  glass.renderOrder = 2;
  g.add(glass);
  return g;
}

export function buildOpenings(openings: PlacedOpening[], kit: MaterialKit): THREE.Group {
  const group = new THREE.Group();
  group.name = 'openings';
  let doors = 0;
  let windows = 0;
  for (const o of openings) {
    if (!finite(o.x, o.y, o.angle, o.width, o.y0, o.y1) || o.width < 0.05 || o.y1 - o.y0 < 0.05) continue;
    const g = o.type === 'door' ? buildDoor(o, kit) : buildWindow(o, kit);
    g.position.set(o.x, 0, o.y);
    g.rotation.y = -o.angle;
    g.name =
      o.type === 'door'
        ? nodeName('door-', o.label, String(++doors))
        : nodeName('window-', o.label, String(++windows));
    group.add(g);
  }
  return group;
}

// ---------- floors, ceilings ----------

function planShape(polygon: Point[]): THREE.Shape | null {
  const pts = polygon.filter((p) => finite(p.x, p.y));
  if (pts.length < 3) return null;
  const shape = new THREE.Shape();
  pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
  return shape;
}

/** A flat polygon lying in the plan: shape (x, y) → world (x, 0, y). `uvScale` = repeats per meter. */
function flatGeometry(polygon: Point[], uvScale: number, faceUp = false): THREE.BufferGeometry | null {
  const shape = planShape(polygon);
  if (!shape) return null;
  const geo = new THREE.ShapeGeometry(shape);
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
  geo.rotateX(Math.PI / 2); // now faces down, as a ceiling does
  if (faceUp) {
    // A floor is looked at and lit from above: turn the faces over so normal maps shade the right way.
    const index = geo.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, b);
      }
    }
    const normal = geo.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 1, 0);
  }
  return geo;
}

export function buildFloors(
  rooms: DetectedRoom[],
  roomNames: Record<string, string>,
  kit: MaterialKit,
  /** Rooms open to the sky (see `openAirRooms`): they get the style's outdoor paving. */
  open?: ReadonlySet<string> | null,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'floors';
  for (const room of rooms) {
    const name = roomNames[room.key];
    const spec = floorFor(kit.style, name, open?.has(room.key));
    // Photographed materials carry their own real-world size; drawn patterns repeat every `spec.size`.
    const photo = !!spec.tex && typeof document !== 'undefined';
    const geo = flatGeometry(room.polygon, photo ? 1 : 1 / Math.max(0.05, spec.size), true);
    if (!geo) continue;
    const mesh = shadows(new THREE.Mesh(geo, kit.floor(spec)), false);
    mesh.position.y = 0.01;
    mesh.name = nodeName('floor-', name, 'room');
    group.add(mesh);
  }
  return group;
}

/** Ceilings face down and cast nothing, so the sun still reaches the rooms below. */
export function buildCeilings(
  rooms: DetectedRoom[],
  height: number,
  kit: MaterialKit,
  open?: ReadonlySet<string> | null,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ceilings';
  for (const room of rooms) {
    if (open?.has(room.key)) continue;
    const geo = flatGeometry(room.polygon, 1);
    if (!geo) continue;
    const mesh = shadows(new THREE.Mesh(geo, kit.ceiling), false, false);
    mesh.position.y = height - 0.002;
    mesh.name = 'ceiling';
    group.add(mesh);
  }
  return group;
}

// ---------- roof ----------

export function buildRoofGroup(model: RoofModel, kit: MaterialKit, castShadow = true): THREE.Group {
  return buildRoofMeshes(model, kit.roof, castShadow);
}

// ---------- furniture ----------

export function buildFurniture(furniture: Furniture[], kit: MaterialKit): THREE.Group {
  const group = new THREE.Group();
  group.name = 'furniture';
  for (const item of furniture) {
    try {
      if (!finite(item.x, item.y, item.rotation)) continue;
      const def = furnitureDef(item.kind);
      if (!def || !Array.isArray(def.parts)) continue;
      // Catalog pieces take the style's palette; product and custom items keep their own colors.
      const tint = isBuiltinKind(item.kind) ? kit.tint : undefined;
      // Real furniture where the catalog has a model for it; the box-built parts until it loads, and for custom items.
      const g =
        (isBuiltinKind(item.kind) && buildModelItem(item.kind, def, furniturePalette(kit.style), kit.furniture)) ||
        buildItemGroup(def, kit.furniture, tint, true);
      g.position.set(item.x, 0, item.y);
      g.rotation.y = -item.rotation;
      g.name = nodeName('', item.label ? `${def.label} ${item.label}` : def.label, 'item');
      group.add(g);
    } catch {
      // One broken item must not take the model down.
    }
  }
  return group;
}

// ---------- lamps ----------

/** Lamps come on when the sun is low. */
export const lampsOn = (hour: number): boolean => hour >= 18 || hour <= 6.5;

/**
 * One warm ceiling lamp per roofed room, for evening views: a light, and a
 * small glowing fitting where the ceiling is. Scene dressing only.
 */
export function buildRoomLamps(
  rooms: DetectedRoom[],
  height: number,
  open?: ReadonlySet<string> | null,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lamps';
  const glow = new THREE.MeshStandardMaterial({ color: '#fff1d0', emissive: '#ffd9a0', emissiveIntensity: 2.2, roughness: 0.6 });
  glow.name = 'lamp-glow';
  const y = Math.max(1.8, height - 0.35);
  for (const room of rooms.slice(0, 24)) {
    if (open?.has(room.key) || !finite(room.centroid.x, room.centroid.y)) continue;
    // Bigger rooms get a stronger lamp; a closet gets a small one.
    const power = Math.min(1.6, Math.max(0.45, Math.sqrt(room.area) / 3.6));
    const light = new THREE.PointLight('#ffd9a8', 9 * power, 0, 2);
    light.position.set(room.centroid.x, y, room.centroid.y);
    light.name = 'lamp';
    group.add(light);
    const fitting = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), glow);
    fitting.position.copy(light.position);
    fitting.name = 'lamp-fitting';
    group.add(fitting);
  }
  return group;
}

// ---------- the whole house ----------

export type HousePlan = Pick<PlanData, 'walls' | 'openings' | 'furniture' | 'roomNames' | 'settings'>;

/** Walls with usable coordinates and settings with usable numbers — bad data never reaches the builders. */
export function sanitizeForScene(walls: Wall[], settings: PlanSettings): { walls: Wall[]; settings: PlanSettings } {
  const num = (v: number, fallback: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    walls: walls.filter((w) => w && w.a && w.b && finite(w.a.x, w.a.y, w.b.x, w.b.y)),
    settings: {
      ...settings,
      wallHeight: num(settings.wallHeight, 2.7, 0.5, 12),
      wallThickness: num(settings.wallThickness, 0.15, 0.02, 1),
    },
  };
}

/** The rooms with a roof over them — walls facing anything else are clad as exterior. */
export function indoorRooms(rooms: DetectedRoom[], open: ReadonlySet<string>): DetectedRoom[] {
  return open.size === 0 ? rooms : rooms.filter((r) => !open.has(r.key));
}

export interface HouseOptions {
  style: HouseStyle;
  /** Already resolved (see `effectiveRoof`). */
  roof: RoofKind;
  ceilings?: boolean;
  /** Ink lines on wall edges where the style has them. */
  edges?: boolean;
}

/** Everything at once, as one named group — the exporter's entry point. */
export function buildHouse(plan: HousePlan, opts: HouseOptions): THREE.Group {
  const { walls, settings } = sanitizeForScene(plan.walls, plan.settings);
  const kit = materialKit(opts.style);
  const rooms = detectRooms(walls);
  const open = openAirRooms(rooms, plan.roomNames);
  const model = buildWallModel(walls, plan.openings, settings, indoorRooms(rooms, open));
  const house = new THREE.Group();
  house.name = 'house';
  house.add(buildWalls(model, kit, opts.edges ?? false));
  house.add(buildOpenings(model.openings, kit));
  house.add(buildFloors(rooms, plan.roomNames, kit, open));
  if (opts.ceilings) house.add(buildCeilings(rooms, settings.wallHeight, kit, open));
  if (opts.roof !== 'none') house.add(buildRoofGroup(buildRoof(opts.roof, { rooms, walls, settings, open }), kit));
  house.add(buildFurniture(plan.furniture, kit));
  return house;
}
