/**
 * Real furniture for the catalog: low-poly models (Kenney Furniture Kit, CC0)
 * in place of the box-built parts. Each model is loaded once, normalised to a
 * unit box (centered, standing on y = 0, front toward +z), then stretched to
 * the catalog item's own width × height × depth and recoloured from the
 * style's palette — so the plan's footprint and the model always agree.
 *
 * The parts in src/catalog.ts remain the fallback (model still loading, no
 * browser) and the source of the 2D plan symbols.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BuiltinKind, FurnitureDef } from '../catalog';
import type { FurniturePalette } from './styles';
import { withBounce } from './bounce';

interface Piece {
  file: string;
  /** Quarter turns (about y) that bring the model's front to +z. */
  turn?: number;
  /** Where the piece sits inside the item's unit box: center x/z, base y, and size (all 0..1). Default: fills it. */
  box?: { x: number; y: number; z: number; w: number; h: number; d: number };
}

const one = (file: string, turn = 0): Piece[] => [{ file, turn }];

export const MODEL_FOR: Partial<Record<BuiltinKind, Piece[]>> = {
  bed_double: one('bedDouble'),
  bed_single: one('bedSingle'),
  nightstand: one('cabinetBedDrawer'),
  wardrobe: one('bookcaseClosedDoors'),
  sofa: one('loungeSofa'),
  armchair: one('loungeChair'),
  coffee_table: one('tableCoffee'),
  tv_stand: [
    { file: 'cabinetTelevision', box: { x: 0, y: 0, z: 0, w: 1, h: 0.45, d: 1 } },
    { file: 'televisionModern', box: { x: 0, y: 0.45, z: -0.1, w: 0.72, h: 0.55, d: 0.3 } },
  ],
  bookshelf: one('bookcaseOpen'),
  rug: one('rugRound'),
  plant: one('pottedPlant'),
  dining_table: one('table'),
  chair: one('chairCushion'),
  desk: one('desk'),
  counter: one('kitchenCabinet'),
  kitchen_sink: one('kitchenSink'),
  stove: one('kitchenStove'),
  fridge: one('kitchenFridge'),
  toilet: one('toilet'),
  bathroom_sink: one('bathroomSink'),
  bathtub: one('bathtub', 1),
  event_table: one('tableCloth'),
  speaker: one('speaker'),
  trash_bin: one('trashcan'),
};

/** What each of the kit's material names is, in the style palette's terms. */
type Role = keyof FurniturePalette | 'ceramic' | 'lamp';
const ROLE: Record<string, Role> = {
  wood: 'wood',
  woodDark: 'woodDark',
  carpet: 'fabric',
  carpetDarker: 'fabricDark',
  carpetWhite: 'linen',
  metal: 'steel',
  metalMedium: 'dark',
  metalDark: 'dark',
  metalLight: 'white',
  _defaultMat: 'white',
  glass: 'screen',
  plant: 'leaf',
  lamp: 'lamp',
};
/** In kitchens and bathrooms the kit's "white carpet" is enamel or porcelain. */
const CERAMIC_FILES = new Set(['toilet', 'bathroomSink', 'bathtub', 'kitchenStove', 'kitchenSink']);

const FINISH: Record<Role, { rough: number; metal: number }> = {
  wood: { rough: 0.6, metal: 0 },
  woodDark: { rough: 0.6, metal: 0 },
  fabric: { rough: 1, metal: 0 },
  fabricDark: { rough: 1, metal: 0 },
  linen: { rough: 1, metal: 0 },
  white: { rough: 0.4, metal: 0 },
  dark: { rough: 0.45, metal: 0.3 },
  screen: { rough: 0.15, metal: 0.2 },
  steel: { rough: 0.35, metal: 0.7 },
  leaf: { rough: 0.8, metal: 0 },
  pot: { rough: 0.7, metal: 0 },
  ceramic: { rough: 0.12, metal: 0 },
  lamp: { rough: 0.6, metal: 0 },
};

// ---------- loading ----------

