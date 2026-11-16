/**
 * The house builds itself when you first see it: walls rise in a sweep across
 * the plan, furniture settles in behind them, and the roof comes down last.
 * Under a second, once per visit — then the view is still again and stops
 * drawing. Nothing here touches the plan; it only scales what is already built.
 */
import * as THREE from 'three';

export const RISE_MS = 950;

export interface RiseParts {
  walls: THREE.Object3D | null;
  openings: THREE.Object3D | null;
  furniture: THREE.Object3D | null;
  roof: THREE.Object3D | null;
  /** Centre and half-size of the plan: the sweep runs corner to corner across it. */
  x: number;
  z: number;
  radius: number;
}

/** Lands a little past the mark and settles back. */
function settle(t: number, over: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = t - 1;
  return 1 + (over + 1) * u * u * u + over * u * u;
}

const box = new THREE.Box3();
const centre = new THREE.Vector3();

/** Where a piece stands, as a 0…1 position along the sweep. */
function along(o: THREE.Object3D, parts: RiseParts): number {
  const mesh = o as THREE.Mesh;
  let px = o.position.x;
  let pz = o.position.z;
  if (mesh.isMesh && px === 0 && pz === 0) {
    // Wall pieces are modelled in place: find them by their geometry.
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.copy(mesh.geometry.boundingBox!).getCenter(centre);
    px = centre.x;
    pz = centre.z;
  }
  const span = Math.max(1, parts.radius * 4);
  return Math.max(0, Math.min(1, (px - parts.x + (pz - parts.z)) / span + 0.5));
}

/**
 * Pose everything for a moment `t` of the build (0 = bare floor, 1 = finished).
 * At 1 every scale and offset is exactly back where it was built.
 */
export function applyRise(parts: RiseParts, t: number): void {
  const done = t >= 1;
  const each = (group: THREE.Object3D | null, start: number, sweep: number, len: number, over: number, uniform: boolean): void => {
    if (!group) return;
    for (const child of group.children) {
      const k = done ? 1 : settle((t - start - along(child, parts) * sweep) / len, over);
      if (uniform) child.scale.setScalar(Math.max(k, 0.0001));
      else child.scale.y = Math.max(k, 0.0001);
      child.visible = done || k > 0;
    }
  };
  // Walls and the frames in them move together, so a window never floats free of its wall.
  each(parts.walls, 0, 0.42, 0.4, 0.9, false);
  each(parts.openings, 0, 0.42, 0.4, 0.9, false);
  each(parts.furniture, 0.22, 0.42, 0.3, 1.6, true);
  if (parts.roof) {
    const k = done ? 1 : settle((t - 0.62) / 0.38, 0.6);
    parts.roof.position.y = (1 - k) * 1.4;
    parts.roof.visible = done || k > 0;
  }
}

/** True when the visitor has asked their system for less motion. */
export function calmMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// ---------- edits ----------

/** How long something new takes to arrive after an edit. */
export const POP_MS = 420;

export interface Pop {
  object: THREE.Object3D;
  /** Walls grow up from the floor; furniture and frames drop in and settle. */
  kind: 'grow' | 'drop';
  t: number;
}

/** Keys of everything in a layer (see the builders: walls, openings, furniture carry `userData.key`). */
export function keysOf(groups: (THREE.Object3D | null)[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) for (const c of g?.children ?? []) if (typeof c.userData.key === 'string') out.add(c.userData.key);
  return out;
}

/** What is new in `groups` since `before`. */
export function newcomers(groups: (THREE.Object3D | null)[], before: Set<string>): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const g of groups) for (const c of g?.children ?? []) if (typeof c.userData.key === 'string' && !before.has(c.userData.key)) out.push(c);
  return out;
}

/** Pose one arrival at `t` (0…1). At 1 it is exactly as built. */
export function applyPop(p: Pop, t: number): void {
  const o = p.object;
  if (t >= 1) {
    o.scale.setScalar(1);
    if (p.kind === 'drop') o.position.y = o.userData.restY ?? o.position.y;
    return;
  }
  if (p.kind === 'grow') {
    o.scale.set(1, Math.max(settle(t, 0.7), 0.0001), 1);
  } else {
    if (o.userData.restY === undefined) o.userData.restY = o.position.y;
    const k = settle(t, 1.4);
    o.scale.setScalar(Math.max(0.0001, 0.6 + 0.4 * k));
    o.position.y = o.userData.restY + (1 - Math.min(1, t * 1.6)) * 0.45;
  }
}
