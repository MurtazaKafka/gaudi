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
  /** Where the path goes out through the fence: the middle of the opening on the fence line, that side's outward normal, and half the opening. */
  gate: { x: number; y: number; nx: number; ny: number; half: number } | null;
  /** The path carried on past the gate to the lane (four corners, like `path`); null without a lane. */
  walk: Point[] | null;
  /** A country lane along the street side, running off past the lot both ways: centre line a→b, and its width. */
  lane: { a: Point; b: Point; width: number } | null;
  /** Outward normal of the lot's street side: the gate's side, or the entrance's, or +y. */
  front: { nx: number; ny: number };
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
export const STEP_HEIGHT_FLUSH = 0.005;
const SKIRT_REACH = 0.9;
/** From the front fence to the near edge of the lane, and the lane's width. */
export const LANE_GAP = 2.6;
export const LANE_WIDTH = 2.8;
/** How far the lane runs on past the lot either way: into the haze. */
const LANE_RUN = 100;

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
  // Room for a garden: more behind the house than in front of it, as on a real plot.
  const margin = Math.min(12, Math.max(6, size * 0.5));
  const lot: Rect = { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };

  const entrance = findEntrance(input);
  let step: Point[] | null = null;
  let path: Point[] | null = null;
  let gate: SitePlan['gate'] = null;
  let walk: Point[] | null = null;
  let lane: SitePlan['lane'] = null;
  let front = { nx: 0, ny: 1 };
  if (entrance) {
    const { x, y, nx, ny, width } = entrance;
    // The rear of the lot, opposite the side people arrive from, half as deep again.
    const rear = margin * 0.5;
    if (Math.abs(nx) >= Math.abs(ny)) {
      front = { nx: Math.sign(nx) || 1, ny: 0 };
      if (nx > 0) lot.x0 -= rear;
      else lot.x1 += rear;
    } else {
      front = { nx: 0, ny: Math.sign(ny) || 1 };
      if (ny > 0) lot.y0 -= rear;
      else lot.y1 += rear;
    }

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
    const hits: { t: number; nx: number; ny: number }[] = [];
    if (nx > 1e-6) hits.push({ t: (lot.x1 - x) / nx, nx: 1, ny: 0 });
    if (nx < -1e-6) hits.push({ t: (lot.x0 - x) / nx, nx: -1, ny: 0 });
    if (ny > 1e-6) hits.push({ t: (lot.y1 - y) / ny, nx: 0, ny: 1 });
    if (ny < -1e-6) hits.push({ t: (lot.y0 - y) / ny, nx: 0, ny: -1 });
    const exit = hits.filter((k) => k.t > 0).sort((p, q) => p.t - q.t)[0];
    let far = exit ? exit.t : Infinity;
    let reached = true;
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
          reached = false;
          break;
        }
      }
      if (far - (h + STEP_DEPTH) > 0.3) path = quad(h + STEP_DEPTH, far, half);
    }

    // Out through a gate in the fence, and on across the verge to a lane that runs along the front.
    if (path && reached && exit) {
      front = { nx: exit.nx, ny: exit.ny };
      const g = { x: x + nx * far, y: y + ny * far };
      // Across the fence line, the path is this much wider than it is square on.
      const facing = nx * exit.nx + ny * exit.ny;
      gate = { x: g.x, y: g.y, nx: exit.nx, ny: exit.ny, half: half / Math.max(0.5, facing) + 0.1 };
      if (facing > 0.6) {
        walk = quad(far, far + (LANE_GAP + 0.5) / facing, half);
        // Along the street side of the lot, out past both ends.
        const sx = -exit.ny;
        const sy = exit.nx;
        const off = LANE_GAP + LANE_WIDTH / 2;
        const ends = [
          { x: lot.x0, y: lot.y0 },
          { x: lot.x1, y: lot.y1 },
        ].map((p) => p.x * sx + p.y * sy);
        const lo = Math.min(...ends) - LANE_RUN;
        const hi = Math.max(...ends) + LANE_RUN;
        // A point on the fence line, carried out to the lane's middle.
        const base = { x: g.x + exit.nx * off, y: g.y + exit.ny * off };
        const along = base.x * sx + base.y * sy;
        lane = {
          a: { x: base.x + sx * (lo - along), y: base.y + sy * (lo - along) },
          b: { x: base.x + sx * (hi - along), y: base.y + sy * (hi - along) },
          width: LANE_WIDTH,
        };
      }
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

  return { lot, entrance, step, path, gate, walk, lane, front, skirts };
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

/**
 * A box `w`×`h`×`d` about its centre (as BoxGeometry), with its top edges
 * bevelled by `c`: a stone step, not a crisp white block.
 */
export function chamferedBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const x = w / 2;
  const z = d / 2;
  const y0 = -h / 2;
  const y1 = h / 2;
  const k = Math.max(0, Math.min(c, h * 0.5, x * 0.4, z * 0.4));
  const ring = (y: number, inset: number): THREE.Vector3[] => [
    new THREE.Vector3(-x + inset, y, -z + inset),
    new THREE.Vector3(x - inset, y, -z + inset),
    new THREE.Vector3(x - inset, y, z - inset),
    new THREE.Vector3(-x + inset, y, z - inset),
  ];
  const bottom = ring(y0, 0);
  const shoulder = ring(y1 - k, 0);
  const top = ring(y1, k);
  const positions: number[] = [];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  // A convex solid: wind every face so it looks away from the middle.
  const face = (pts: THREE.Vector3[]): void => {
    centroid.set(0, 0, 0);
    for (const p of pts) centroid.addScaledVector(p, 1 / pts.length);
    const n = e1.subVectors(pts[1], pts[0]).cross(e2.subVectors(pts[2], pts[0]));
    const flip = n.dot(centroid) < 0;
    for (let i = 1; i + 1 < pts.length; i++) {
      const tri = flip ? [pts[0], pts[i + 1], pts[i]] : [pts[0], pts[i], pts[i + 1]];
      for (const p of tri) positions.push(p.x, p.y, p.z);
    }
  };
  face(top);
  face(bottom);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    face([bottom[i], bottom[j], shoulder[j], shoulder[i]]);
    if (k > 0) face([shoulder[i], shoulder[j], top[j], top[i]]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
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
      const mesh = new THREE.Mesh(chamferedBox(w, height, depth, 0.012), pathMat);
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
