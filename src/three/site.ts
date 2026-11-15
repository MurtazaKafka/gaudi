/**
 * The ground the house stands on: a lot, a doorstep and path at the entrance,
 * and a soft dark edge where the walls meet the ground. Scene dressing only —
 * none of it is part of the plan or of exported models.
 *
 * `planSite` is plain numbers (testable without a renderer); `buildSite`
 * turns it into meshes whose colours follow the ground through `setGround`.
 */
import * as THREE from 'three';
import type { PlacedOpening } from '../build';
import { pointInPolygon } from '../geometry';
import type { Point, Wall } from '../types';
import { offsetLoop, safeOffset, unionRegions } from './footprint';
import type { Rect } from './footprint';
import { luminance, mixHex } from './sun';

export interface Entrance {
  /** Door center on the wall line. */
  x: number;
  y: number;
  /** Unit vector pointing out of the house. */
  nx: number;
  ny: number;
  width: number;
  /** The leaf opens toward the street (see `buildDoor`: it swings to the wall's −normal side). */
  opensOut: boolean;
}

export interface SitePlan {
  lot: Rect;
  entrance: Entrance | null;
  /** Four corners each, plan meters; null without an entrance. */
  step: Point[] | null;
  path: Point[] | null;
  /** Per building: the wall line, and rings further out where the ground shadow fades. */
  skirts: { inner: Point[]; mid: Point[]; outer: Point[] }[];
}

export interface SiteInput {
  /** Every detected room, open-air ones included. */
  rooms: { polygon: Point[] }[];
  walls: Wall[];
  openings: PlacedOpening[];
  wallThickness: number;
}

const STEP_DEPTH = 0.5;
export const STEP_HEIGHT = 0.07;
/** Under a leaf that swings out over it, the step is only a paving slab. */
const STEP_HEIGHT_FLUSH = 0.005;
const SKIRT_REACH = 0.9;

const FRONT = /entr|front|main/i;

/** The door people arrive at: an outside door, the one labelled as the entrance if any. */
export function findEntrance(input: SiteInput): Entrance | null {
  const { rooms, openings, wallThickness } = input;
  if (rooms.length === 0) return null;
  const indoors = (p: Point): boolean => rooms.some((r) => pointInPolygon(p, r.polygon));
  const reach = wallThickness / 2 + 0.3;
  let best: Entrance | null = null;
  let bestScore = -Infinity;
  for (const o of openings) {
    if (o.type !== 'door' || ![o.x, o.y, o.angle, o.width].every(Number.isFinite)) continue;
    const nx = -Math.sin(o.angle);
    const ny = Math.cos(o.angle);
    const a = indoors({ x: o.x + nx * reach, y: o.y + ny * reach });
    const b = indoors({ x: o.x - nx * reach, y: o.y - ny * reach });
    if (a === b) continue; // an inside door, or a door in a free-standing wall
    const score = (FRONT.test(o.label ?? '') ? 100 : 0) + o.width;
    if (score > bestScore) {
      bestScore = score;
      best = { x: o.x, y: o.y, nx: a ? -nx : nx, ny: a ? -ny : ny, width: o.width, opensOut: a };
    }
  }
  return best;
}

export function planSite(input: SiteInput): SitePlan | null {
  const walls = input.walls.filter((w) => [w.a.x, w.a.y, w.b.x, w.b.y].every(Number.isFinite));
  if (walls.length === 0) return null;
  const h = Math.max(0, input.wallThickness) / 2;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const w of walls) {
    for (const p of [w.a, w.b]) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  }
  const size = Math.max(x1 - x0, y1 - y0);
  if (!(size > 0.2) || size > 2000) return null;
  const margin = Math.min(9, Math.max(3, size * 0.3));
  const lot: Rect = { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };

  const entrance = findEntrance(input);
  let step: Point[] | null = null;
  let path: Point[] | null = null;
  if (entrance) {
    const { x, y, nx, ny, width } = entrance;
    // A little more garden on the side people arrive from.
    const front = margin * 0.5;
    if (nx > 0.7) lot.x1 += front;
    else if (nx < -0.7) lot.x0 -= front;
    else if (ny > 0.7) lot.y1 += front;
    else if (ny < -0.7) lot.y0 -= front;

    const tx = -ny;
    const ty = nx;
    const quad = (near: number, far: number, half: number): Point[] => [
      { x: x + nx * near - tx * half, y: y + ny * near - ty * half },
      { x: x + nx * near + tx * half, y: y + ny * near + ty * half },
      { x: x + nx * far + tx * half, y: y + ny * far + ty * half },
      { x: x + nx * far - tx * half, y: y + ny * far - ty * half },
    ];
    step = quad(h, h + STEP_DEPTH, width / 2 + 0.25);

    // Straight out to the edge of the lot — or as far as the way is clear.
    const hits: number[] = [];
    if (nx > 1e-6) hits.push((lot.x1 - x) / nx);
    if (nx < -1e-6) hits.push((lot.x0 - x) / nx);
    if (ny > 1e-6) hits.push((lot.y1 - y) / ny);
    if (ny < -1e-6) hits.push((lot.y0 - y) / ny);
    let far = Math.min(...hits.filter((t) => t > 0));
    const half = Math.max(0.5, width / 2 + 0.05);
    const blocked = (t: number): boolean =>
      [-half, 0, half].some((s) => {
        const p = { x: x + nx * t + tx * s, y: y + ny * t + ty * s };
        return input.rooms.some((r) => pointInPolygon(p, r.polygon));
      });
    if (Number.isFinite(far)) {
      for (let t = h + STEP_DEPTH; t < far; t += 0.2) {
        if (blocked(t + 0.3)) {
          far = t;
          break;
        }
      }
      if (far - (h + STEP_DEPTH) > 0.3) path = quad(h + STEP_DEPTH, far, half);
    }
  }

  const skirts: SitePlan['skirts'] = [];
  for (const region of unionRegions(input.rooms.map((r) => r.polygon))) {
    const inner = safeOffset(region.outer, h);
    const mid = offsetLoop(inner, SKIRT_REACH * 0.3);
    const outer = offsetLoop(inner, SKIRT_REACH);
    const sound = [inner, mid, outer].every(
      (loop) => loop.length === inner.length && loop.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    );
    if (inner.length >= 3 && sound) skirts.push({ inner, mid, outer });
  }

  return { lot, entrance, step, path, skirts };
}

