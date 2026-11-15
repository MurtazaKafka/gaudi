/**
 * The live 3D view's camera, for code outside the canvas that needs to move
 * it (the demo tour). Set while a model view is mounted. No three.js import:
 * the app shell may read this without loading the 3D bundle.
 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set: (x: number, y: number, z: number) => unknown;
}

export interface SceneHandle {
  camera: { position: Vec3Like };
  controls: { target: Vec3Like; update: () => void } | null;
  /** True once a photographed sky is lighting the scene (styled looks). */
  lit: () => boolean;
  /** The view draws on demand: ask for a frame after moving anything. */
  invalidate: () => void;
}

export const sceneHandle: { current: SceneHandle | null } = { current: null };
