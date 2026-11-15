/**
 * Loads the photographed materials (public/textures) as three.js textures.
 * Each id is loaded once and shared; UVs everywhere are in meters, so a
 * texture's `repeat` carries its real-world size.
 */
import * as THREE from 'three';
import { TEXTURES, type TextureId } from './surfaces';

export interface SurfaceMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const cache = new Map<TextureId, SurfaceMaps>();
const listeners = new Set<() => void>();
let pending = 0;
let idle: (() => void)[] = [];

/** Called whenever a texture finishes loading (the 3D view draws on demand and needs to hear). */
export function onTextureLoad(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Resolves once nothing is still loading — for renders and exports that need the pixels. */
export function texturesReady(): Promise<void> {
  if (pending === 0) return Promise.resolve();
  return new Promise((resolve) => idle.push(resolve));
}

function settle(): void {
  pending = Math.max(0, pending - 1);
  for (const fn of [...listeners]) fn();
  if (pending === 0) {
    const waiting = idle;
    idle = [];
    for (const fn of waiting) fn();
  }
}

const BASE = `${import.meta.env?.BASE_URL ?? '/'}textures/`;

function load(id: TextureId, file: string, color: boolean): THREE.Texture {
  pending++;
  const texture = new THREE.TextureLoader().load(`${BASE}${id}/${file}.jpg`, settle, undefined, settle);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const repeat = 1 / TEXTURES[id].size;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = `${id}-${file}`;
  return texture;
}

/** The maps for a material, or null outside a browser (node tests, server-side). */
export function surfaceMaps(id: TextureId): SurfaceMaps | null {
  if (typeof document === 'undefined') return null;
  let maps = cache.get(id);
  if (!maps) {
    maps = {
      map: load(id, 'color', true),
      normalMap: load(id, 'normal', false),
      roughnessMap: load(id, 'rough', false),
    };
    cache.set(id, maps);
  }
  return maps;
}
