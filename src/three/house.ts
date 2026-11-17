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
import { buildGutters, buildRoofPieces, facesOf } from './roofPieces';
import { hash, lightOf, shade, Soup } from './pieces';
import type { V3 } from './pieces';
import { faceFromPoints, layCornerBoards, layPlinth, laySiding, laySkirting, wallFaces } from './wallPieces';
import type { WallFace } from './wallPieces';
import { floorFor, furnitureTint, furniturePalette } from './styles';
import { buildModelItem } from './furnitureModels';
import type { FloorSpec, HouseStyle } from './styles';
import { floorTexture } from './textures';
import { averageLinear, TEXTURES, tintFor, type TextureId } from './surfaces';
import { surfaceMaps } from './textureSet';
import { mixHex } from './sun';
import { pointInPolygon } from '../geometry';
import { restHeights } from '../rest';
import { withBounce } from './bounce';

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
  /** Surfaces built piece by piece carry their colour per vertex: matt (boards, tiles, brick) and metal (trays, gutters). */
  pieces: THREE.MeshStandardMaterial;
  piecesMetal: THREE.MeshStandardMaterial;
  /** Curtains and blinds: colour per vertex, light coming through. */
  fabric: THREE.MeshStandardMaterial;
  /** What shows in the joints between pieces: under the tiles, behind the boards. */
  roofBack: THREE.MeshStandardMaterial;
  sidingBack: THREE.MeshStandardMaterial;
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
    const { contrast = 1, relief = 1 } = TEXTURES[tex];
    if (relief !== 1) m.normalScale.setScalar(relief);
    if (contrast < 1) calm(m, averageLinear(tex), contrast);
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
    // Styled glass reads as a real window: dark by day, the sky caught in it, the room only half seen behind.
    glass:
      style.id === 'maquette'
        ? std('glass', style.glass, 0.08, { transparent: true, opacity: style.glassOpacity, depthWrite: false, side: THREE.DoubleSide })
        : std('glass', mixHex(style.glass, '#1b2026', 0.75), 0.02, {
            transparent: true,
            opacity: 0.48,
            depthWrite: false,
            side: THREE.DoubleSide,
            metalness: 0.15,
            envMapIntensity: 2.6,
          }),
    ceiling: std('ceiling', mixHex(style.wall, '#ffffff', 0.35), 1),
    roof: {
      roof: surface('roof', style.roof, 0.85, style.roofTex, { side: THREE.DoubleSide }),
      gable: surface('roof-gable', style.cladding, 0.9, style.claddingTex, { side: THREE.DoubleSide }),
      soffit: std('roof-soffit', style.trim, 0.9, { side: THREE.DoubleSide }),
    },
    pieces: std('pieces', '#ffffff', 0.88, { vertexColors: true }),
    // Glossy enough that the sky slides across a tray as a gradient, not a flat grey.
    piecesMetal: std('pieces-metal', '#ffffff', 0.32, { vertexColors: true, metalness: 0.7 }),
    fabric: std('fabric', '#ffffff', 0.95, { vertexColors: true, side: THREE.DoubleSide }),
    // Set back a hair in depth, so a tile lying a centimetre above it never flickers against it.
    roofBack: std('roof-under', mixHex(style.roof, '#000000', 0.55), 0.95, {
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
    sidingBack: std(
      'siding-under',
      style.siding === 'brick' ? mixHex('#b8b1a5', style.cladding, 0.18) : mixHex(style.cladding, '#000000', 0.6),
      0.95,
    ),
    edges: style.edges ? named(new THREE.LineBasicMaterial({ color: style.edges }), 'edges') : null,
    floor: (spec) => {
      const key = `${spec.kind}|${spec.color}|${spec.line}|${spec.rough}|${spec.tex ?? ''}`;
      let m = floors.get(key);
      if (!m && spec.tex && surfaceMaps(spec.tex)) {
        m = withBounce(surface(`floor-${spec.kind}`, spec.color, spec.rough, spec.tex, { side: THREE.DoubleSide }));
        floors.set(key, m);
      }
      if (!m) {
        const map = floorTexture(spec);
        m = withBounce(std(`floor-${spec.kind}`, map ? '#ffffff' : spec.color, spec.rough, { side: THREE.DoubleSide, map }));
        floors.set(key, m);
      }
      return m;
    },
    furniture: new Map(),
    tint: furnitureTint(style),
  };
  // Behind boards or bricks, the wall's own outside face is only the dark of the joints.
  if (style.siding) {
    kit.walls[1] = kit.sidingBack;
    kit.roof.gable = kit.sidingBack;
  }
  // Indoors, every surface takes its soft light from its own room rather than the open sky (see bounce.ts).
  // Last, so it wraps whatever shader tweaks the materials already have.
  for (const m of [
    ...kit.walls,
    kit.trim,
    kit.door,
    kit.handle,
    kit.ceiling,
    ...Object.values(kit.roof),
    kit.pieces,
    kit.piecesMetal,
    kit.fabric,
    kit.roofBack,
    kit.sidingBack,
  ])
    withBounce(m);
  kits.set(style.id, kit);
  return kit;
}

