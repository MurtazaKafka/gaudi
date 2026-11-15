/** Saving the current view as a picture. */
import type * as THREE from 'three';

/** A plan name as a file name: "Lake House (v2)" → "lake-house-v2". */
export function fileSlug(name: string | undefined | null, fallback = 'gaudi-plan'): string {
  return (
    (name ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || fallback
  );
}

function dataUrlBytes(url: string): Uint8Array<ArrayBuffer> {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Render one frame at `scale`× the on-screen (CSS) size and return it as PNG
 * bytes. The canvas is put back exactly as it was.
 */
export function capturePng(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  scale = 2,
  /** Draws the frame the way the screen shows it; defaults to the bare scene. */
  draw: () => void = () => gl.render(scene, camera),
): Uint8Array<ArrayBuffer> {
  const before = gl.getPixelRatio();
  const el = gl.domElement;
  const longest = Math.max(el.clientWidth, el.clientHeight, 1);
  // Stay inside what any GPU will give us for a drawing buffer.
  const ratio = Math.max(1, Math.min(scale, 8192 / longest));
  try {
    gl.setPixelRatio(ratio);
    draw();
    return dataUrlBytes(el.toDataURL('image/png'));
  } finally {
    gl.setPixelRatio(before);
    draw();
  }
}
