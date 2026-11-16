/**
 * Furniture parts → three.js objects. Pure three (no React), shared by the
 * live scene, product previews and the GLB exporter so a part looks the same
 * everywhere.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { FurnitureDef, Part } from '../catalog';
import { withBounce } from './bounce';

const DEG = Math.PI / 180;

export function partGeometry(p: Part): THREE.BufferGeometry {
  switch (p.shape) {
    case 'box':
      return new THREE.BoxGeometry(p.w ?? 0.1, p.h ?? 0.1, p.d ?? 0.1);
    case 'rbox': {
      const w = p.w ?? 0.1;
      const h = p.h ?? 0.1;
      const d = p.d ?? 0.1;
      const radius = Math.min(p.bevel ?? Math.min(w, h, d) * 0.15, Math.min(w, h, d) / 2 - 1e-4);
      return radius > 1e-4 ? new RoundedBoxGeometry(w, h, d, 3, radius) : new THREE.BoxGeometry(w, h, d);
    }
    case 'cylinder':
      return new THREE.CylinderGeometry(p.r2 ?? p.r ?? 0.05, p.r ?? 0.05, p.h ?? 0.1, 28);
    case 'cone':
      return new THREE.ConeGeometry(p.r ?? 0.05, p.h ?? 0.1, 28);
    case 'sphere': {
      if (p.w !== undefined && p.h !== undefined && p.d !== undefined) {
        const g = new THREE.SphereGeometry(0.5, 24, 16);
        g.scale(p.w, p.h, p.d);
        return g;
      }
      return new THREE.SphereGeometry(p.r ?? 0.05, 24, 16);
    }
    case 'torus': {
      const g = new THREE.TorusGeometry(p.r ?? 0.1, p.r2 ?? 0.02, 12, 36);
      g.rotateX(Math.PI / 2); // lie flat: ring axis along y
      return g;
    }
  }
}

export interface PartMaterialProps {
  color: string;
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
  transparent: boolean;
  opacity: number;
}

export function partMaterialProps(p: Part, color = p.color): PartMaterialProps {
  const opacity = p.opacity ?? 1;
  return {
    color,
    roughness: p.rough ?? 0.9,
    metalness: p.metal ?? 0,
    emissive: p.glow ? color : '#000000',
    emissiveIntensity: p.glow ?? 0,
    transparent: opacity < 1,
    opacity,
  };
}

/** Euler rotation (radians, order XYZ) for a part. */
export function partRotation(p: Part): [number, number, number] {
  return p.rot ? [p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG] : [0, 0, 0];
}

const materialKey = (m: PartMaterialProps): string =>
  `${m.color}|${m.roughness}|${m.metalness}|${m.emissiveIntensity}|${m.opacity}`;

const geometryKey = (p: Part): string =>
  `${p.shape}|${p.w ?? ''}|${p.h ?? ''}|${p.d ?? ''}|${p.r ?? ''}|${p.r2 ?? ''}|${p.bevel ?? ''}`;

const sharedGeometries = new Map<string, THREE.BufferGeometry>();

/**
 * A geometry shared by every part of the same shape and size (a house has
 * dozens of identical chair legs). Marked `userData.shared` — never dispose it.
 */
export function sharedPartGeometry(p: Part): THREE.BufferGeometry {
  const key = geometryKey(p);
  let geo = sharedGeometries.get(key);
  if (!geo) {
    if (sharedGeometries.size > 4000) sharedGeometries.clear(); // runaway guard; three re-uploads on demand
    geo = partGeometry(p);
    geo.userData.shared = true;
    sharedGeometries.set(key, geo);
  }
  return geo;
}

/**
 * Build one mesh imperatively. Pass a cache to share materials across parts;
 * `color` overrides the part's own (style tints); `shared` reuses geometry
 * across identical parts instead of making a fresh one.
 */
export function buildPartMesh(
  p: Part,
  cache?: Map<string, THREE.MeshStandardMaterial>,
  color?: string,
  shared = false,
): THREE.Mesh {
  const props = partMaterialProps(p, color ?? p.color);
  const key = materialKey(props);
  let material = cache?.get(key);
  if (!material) {
    // Indoors, lit by the room it stands in (see bounce.ts).
    material = withBounce(new THREE.MeshStandardMaterial(props));
    cache?.set(key, material);
  }
  const mesh = new THREE.Mesh(shared ? sharedPartGeometry(p) : partGeometry(p), material);
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.set(...partRotation(p));
  mesh.castShadow = props.opacity > 0.5;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A whole furniture model as a group in its local frame (origin on the floor,
 * centered). `tint` remaps part colors (style palettes).
 */
export function buildItemGroup(
  def: FurnitureDef,
  cache?: Map<string, THREE.MeshStandardMaterial>,
  tint?: (color: string) => string,
  shared = false,
): THREE.Group {
  const group = new THREE.Group();
  for (const p of def.parts) group.add(buildPartMesh(p, cache, tint ? tint(p.color) : undefined, shared));
  return group;
}