/**
 * Keep only `keep` of a photo's light-and-dark: each texel is drawn toward the
 * photo's average before the tint, so stains and blotches settle into a quiet
 * grain. (Live view only; the path tracer reads the photo as it is.)
 */
function calm(m: THREE.MeshStandardMaterial, avg: [number, number, number], keep: number): void {
  const mean = avg.map((v) => v.toFixed(4)).join(', ');
  const k = keep.toFixed(3);
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        sampledDiffuseColor.rgb = mix( vec3( ${mean} ), sampledDiffuseColor.rgb, ${k} );
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  m.customProgramCacheKey = () => `calm|${mean}|${k}`;
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

/**
 * Over a door or window, the boards start on top of the casing's drip cap
 * rather than behind it, so battens die onto the cap instead of crossing it.
 * Undefined for any piece that is not the lintel over an opening.
 */
function sidingFrom(piece: WallPiece, openings: PlacedOpening[]): number | undefined {
  if (piece.y0 < 0.05) return undefined;
  let cx = 0;
  let cz = 0;
  for (const p of piece.poly) {
    cx += p.x / piece.poly.length;
    cz += p.y / piece.poly.length;
  }
  for (const o of openings) {
    if (o.wallId !== piece.wallId || Math.abs(o.y1 - piece.y0) > 0.02) continue;
    const along = (cx - o.x) * Math.cos(o.angle) + (cz - o.y) * Math.sin(o.angle);
    if (Math.abs(along) <= o.width / 2 + 0.02) return o.y1 + casingHead(o.type) + DRIP_CAP;
  }
  return undefined;
}

export function buildWalls(model: WallModel, kit: MaterialKit, edges = true): THREE.Group {
  const group = new THREE.Group();
  group.name = 'walls';
  const style = kit.style;
  // The maquette is bare card; every other look gets its siding and trim.
  const dressed = style.id !== 'maquette';
  const plinth = mixHex('#8d877c', style.cladding, 0.2);
  const outside: WallFace[] = [];
  for (const piece of model.pieces) {
    if (piece.poly.length < 3 || !(piece.y1 - piece.y0 > 1e-4)) continue;
    if (!piece.poly.every((p) => finite(p.x, p.y))) continue;
    const geo = pieceGeometry(piece);
    const mesh = shadows(new THREE.Mesh(geo, kit.walls));
    mesh.name = `wall-${piece.key}`;
    mesh.userData.key = `wall-${piece.key}`;
    if (edges && kit.edges) {
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), kit.edges);
      lines.name = 'edges';
      lines.raycast = () => {};
      mesh.add(lines);
    }
    if (dressed) {
      // Boards or bricks outside, a base course under them, skirting inside: all one small mesh riding on the piece.
      const soup = new Soup();
      const from = sidingFrom(piece, model.openings);
      for (const f of wallFaces(piece)) {
        if (f.outer) {
          outside.push(f);
          if (style.siding) laySiding(soup, f, style.siding, style.cladding, from);
          layPlinth(soup, f, plinth);
        } else {
          laySkirting(soup, f, style.trim);
        }
      }
      const dress = soup.geometry();
      // Beside the wall, not inside it: a render stands other meshes in for multi-material walls and hides the originals.
      if (dress) {
        const child = shadows(new THREE.Mesh(dress, kit.pieces), false);
        child.name = 'siding';
        child.userData.key = `wall-${piece.key}`;
        group.add(child);
      }
    }
    group.add(mesh);
  }
  if (dressed && style.siding && style.siding !== 'brick') {
    const soup = new Soup();
    layCornerBoards(soup, outside, style.trim);
    const corners = soup.geometry();
    if (corners) {
      const mesh = shadows(new THREE.Mesh(corners, kit.pieces), false);
      mesh.name = 'corner-boards';
      group.add(mesh);
    }
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

/**
 * Casing round an opening, on both faces of the wall: a board up each side
 * and a deeper head across the top, standing proud of the siding so the
 * opening reads as built in, not cut out. The maquette stays bare card.
 */
/** Depth of the casing head over an opening, and of the drip cap on top of it. */
const casingHead = (type: PlacedOpening['type']): number => (type === 'window' ? 0.1 : 0.085);
const DRIP_CAP = 0.018;

function addCasing(g: THREE.Group, o: PlacedOpening, kit: MaterialKit, from: number): void {
  if (kit.style.id === 'maquette') return;
  const w = o.width;
  const cw = 0.07; // board width
  const head = casingHead(o.type);
  const proud = 0.045;
  const z = o.thickness / 2 + proud / 2;
  const top = o.y1 + head;
  for (const side of [-1, 1]) {
    const zc = side * z;
    g.add(boxMesh('casing', kit.trim, cw, top - from, proud, -w / 2 - cw / 2, (from + top) / 2, zc, false));
    g.add(boxMesh('casing', kit.trim, cw, top - from, proud, w / 2 + cw / 2, (from + top) / 2, zc, false));
    g.add(boxMesh('casing', kit.trim, w + 2 * cw, head, proud, 0, o.y1 + head / 2, zc, false));
    // A drip cap over the head, so rain is thrown clear of the frame.
    g.add(boxMesh('casing', kit.trim, w + 2 * cw + 0.03, DRIP_CAP, proud + 0.02, 0, top + DRIP_CAP / 2, side * (o.thickness / 2 + (proud + 0.02) / 2), false));
  }
}

/**
 * A front door's leaf: stiles and rails round four shallow sunk panels, each
 * with a raised field, so it reads as a made door and not a slab. `dir` is the
 * way the leaf runs from its hinge; the leaf's foot is at y = 0.
 */
const doorShades = new WeakMap<MaterialKit, THREE.MeshStandardMaterial>();

/** The door's own finish a shade darker: the sunk bevel round a panel, which is always half in shadow. */
function doorShade(kit: MaterialKit): THREE.MeshStandardMaterial {
  let m = doorShades.get(kit);
  if (!m) {
    m = kit.door.clone();
    m.name = 'door-shade';
    m.color.multiplyScalar(0.62);
    withBounce(m);
    doorShades.set(kit, m);
  }
  return m;
}

function panelledLeaf(leaf: THREE.Group, kit: MaterialKit, lw: number, lh: number, dir: 1 | -1, lockY: number): void {
  const t = 0.04;
  const sunk = t - 2 * 0.007; // panels sit 7 mm back from each face
  const x = (a: number, b: number) => (dir * (a + b)) / 2;
  const part = (a: number, b: number, y0: number, y1: number, d: number, name = 'leaf', mat: THREE.Material = kit.door) => {
    if (b - a > 0.004 && y1 - y0 > 0.004) leaf.add(boxMesh(name, mat, b - a, y1 - y0, d, x(a, b), (y0 + y1) / 2, 0));
  };
  const stile = Math.min(0.11, lw * 0.17);
  const bottom = Math.min(0.2, lh * 0.1);
  const top = Math.min(0.12, lh * 0.06);
  const lock = 0.15;
  const ly = Math.min(Math.max(lockY, bottom + lock / 2 + 0.2), lh - top - lock / 2 - 0.2);
  part(0, stile, 0, lh, t);
  part(lw - stile, lw, 0, lh, t);
  part(stile, lw - stile, 0, bottom, t);
  part(stile, lw - stile, ly - lock / 2, ly + lock / 2, t);
  part(stile, lw - stile, lh - top, lh, t);
  // Two panels across a full-width leaf, one across a narrow leaf of a pair.
  const cols = lw > 0.62 ? 2 : 1;
  const muntin = 0.09;
  const inner = lw - 2 * stile;
  const pw = (inner - (cols - 1) * muntin) / cols;
  const rows: [number, number][] = [
    [bottom, ly - lock / 2],
    [ly + lock / 2, lh - top],
  ];
  for (const [y0, y1] of rows) {
    for (let c = 0; c < cols; c++) {
      const a = stile + c * (pw + muntin);
      part(a, a + pw, y0, y1, sunk, 'panel', doorShade(kit));
      // The raised field, a bevel's width in from the panel's edge: its step is the darker line that draws the panel.
      part(a + 0.03, a + pw - 0.03, y0 + 0.03, y1 - 0.03, sunk + 0.008, 'panel');
      if (c < cols - 1) part(a + pw, a + pw + muntin, y0, y1, t);
    }
  }
}

function buildDoor(o: PlacedOpening, kit: MaterialKit, exterior = false): THREE.Group {
  const g = new THREE.Group();
  const w = o.width;
  const h = o.y1 - o.y0;
  const ft = Math.min(0.045, w / 6);
  const depth = o.thickness + 0.03;
  g.add(boxMesh('frame', kit.trim, ft, h, depth, -w / 2 + ft / 2, o.y0 + h / 2, 0));
  g.add(boxMesh('frame', kit.trim, ft, h, depth, w / 2 - ft / 2, o.y0 + h / 2, 0));
  g.add(boxMesh('frame', kit.trim, w - 2 * ft, ft, depth, 0, o.y1 - ft / 2, 0));

  // A way in from outside is shut, panelled, and stands on a threshold; a door between rooms stands ajar.
  const front = exterior && kit.style.id !== 'maquette';
  const sill = front ? 0.022 : 0;
  if (front) g.add(boxMesh('threshold', kit.trim, w, sill, o.thickness + 0.08, 0, o.y0 + sill / 2, 0));

  // The leaf hangs on the jamb nearer the wall's A end and opens to the same
  // side as the swing arc drawn on the plan. A wide doorway gets a pair.
  const clear = Math.max(0.05, w - 2 * ft - 0.01);
  const lh = Math.max(0.05, h - ft - 0.012 - sill);
  const hy = Math.min(1.0, lh * 0.5);
  const hang = (name: string, lw: number, hingeX: number, dir: 1 | -1): void => {
    const leaf = new THREE.Group();
    leaf.name = name;
    leaf.position.set(hingeX, o.y0 + sill, 0);
    leaf.rotation.y = front ? 0 : DOOR_AJAR * dir;
    if (front && lw > 0.3 && lh > 1.2) {
      const foot = new THREE.Group();
      foot.position.y = 0.006;
      panelledLeaf(foot, kit, lw, lh, dir, hy);
      leaf.add(foot);
    } else {
      leaf.add(boxMesh('leaf', kit.door, lw, lh, 0.04, (dir * lw) / 2, lh / 2 + 0.006, 0));
    }
    leaf.add(boxMesh('handle', kit.handle, 0.1, 0.022, 0.03, dir * (lw - 0.1), hy, 0.035, false));
    leaf.add(boxMesh('handle', kit.handle, 0.1, 0.022, 0.03, dir * (lw - 0.1), hy, -0.035, false));
    g.add(leaf);
  };
  if (w >= DOUBLE_DOOR_MIN) {
    const lw = clear / 2 - 0.003;
    hang('leaf', lw, -w / 2 + ft, 1);
    hang('leaf-2', lw, w / 2 - ft, -1);
    // Where the pair meets: a strip over the joint, so no daylight shows between the leaves.
    if (front) g.add(boxMesh('meeting-stile', kit.door, 0.034, lh - 0.004, 0.052, 0, o.y0 + sill + 0.006 + lh / 2, 0));
  } else {
    hang('leaf', clear, -w / 2 + ft, 1);
  }
  addCasing(g, o, kit, o.y0);
  return g;
}

function buildWindow(o: PlacedOpening, kit: MaterialKit, inside: 1 | -1 | 0 = 0): THREE.Group {
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
  const dressed = kit.style.id !== 'maquette';
  // The sill runs out past the casing either side, and stands clear of the siding.
  if (o.y0 > 0.05) g.add(boxMesh('sill', kit.trim, w + (dressed ? 0.22 : 0.08), 0.04, o.thickness + (dressed ? 0.18 : 0.14), 0, o.y0 + 0.012, 0));
  addCasing(g, o, kit, o.y0 > 0.05 ? o.y0 + 0.032 : o.y0);
  const glass = boxMesh('glass', kit.glass, w - 2 * ft, h - 2 * ft, 0.012, 0, yc, 0, false);
  glass.receiveShadow = false;
  glass.renderOrder = 2;
  g.add(glass);
  if (dressed && inside !== 0) dressWindow(g, o, kit, inside);
  return g;
}

/**
 * What hangs on the room side of a window: a pair of curtains drawn back to
 * different widths, a roller blind part way down, or nothing — chosen per
 * window, the same every time. From outside this is what makes glass read as
 * a window into a lived-in room rather than a grey panel.
 */
function dressWindow(g: THREE.Group, o: PlacedOpening, kit: MaterialKit, inside: 1 | -1): void {
  const pal = furniturePalette(kit.style);
  // Chosen by where the window is, not by its id: the same plan dresses the same way every time it is opened.
  const id = (Math.round(o.x * 20) * 73856093) ^ (Math.round(o.y * 20) * 19349663);
  const pick = hash(id, 1, 2);
  const w = o.width;
  const h = o.y1 - o.y0;
  const z = inside * (o.thickness / 2 + 0.07);
  const toward: V3 = [0, 0, -inside]; // the fabric's face looks out through the glass
  const soup = new Soup();
  const fabrics = [pal.linen, pal.fabric, pal.white];
  const fabric = lightOf(fabrics[Math.floor(hash(id, 3, 4) * fabrics.length) % fabrics.length]);
  if (pick < 0.62) {
    // Curtains: a rail above, two folded panels hanging to just below the sill.
    const top = o.y1 + 0.16;
    const bottom = Math.max(0.02, o.y0 - 0.12);
    for (const side of [-1, 1]) {
      const cover = 0.16 + 0.2 * hash(id, side + 5, 6);
      const x0 = side * (w / 2 + 0.12);
      const x1 = side * (w / 2 - cover * w);
      const folds = Math.max(3, Math.round(Math.abs(x1 - x0) / 0.07));
      for (let i = 0; i < folds; i++) {
        const a = x0 + ((x1 - x0) * i) / folds;
        const b = x0 + ((x1 - x0) * (i + 1)) / folds;
        const da = i % 2 === 0 ? 0 : 0.035;
        const db = i % 2 === 0 ? 0.035 : 0;
        const k = i % 2 === 0 ? 1.04 : 0.86;
        soup.poly(
          [
            [a, bottom, z + inside * da],
            [b, bottom, z + inside * db],
            [b, top, z + inside * db],
            [a, top, z + inside * da],
          ],
          shade(fabric, k),
          toward,
        );
      }
    }
    soup.poly(
      [
        [-w / 2 - 0.2, top + 0.01, z - inside * 0.01],
        [w / 2 + 0.2, top + 0.01, z - inside * 0.01],
        [w / 2 + 0.2, top + 0.03, z - inside * 0.01],
        [-w / 2 - 0.2, top + 0.03, z - inside * 0.01],
      ],
      lightOf(pal.dark),
      toward,
    );
  } else if (pick < 0.85) {
    // A roller blind, part way down.
    const down = h * (0.18 + 0.32 * hash(id, 7, 8));
    const top = o.y1 - 0.02;
    soup.poly(
      [
        [-w / 2 + 0.03, top - down, z],
        [w / 2 - 0.03, top - down, z],
        [w / 2 - 0.03, top, z],
        [-w / 2 + 0.03, top, z],
      ],
      shade(fabric, 0.95),
      toward,
    );
    soup.poly(
      [
        [-w / 2 + 0.03, top - down - 0.025, z],
        [w / 2 - 0.03, top - down - 0.025, z],
        [w / 2 - 0.03, top - down, z],
        [-w / 2 + 0.03, top - down, z],
      ],
      lightOf(pal.dark),
      toward,
    );
  }
  const geo = soup.geometry();
  if (!geo) return;
  const mesh = new THREE.Mesh(geo, kit.fabric);
  mesh.name = 'window-dressing';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  g.add(mesh);
}

/**
 * Which side of each wall is indoors, in an opening's own frame: its +z is
 * the wall's "p" side. +1 / −1 = that side is the room; 0 = indoors both sides.
 */
export function insideSides(pieces: WallPiece[]): Map<string, 1 | -1 | 0> {
  const out = new Map<string, 1 | -1 | 0>();
  for (const p of pieces) {
    if (out.get(p.wallId)) continue;
    out.set(p.wallId, p.pOuter && !p.mOuter ? -1 : p.mOuter && !p.pOuter ? 1 : 0);
  }
  return out;
}

export function buildOpenings(openings: PlacedOpening[], kit: MaterialKit, pieces: WallPiece[] = []): THREE.Group {
  const inside = insideSides(pieces);
  const group = new THREE.Group();
  group.name = 'openings';
  let doors = 0;
  let windows = 0;
  for (const o of openings) {
    if (!finite(o.x, o.y, o.angle, o.width, o.y0, o.y1) || o.width < 0.05 || o.y1 - o.y0 < 0.05) continue;
    const side = inside.get(o.wallId) ?? 0;
    const g = o.type === 'door' ? buildDoor(o, kit, side !== 0) : buildWindow(o, kit, side);
    g.position.set(o.x, 0, o.y);
    g.rotation.y = -o.angle;
    g.userData.key = `opening-${o.id}`;
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
    mesh.userData.room = { key: room.key, name: name ?? '', polygon: room.polygon, centroid: room.centroid };
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
  const roofing = kit.style.roofing;
  const tiles = roofing ? buildRoofPieces(model, roofing, kit.style.roof) : null;
  // Under tiles the roof's own surface is only what shows in the joints.
  const group = buildRoofMeshes(model, tiles ? { ...kit.roof, roof: kit.roofBack } : kit.roof, castShadow);
  if (tiles && roofing) {
    const mesh = new THREE.Mesh(tiles, roofing === 'seam' ? kit.piecesMetal : kit.pieces);
    // The roof under them casts the shadow; a tile is too small for the shadow map and would only speckle.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'roof-tiles';
    group.add(mesh);
    // Gable ends carry on the wall's siding, course for course.
    const siding = kit.style.siding;
    if (siding) {
      const soup = new Soup();
      for (const solid of model.solids) {
        if (solid.part !== 'gable') continue;
        for (const f of facesOf(solid.positions)) {
          if (Math.abs(f.n[1]) > 0.01) continue;
          const face = faceFromPoints(f.pts, f.n[0], f.n[2], true);
          if (face) laySiding(soup, face, siding, kit.style.cladding);
        }
      }
      const ends = soup.geometry();
      if (ends) {
        const g = new THREE.Mesh(ends, kit.pieces);
        g.castShadow = false;
        g.receiveShadow = true;
        g.name = 'gable-siding';
        group.add(g);
      }
    }
    const gutters = buildGutters(model, mixHex(kit.style.roof, '#26282b', 0.4));
    if (gutters) {
      const g = new THREE.Mesh(gutters, kit.piecesMetal);
      g.castShadow = castShadow;
      g.receiveShadow = true;
      g.name = 'gutters';
      group.add(g);
    }
  }
  return group;
}

// ---------- furniture ----------

export function buildFurniture(furniture: Furniture[], kit: MaterialKit): THREE.Group {
  const group = new THREE.Group();
  group.name = 'furniture';
  // Products dropped on a table or counter stand on its top.
  const rest = restHeights(furniture);
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
      g.position.set(item.x, rest.get(item.id) ?? 0, item.y);
      g.rotation.y = -item.rotation;
      g.userData.key = `item-${item.id}`;
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

/** What every lamp build shares: made once for the page, never disposed with a rebuild. */
interface LampKit {
  fitting: THREE.MeshStandardMaterial;
  fittingGeometry: THREE.BufferGeometry;
  /** The lit room seen through a window. Its colour is the light's hue; the vertex colours carry the falloff (×~3 at the middle) and a soft edge in alpha. */
  pane: THREE.MeshBasicMaterial;
  /** Light thrown on a sill, the ground or the wall: added on top of what is there. */
  spill: THREE.MeshBasicMaterial;
  lantern: THREE.MeshStandardMaterial;
  lanternMetal: THREE.MeshStandardMaterial;
}

let lampKit: LampKit | null = null;

function lampKitOf(): LampKit {
  if (lampKit) return lampKit;
  const fittingGeometry = new THREE.SphereGeometry(0.11, 16, 12);
  fittingGeometry.userData.shared = true;
  lampKit = {
    fitting: withBounce(
      named(
        new THREE.MeshStandardMaterial({ color: '#fff1d0', emissive: '#ffd9a0', emissiveIntensity: 2.2, roughness: 0.6 }),
        'lamp-glow',
      ),
    ),
    fittingGeometry,
    pane: named(
      new THREE.MeshBasicMaterial({ color: '#ffd9a8', vertexColors: true, transparent: true, depthWrite: false, side: THREE.FrontSide }),
      'window-glow',
    ),
    spill: named(
      new THREE.MeshBasicMaterial({
        color: '#ffb46e',
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      'window-spill',
    ),
    lantern: withBounce(
      named(
        new THREE.MeshStandardMaterial({ color: '#fff3dc', emissive: '#ffc77a', emissiveIntensity: 2.6, roughness: 0.4 }),
        'lantern-glow',
      ),
    ),
    lanternMetal: withBounce(
      named(new THREE.MeshStandardMaterial({ color: '#2c2a27', roughness: 0.45, metalness: 0.6 }), 'lantern-metal'),
    ),
  };
  return lampKit;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * A flat grid from `origin` along unit axes `du` and `dv`, over [u0, u1] × [v0, v1],
 * facing `toward`, with an RGBA colour per vertex from `paint`.
 */
function paintedGrid(
  origin: V3,
  du: V3,
  dv: V3,
  [u0, u1, v0, v1]: [number, number, number, number],
  [nu, nv]: [number, number],
  toward: V3,
  paint: (u: number, v: number) => [number, number, number, number],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = u0 + ((u1 - u0) * i) / nu;
      const v = v0 + ((v1 - v0) * j) / nv;
      positions.push(origin[0] + du[0] * u + dv[0] * v, origin[1] + du[1] * u + dv[1] * v, origin[2] + du[2] * u + dv[2] * v);
      colors.push(...paint(u, v));
      normals.push(...toward);
    }
  }
  // Wind so the front face looks along `toward`.
  const cross: V3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
  const flip = cross[0] * toward[0] + cross[1] * toward[1] + cross[2] * toward[2] < 0;
  const index: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      if (flip) index.push(a, c, b, b, c, d);
      else index.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geo.setIndex(index);
  return geo;
}

/** How far a ray from `p` along unit `d` runs before it leaves `poly` (Infinity if it never meets an edge). */
function reach(poly: Point[], p: Point, d: Point): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
    const u = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.min(best, t);
  }
  return best;
}

/** An opening's own frame in world space: x along the wall, z through it (+z the wall's "p" side). */
function openingFrame(o: PlacedOpening) {
  const c = Math.cos(o.angle);
  const s = Math.sin(o.angle);
  return {
    along: [c, 0, s] as V3,
    through: [-s, 0, c] as V3,
    at: (x: number, y: number, z: number): V3 => [o.x + c * x - s * z, y, o.y + s * x + c * z],
  };
}

const UP: V3 = [0, 1, 0];
const scaled = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];

/**
 * A lit room seen through a window: a glow standing well back in the room,
 * brightest about lamp height and falling away to the edges, so furniture and
 * curtains stand dark against it and the light has depth. Faces out only.
 */
function windowPane(o: PlacedOpening, side: 1 | -1, room: DetectedRoom | undefined, height: number, kit: LampKit): THREE.Mesh | null {
  const f = openingFrame(o);
  const inward: Point = { x: f.through[0] * side, y: f.through[2] * side };
  const start = o.thickness / 2 + 0.1;
  const mouth: Point = { x: o.x + inward.x * start, y: o.y + inward.y * start };
  // As deep as the room allows, up to a couple of metres; as wide as the room allows either side.
  const deepest = room ? reach(room.polygon, mouth, inward) - o.thickness / 2 - 0.15 : 1.2;
  const depth = Math.max(0.3, Math.min(1.8, deepest * 0.85));
  const z = side * (start + depth);
  const centre = f.at(0, 0, z);
  const c2: Point = { x: centre[0], y: centre[2] };
  const lateral = (sgn: number): number => {
    const dir: Point = { x: f.along[0] * sgn, y: f.along[2] * sgn };
    const room2 = room ? reach(room.polygon, c2, dir) - o.thickness / 2 - 0.08 : Infinity;
    return Math.max(o.width / 2, Math.min(o.width / 2 + depth * 0.9 + 0.25, room2));
  };
  const left = lateral(-1);
  const right = lateral(1);
  const bottom = Math.max(0.05, o.y0 - depth * 0.8 - 0.1);
  const top = Math.max(o.y1 + 0.1, Math.min(height - 0.05, o.y1 + depth * 0.8 + 0.3));
  if (!finite(left, right, bottom, top, depth) || top - bottom < 0.2) return null;
  const midY = Math.min(top - 0.2, (o.y0 + o.y1) / 2 + 0.25);
  const geo = paintedGrid(
    f.at(0, 0, z),
    f.along,
    UP,
    [-left, right, bottom, top],
    [8, 6],
    scaled(f.through, -side),
    (u, v) => {
      const ru = u < 0 ? -u / left : u / right;
      const rv = v < midY ? (midY - v) / (midY - bottom) : (v - midY) / (top - midY);
      const r = Math.min(1, Math.hypot(ru, rv * 0.9));
      // Warm and strong in the middle, deeper orange and dimmer out at the edges; darker toward the floor.
      const core = Math.pow(1 - smooth(0, 1, r), 1.4);
      const floor = 0.55 + 0.45 * smooth(bottom, midY, v);
      const k = (0.6 + 6.4 * core) * floor;
      const edge = Math.min(1 - Math.abs(ru), 1 - Math.abs(rv));
      return [k, k * (0.82 + 0.18 * core), k * (0.62 + 0.38 * core), smooth(0, 0.3, edge)];
    },
  );
  const mesh = new THREE.Mesh(geo, kit.pane);
  // Drawn before the glass, so the glass's sky still lies over it.
  mesh.renderOrder = 1;
  mesh.name = 'window-glow';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  return mesh;
}

/** Added light, laid over a surface: casts nothing, catches nothing, can't be picked. */
function spillMesh(geo: THREE.BufferGeometry, name: string, kit: LampKit): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, kit.spill);
  mesh.name = name;
  mesh.renderOrder = 4;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  return mesh;
}