// ---------- meshes ----------

export interface Site {
  group: THREE.Group;
  /** Recolour everything from the ground colour of the moment (it shifts with the sun). */
  setGround: (hex: string) => void;
  dispose: () => void;
}

/** A flat four-cornered patch at height `y`, facing up whichever way the corners run. */
function flatQuad(corners: Point[], y: number): THREE.BufferGeometry {
  const [a, b, c, d] = corners;
  // In plan (y south) a positive shoelace is clockwise seen from above: flip it to face the sky.
  const flip = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
  const order = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(order.flatMap((p) => [p.x, y, p.y]), 3));
  geo.computeVertexNormals();
  return geo;
}

/** Two bands per building, opaque at the wall and fading to nothing. */
function skirtGeometry(skirts: SitePlan['skirts'], y: number): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const band = (a: Point[], b: Point[], alphaA: number, alphaB: number) => {
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const quad: [Point, number][] = [
        [a[i], alphaA], [a[j], alphaA], [b[j], alphaB],
        [a[i], alphaA], [b[j], alphaB], [b[i], alphaB],
      ];
      for (const [p, alpha] of quad) {
        positions.push(p.x, y, p.y);
        colors.push(1, 1, 1, alpha);
      }
    }
  };
  for (const s of skirts) {
    band(s.inner, s.mid, 1, 0.32);
    band(s.mid, s.outer, 0.32, 0);
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  return geo;
}

export function buildSite(plan: SitePlan | null): Site {
  const group = new THREE.Group();
  group.name = 'site';
  // Thin layers lying on the ground: polygon offset keeps them from flickering against it at a distance.
  // Pushed back in depth, never pulled forward: a layer pulled toward the camera paints over the room floors a centimeter above it.
  const layer = (n: number) => ({ polygonOffset: true, polygonOffsetFactor: 4 - n, polygonOffsetUnits: 4 - n });
  const lotMat = new THREE.MeshStandardMaterial({ roughness: 1, ...layer(1) });
  const edgeMat = new THREE.LineBasicMaterial();
  const pathMat = new THREE.MeshStandardMaterial({ roughness: 0.95, ...layer(3) });
  const shadeMat = new THREE.MeshBasicMaterial({
    transparent: true,
    vertexColors: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    ...layer(2),
  });
  const materials = [lotMat, edgeMat, pathMat, shadeMat];

  if (plan) {
    const { lot } = plan;
    const corners: Point[] = [
      { x: lot.x0, y: lot.y0 },
      { x: lot.x1, y: lot.y0 },
      { x: lot.x1, y: lot.y1 },
      { x: lot.x0, y: lot.y1 },
    ];
    const lotMesh = new THREE.Mesh(flatQuad(corners, 0.002), lotMat);
    lotMesh.name = 'lot';
    lotMesh.receiveShadow = true;
    group.add(lotMesh);

    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(corners.map((p) => new THREE.Vector3(p.x, 0.012, p.y))),
      edgeMat,
    );
    line.name = 'lot-edge';
    line.raycast = () => {};
    group.add(line);

    const shade = skirtGeometry(plan.skirts, 0.004);
    if (shade) {
      const mesh = new THREE.Mesh(shade, shadeMat);
      mesh.name = 'contact-shadow';
      mesh.renderOrder = 1;
      mesh.raycast = () => {};
      group.add(mesh);
    }

    if (plan.path) {
      const mesh = new THREE.Mesh(flatQuad(plan.path, 0.006), pathMat);
      mesh.name = 'path';
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (plan.step && plan.entrance) {
      const [a, b, , d] = plan.step;
      const w = Math.hypot(b.x - a.x, b.y - a.y);
      const depth = Math.hypot(d.x - a.x, d.y - a.y);
      const height = plan.entrance.opensOut ? STEP_HEIGHT_FLUSH : STEP_HEIGHT;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, height, depth), pathMat);
      const cx = plan.step.reduce((s, p) => s + p.x, 0) / 4;
      const cy = plan.step.reduce((s, p) => s + p.y, 0) / 4;
      mesh.position.set(cx, height / 2, cy);
      mesh.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
      mesh.name = 'doorstep';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  return {
    group,
    setGround: (hex) => {
      const dark = luminance(hex) < 0.35;
      // The lot is a shade off the ground around it; the path a paler strip across it.
      lotMat.color.set(dark ? mixHex(hex, '#ffffff', 0.05) : mixHex(hex, '#6f6c58', 0.1));
      edgeMat.color.set(dark ? mixHex(hex, '#ffffff', 0.16) : mixHex(hex, '#4a463c', 0.2));
      pathMat.color.set(dark ? mixHex(hex, '#ffffff', 0.16) : mixHex(hex, '#ffffff', 0.5));
      shadeMat.color.set(dark ? '#000000' : mixHex(hex, '#1d1a14', 0.85));
      shadeMat.opacity = dark ? 0.3 : 0.2;
    },
    dispose: () => {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const m of materials) m.dispose();
    },
  };
}
