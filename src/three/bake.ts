/**
 * One object per material instead of one per piece.
 *
 * The builders make a house the way it is thought about: a mesh for every
 * wall piece, every window frame, every chair leg. That is right for a house —
 * each piece can rise, drop in, be picked — and ruinous for a plan of many
 * buildings, where it means a hundred thousand separate things to draw, each
 * one a call to the graphics card, every frame. `bakeLayer` folds a finished
 * layer into as few meshes as its materials allow: the picture is the same,
 * the pieces are gone, and drawing it costs a few dozen calls.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A layer with more meshes than this is worth folding together. */
export const BAKE_ABOVE = 2500;

/** How many meshes are under `root` (stops counting once past `limit`). */
export function meshCount(root: THREE.Object3D | null, limit = Infinity): number {
  let n = 0;
  root?.traverse((o) => {
    if (n <= limit && (o as THREE.Mesh).isMesh) n++;
  });
  return n;
}

interface Bucket {
  sample: THREE.Mesh;
  material: THREE.Material;
  parts: THREE.BufferGeometry[];
}

/**
 * What a mesh is, without which one it is: a piece named after itself ("wall-3f2a", the key it
 * animates by) counts as a "wall"; names that say what something is ("sill", "roof-tiles") stand.
 */
function kindOf(mesh: THREE.Mesh): string {
  const own = mesh.userData.key;
  return typeof own === 'string' && mesh.name === own ? mesh.name.split('-')[0] : mesh.name;
}

/** Is everything from `o` up to (not including) `root` switched on? */
function shown(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}

/** The triangles `start … start + count` of an unindexed geometry, as their own geometry. */
function slice(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const size = a.itemSize;
    const array = (a.array as Float32Array).slice(start * size, (start + count) * size);
    out.setAttribute(name, new THREE.BufferAttribute(array, size, a.normalized));
  }
  return out;
}

/** Turn every triangle to face the other way (for a piece that was mirrored into place). */
function flip(g: THREE.BufferGeometry): void {
  for (const attr of Object.values(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const size = a.itemSize;
    const array = a.array as Float32Array;
    for (let i = 0; i + 3 * size <= array.length; i += 3 * size) {
      for (let k = 0; k < size; k++) {
        const t = array[i + size + k];
        array[i + size + k] = array[i + 2 * size + k];
        array[i + 2 * size + k] = t;
      }
    }
  }
}

/**
 * Fold a built layer into one mesh per material (and per name, shadow setting and vertex
 * layout, so everything that tells meshes apart still does). Returns a new group standing
 * where `root` stands; `root` itself is left untouched and still owns its own geometry.
 * Anything that is not a plain mesh (a light, an instanced mesh) is moved across as it is.
 */
export function bakeLayer(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, Bucket>();
  const others: THREE.Object3D[] = [];
  const place = new THREE.Matrix4();

  const add = (mesh: THREE.Mesh, material: THREE.Material, geometry: THREE.BufferGeometry): void => {
    const layout = Object.entries(geometry.attributes)
      .map(([name, a]) => `${name}${(a as THREE.BufferAttribute).itemSize}`)
      .sort()
      .join(',');
    const key = [material.uuid, kindOf(mesh), mesh.castShadow, mesh.receiveShadow, mesh.renderOrder, mesh.layers.mask, layout].join('|');
    const bucket = buckets.get(key);
    if (bucket) bucket.parts.push(geometry);
    else buckets.set(key, { sample: mesh, material, parts: [geometry] });
  };

  root.traverse((o) => {
    if (o === root) return;
    const mesh = o as THREE.Mesh;
    const plain = mesh.isMesh && !(mesh as unknown as THREE.InstancedMesh).isInstancedMesh && !(mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh;
    if (!plain) {
      if ((o as THREE.Light).isLight || (mesh.isMesh && !plain)) others.push(o);
      return;
    }
    if (!shown(mesh, root) || !mesh.geometry?.attributes.position) return;
    place.multiplyMatrices(toRoot, mesh.matrixWorld);
    const flat = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    // Only what every piece of a kind has: stray extras would stop them folding together.
    for (const name of Object.keys(flat.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) flat.deleteAttribute(name);
    flat.morphAttributes = {};
    flat.applyMatrix4(place);
    if (place.determinant() < 0) flip(flat);
    const groups = mesh.geometry.groups;
    if (Array.isArray(mesh.material)) {
      const materials = mesh.material;
      if (groups.length === 0) add(mesh, materials[0], flat);
      else {
        for (const g of groups) {
          const material = materials[g.materialIndex ?? 0];
          const count = Math.min(g.count, flat.attributes.position.count - g.start);
          if (material && count > 0) add(mesh, material, slice(flat, g.start, count));
        }
        flat.dispose();
      }
    } else add(mesh, mesh.material, flat);
  });

  const out = new THREE.Group();
  out.name = root.name;
  out.position.copy(root.position);
  out.quaternion.copy(root.quaternion);
  out.scale.copy(root.scale);
  out.visible = root.visible;
  out.userData = { ...root.userData, baked: true };

  for (const { sample, material, parts } of buckets.values()) {
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const p of parts) p.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = kindOf(sample);
    mesh.castShadow = sample.castShadow;
    mesh.receiveShadow = sample.receiveShadow;
    mesh.renderOrder = sample.renderOrder;
    mesh.layers.mask = sample.layers.mask;
    out.add(mesh);
  }
  for (const o of others) {
    place.multiplyMatrices(toRoot, o.matrixWorld);
    const copy = o.clone();
    place.decompose(copy.position, copy.quaternion, copy.scale);
    out.add(copy);
  }
  return out;
}

/** Bake `built` if it is large enough to be worth it, disposing the pieces; otherwise hand it back. */
export function bakeIfLarge<T extends THREE.Object3D>(built: T, force = false): T | THREE.Group {
  if (!force && meshCount(built, BAKE_ABOVE) <= BAKE_ABOVE) return built;
  const baked = bakeLayer(built);
  // The pieces' own geometry is no longer drawn. Materials are shared with the kit and stay.
  const seen = new Set<THREE.BufferGeometry>();
  built.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g && !seen.has(g) && !g.userData.shared) {
      seen.add(g);
      g.dispose();
    }
  });
  return baked;
}