/** The room's light falling out of a window: a warm wash on the sill, and a soft pool on the ground under it. */
function windowSpill(o: PlacedOpening, side: 1 | -1, group: THREE.Group, kit: LampKit): void {
  const f = openingFrame(o);
  const out = -side;
  const outward = scaled(f.through, out);
  const w = o.width;
  const add = (geo: THREE.BufferGeometry, name: string) => group.add(spillMesh(geo, name, kit));
  if (o.y0 > 0.05) {
    // The sill's top, outside the frame (see buildWindow: its top is 32 mm over the opening's foot).
    const a = o.thickness / 2 + 0.015;
    const b = o.thickness / 2 + 0.09;
    add(
      paintedGrid(f.at(0, o.y0 + 0.034, 0), f.along, outward, [-w / 2 - 0.08, w / 2 + 0.08, a, b], [4, 1], UP, (u, v) => {
        const k = 0.5 * (1 - smooth(w / 2 - 0.1, w / 2 + 0.08, Math.abs(u))) * (1 - 0.6 * smooth(a, b, v));
        return [k, k, k, 1];
      }),
      'window-spill',
    );
  }
  // A pool on the ground, starting at the wall and spreading as it goes; higher windows throw it further out.
  const near = o.thickness / 2 + 0.06;
  const length = 0.9 + Math.min(1.2, o.y0 * 0.6);
  const peak = Math.min(0.5, 0.15 + o.y0 * 0.25);
  add(
    paintedGrid(f.at(0, 0.022, 0), f.along, outward, [-w / 2 - 0.9, w / 2 + 0.9, near, near + length], [6, 4], UP, (u, v) => {
      const t = (v - near) / length;
      const half = w / 2 + 0.15 + 0.75 * t;
      const across = 1 - smooth(half * 0.45, half, Math.abs(u));
      const rise = smooth(0, peak, t);
      const fall = 1 - smooth(peak, 1, t);
      const k = 0.3 * across * rise * fall;
      return [k, k, k, 1];
    }),
    'window-spill',
  );
}

