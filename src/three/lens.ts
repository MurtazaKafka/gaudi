/**
 * Camera habits of an architectural photographer.
 *
 * Straight verticals: a camera tilted up or down makes upright walls lean in
 * (the house looks like a model on a table). Architectural photographers
 * keep the camera level and shift the lens instead, so verticals stay
 * vertical. Here the camera is levelled and the picture shifted so that the
 * point being looked at stays where it was — for one frame, then put back,
 * so the orbit controls never notice. Looking steeply down (an aerial view)
 * would need an absurd shift, so the correction fades out as the camera tips
 * past about 30°.
 */
import * as THREE from 'three';

export type Lens = 'wide' | 'normal' | 'long';

/** Vertical field of view per lens (degrees): roughly 24, 35 and 70 mm on a full-frame camera. */
export const LENS_FOV: Record<Lens, number> = { wide: 62, normal: 42, long: 24 };

export const LENSES: readonly { id: Lens; label: string; hint: string }[] = [
  { id: 'wide', label: 'Wide', hint: '24 mm' },
  { id: 'normal', label: 'Normal', hint: '35 mm' },
  { id: 'long', label: 'Long', hint: '70 mm' },
];

/**
 * How far back a camera with this lens stands to frame what the normal lens frames:
 * 1 for normal, less for wide, more for long.
 */
export function lensReach(lens: Lens): number {
  const fov = LENS_FOV[lens] ?? LENS_FOV.normal;
  return Math.tan(((LENS_FOV.normal / 2) * Math.PI) / 180) / Math.tan(((fov / 2) * Math.PI) / 180);
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const look = new THREE.Vector3();
const toTarget = new THREE.Vector3();
const inView = new THREE.Vector3();

/**
 * Level `camera` toward `target` and shift its picture so `target` stays put.
 * Returns a function that puts the camera exactly back.
 */
export function straighten(camera: THREE.PerspectiveCamera, target: THREE.Vector3): () => void {
  toTarget.subVectors(target, camera.position);
  const level = Math.hypot(toTarget.x, toTarget.z);
  if (level < 1e-4) return () => {};
  const pitch = Math.atan2(toTarget.y, level);
  // Full correction up to ~20° of tilt, none past ~34°.
  const k = 1 - smooth(0.35, 0.6, Math.abs(pitch));
  if (k < 0.01) return () => {};

  const quaternion = camera.quaternion.clone();
  const tilt = pitch * (1 - k);
  look.set(
    camera.position.x + toTarget.x,
    camera.position.y + Math.tan(tilt) * level,
    camera.position.z + toTarget.z,
  );
  camera.lookAt(look);
  camera.updateMatrixWorld(true);

  // Where the target now lands, and the shift that brings it back to the middle.
  inView.copy(target).applyMatrix4(camera.matrixWorldInverse);
  if (inView.z < -1e-4) {
    const e = camera.projectionMatrix.elements;
    const ndcY = (-e[5] * inView.y) / inView.z;
    e[9] = ndcY;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  return () => {
    camera.quaternion.copy(quaternion);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
  };
}