type Template = THREE.Group;
const templates = new Map<string, Template | null>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Called when a model arrives, so furniture built with the fallback can be rebuilt. */
export function onModelLoad(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Resolves when nothing is still on its way. */
export function modelsReady(): Promise<void> {
  return Promise.all([...loading.values()]).then(() => undefined);
}

const BASE = `${import.meta.env?.BASE_URL ?? '/'}models/`;

/** Center on x/z, stand on y = 0, front to +z, and scale to a unit box. */
function normalise(scene: THREE.Object3D, turn: number, file: string): Template {
  const pivot = new THREE.Group();
  pivot.add(scene);
  pivot.rotation.y = (turn * Math.PI) / 2;
  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const unit = new THREE.Group();
  unit.add(pivot);
  pivot.position.set(-center.x, -box.min.y, -center.z);
  unit.scale.set(1 / Math.max(size.x, 1e-6), 1 / Math.max(size.y, 1e-6), 1 / Math.max(size.z, 1e-6));
  const root = new THREE.Group();
  root.add(unit);
  root.userData.file = file;
  return root;
}

function request(piece: Piece): void {
  const key = `${piece.file}|${piece.turn ?? 0}`;
  if (templates.has(key) || loading.has(key) || typeof document === 'undefined') return;
  const job = new GLTFLoader()
    .loadAsync(`${BASE}${piece.file}.glb`)
    .then((gltf) => {
      templates.set(key, normalise(gltf.scene, piece.turn ?? 0, piece.file));
    })
    .catch(() => {
      templates.set(key, null); // the parts stay
    })
    .finally(() => {
      loading.delete(key);
      for (const fn of [...listeners]) fn();
    });
  loading.set(key, job);
}

// ---------- building ----------

export type FurnitureMaterials = Map<string, THREE.MeshStandardMaterial>;

function materialFor(
  name: string,
  file: string,
  palette: FurniturePalette,
  cache: FurnitureMaterials,
): THREE.MeshStandardMaterial {
  let role: Role = ROLE[name] ?? 'white';
  if (CERAMIC_FILES.has(file) && (role === 'linen' || role === 'white')) role = 'ceramic';
  const key = `model|${role}`;
  let m = cache.get(key);
  if (!m) {
    const color = role === 'ceramic' ? palette.white : role === 'lamp' ? '#ffe9b0' : palette[role];
    m = new THREE.MeshStandardMaterial({ color, roughness: FINISH[role].rough, metalness: FINISH[role].metal });
    if (role === 'lamp') {
      m.emissive.set('#ffe9b0');
      m.emissiveIntensity = 0.8;
    }
    m.name = `furniture-${role}`;
    withBounce(m);
    cache.set(key, m);
  }
  return m;
}

/**
 * The item as real furniture, sized to its definition — or null if this kind
 * has no model or it hasn't arrived yet (which also starts it loading).
 */
export function buildModelItem(
  kind: BuiltinKind,
  def: FurnitureDef,
  palette: FurniturePalette,
  cache: FurnitureMaterials,
): THREE.Group | null {
  const pieces = MODEL_FOR[kind];
  if (!pieces) return null;
  let ready = true;
  for (const p of pieces) {
    if (!templates.get(`${p.file}|${p.turn ?? 0}`)) {
      request(p);
      ready = false;
    }
  }
  if (!ready) return null;

  const group = new THREE.Group();
  for (const p of pieces) {
    const template = templates.get(`${p.file}|${p.turn ?? 0}`)!;
    const piece = template.clone(true);
    piece.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.Material | THREE.Material[];
      mesh.material = Array.isArray(src)
        ? src.map((m) => materialFor(m.name, p.file, palette, cache))
        : materialFor(src.name, p.file, palette, cache);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.geometry.userData.shared = true; // owned by the template, never disposed with the scene
    });
    const b = p.box ?? { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 };
    piece.position.set(b.x * def.w, b.y * def.h, b.z * def.d);
    piece.scale.set(b.w * def.w, b.h * def.h, b.d * def.d);
    group.add(piece);
  }
  return group;
}