/**
 * A small lantern on the wall beside an outside door, with its warm wash on
 * the wall. Only where there is wall to hang it on: latch side first, else the hinge side.
 */
function doorLantern(o: PlacedOpening, side: 1 | -1, pieces: WallPiece[], group: THREE.Group, kit: LampKit): void {
  const f = openingFrame(o);
  const out = -side;
  const y = Math.min(2.2, Math.max(1.4, o.y1 - 0.2));
  const offset = o.width / 2 + 0.07 + 0.2;
  const wall = pieces.filter((p) => p.wallId === o.wallId && p.y0 <= y - 0.3 && p.y1 >= y + 0.3);
  const fits = (x: number): boolean =>
    [x - 0.12, x + 0.12].every((xx) => {
      const p = f.at(xx, 0, 0);
      return wall.some((w) => pointInPolygon({ x: p[0], y: p[2] }, w.poly));
    });
  const x = [offset, -offset].find(fits);
  if (x === undefined) return;
  const face = o.thickness / 2 + 0.036; // just proud of any siding
  const lantern = new THREE.Group();
  lantern.name = 'door-lantern';
  // Built in the opening's frame, then set into the world.
  lantern.position.set(o.x, 0, o.y);
  lantern.rotation.y = -o.angle;
  const z = (d: number): number => out * (face + d);
  const part = (mat: THREE.Material, w: number, h: number, d: number, py: number, pz: number) => {
    const m = boxMesh('lantern', mat, w, h, d, x, py, z(pz), false);
    m.receiveShadow = false;
    lantern.add(m);
  };
  part(kit.lanternMetal, 0.08, 0.2, 0.014, y + 0.02, 0.007); // back plate
  part(kit.lanternMetal, 0.025, 0.025, 0.06, y + 0.1, 0.044); // arm
  part(kit.lanternMetal, 0.15, 0.03, 0.15, y + 0.125, 0.11); // hood
  part(kit.lantern, 0.11, 0.16, 0.11, y + 0.03, 0.11); // the glowing glass
  part(kit.lanternMetal, 0.13, 0.02, 0.13, y - 0.06, 0.11); // base
  group.add(lantern);
  // Its light on the wall round it.
  const r = 0.75;
  const centre = f.at(x, y, out * (o.thickness / 2 + 0.05));
  const wash = paintedGrid(centre, f.along, UP, [-r, r, -r, r], [6, 6], scaled(f.through, out), (u, v) => {
    const d = Math.hypot(u, v * 1.15) / r;
    const k = 0.32 * Math.pow(1 - smooth(0, 1, d), 2);
    return [k, k, k, 1];
  });
  group.add(spillMesh(wash, 'lantern-spill', kit));
}

/**
 * One warm ceiling lamp per roofed room, for evening views: a light, and a
 * small glowing fitting where the ceiling is. Seen from outside, each lit
 * window glows from deep in its room (`panes`; leave them out where the rooms
 * are looked into from above), throws a little light on its sill and the
 * ground, and each outside door gets a lantern. Scene dressing only.
 */
export function buildRoomLamps(
  rooms: DetectedRoom[],
  height: number,
  open?: ReadonlySet<string> | null,
  openings: PlacedOpening[] = [],
  pieces: WallPiece[] = [],
  panes = true,
): THREE.Group {
  const kit = lampKitOf();
  const inside = insideSides(pieces);
  const group = new THREE.Group();
  group.name = 'lamps';
  const y = Math.max(1.8, height - 0.35);
  for (const room of rooms.slice(0, 24)) {
    if (open?.has(room.key) || !finite(room.centroid.x, room.centroid.y)) continue;
    // Bigger rooms get a stronger lamp; a closet gets a small one.
    const power = Math.min(1.6, Math.max(0.45, Math.sqrt(room.area) / 3.6));
    const light = new THREE.PointLight('#ffd9a8', 9 * power, 0, 2);
    light.position.set(room.centroid.x, y, room.centroid.y);
    light.name = 'lamp';
    group.add(light);
    const fitting = new THREE.Mesh(kit.fittingGeometry, kit.fitting);
    fitting.position.copy(light.position);
    fitting.name = 'lamp-fitting';
    group.add(fitting);
  }
  for (const o of openings) {
    if (!finite(o.x, o.y, o.angle, o.width, o.y0, o.y1, o.thickness) || o.width < 0.2 || o.y1 - o.y0 < 0.2) continue;
    // Only openings in an outside wall; without the wall pieces, the window's +z side is taken as the room.
    const side = pieces.length > 0 ? (inside.get(o.wallId) ?? 0) : 1;
    if (side === 0) continue;
    if (o.type === 'door') {
      doorLantern(o, side, pieces, group, kit);
      continue;
    }
    // The room behind it, unless it is open to the sky (nothing lit there).
    const f = openingFrame(o);
    const probe: Point = {
      x: o.x + f.through[0] * side * (o.thickness / 2 + 0.2),
      y: o.y + f.through[2] * side * (o.thickness / 2 + 0.2),
    };
    const room = rooms.find((r) => pointInPolygon(probe, r.polygon));
    if (room && open?.has(room.key)) continue;
    if (panes) {
      const pane = windowPane(o, side, room, height, kit);
      if (pane) group.add(pane);
    }
    windowSpill(o, side, group, kit);
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
  house.add(buildOpenings(model.openings, kit, model.pieces));
  house.add(buildFloors(rooms, plan.roomNames, kit, open));
  if (opts.ceilings) house.add(buildCeilings(rooms, settings.wallHeight, kit, open));
  if (opts.roof !== 'none') house.add(buildRoofGroup(buildRoof(opts.roof, { rooms, walls, settings, open }), kit));
  house.add(buildFurniture(plan.furniture, kit));
  return house;
}
