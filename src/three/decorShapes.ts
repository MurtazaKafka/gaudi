/**
 * The small things that dress a room — lamps, pictures, books, rugs, plants —
 * built from boxes, cylinders and lathe profiles with a colour per vertex, and
 * merged into one mesh per finish. A whole house of them is a handful of draw
 * calls. Placement lives in decor.ts; this file only knows how to make things.
 *
 * Every object is drawn through a `Pen`: a placement (a matrix) plus the bag
 * the triangles go into. Local frames follow the furniture convention: x to
 * the right, y up from the floor, z toward the front.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { withBounce } from './bounce';

/** Linear RGB, as vertex colours hold it. */
export type RGB = [number, number, number];

/** matte: cloth, paper, wood · glaze: ceramics, glass · metal: rails, stems · mirror · shade: lamp shades. */
export type Finish = 'matte' | 'glaze' | 'metal' | 'mirror' | 'shade';

export function rgb(hex: string): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const tone = (c: RGB, k: number): RGB => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

// ---------- materials ----------

const materials = new Map<string, THREE.MeshStandardMaterial>();

function material(finish: Finish, lit: boolean): THREE.MeshStandardMaterial {
  const key = finish === 'shade' && lit ? 'shade-lit' : finish;
  const hit = materials.get(key);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  if (finish === 'glaze') m.roughness = 0.32;
  if (finish === 'metal') {
    m.roughness = 0.38;
    m.metalness = 0.75;
  }
  if (finish === 'mirror') {
    m.roughness = 0.12;
    m.metalness = 0.2;
  }
  if (key === 'shade-lit') {
    m.emissive.set('#ffc98a');
    m.emissiveIntensity = 1.1;
  }
  m.name = `decor-${key}`;
  const out = withBounce(m);
  materials.set(key, out);
  return out;
}

// ---------- collecting triangles ----------

const FINISHES: readonly Finish[] = ['matte', 'glaze', 'metal', 'mirror', 'shade'];

export class Bag {
  private readonly parts = new Map<Finish, THREE.BufferGeometry[]>();

  /** Take ownership of `geo`, move it by `m`, paint it `color`. */
  add(finish: Finish, geo: THREE.BufferGeometry, m: THREE.Matrix4, color: RGB): void {
    geo.deleteAttribute('uv');
    geo.applyMatrix4(m);
    const n = geo.getAttribute('position').count;
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      colors[i * 4] = color[0];
      colors[i * 4 + 1] = color[1];
      colors[i * 4 + 2] = color[2];
      colors[i * 4 + 3] = 1;
    }
    // Four components: the path tracer merges colours as RGBA and mangles three-component ones.
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    const list = this.parts.get(finish) ?? [];
    list.push(geo.index ? geo : indexed(geo));
    this.parts.set(finish, list);
  }

  /** One mesh per finish. `lit` makes the lamp shades glow. */
  build(name: string, lit: boolean): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const finish of FINISHES) {
      const list = this.parts.get(finish);
      if (!list?.length) continue;
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, material(finish, lit));
      mesh.name = `${name}-${finish}`;
      mesh.castShadow = finish !== 'mirror';
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }
}

function indexed(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  geo.setIndex([...Array(n).keys()]);
  return geo;
}

// ---------- drawing ----------

const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const D = Math.PI / 180;

function local(x: number, y: number, z: number, rot?: readonly [number, number, number], sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  tmpE.set((rot?.[0] ?? 0) * D, (rot?.[1] ?? 0) * D, (rot?.[2] ?? 0) * D);
  tmpQ.setFromEuler(tmpE);
  return new THREE.Matrix4().compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
}

/** Rotation in degrees about x, y, z (applied in that order). */
export type Rot = readonly [number, number, number];

export class Pen {
  readonly bag: Bag;
  readonly m: THREE.Matrix4;
  constructor(bag: Bag, m: THREE.Matrix4) {
    this.bag = bag;
    this.m = m;
  }

  /** A pen at a plan point, turned the way a furniture item with `rotation` (plan radians) faces. */
  static at(bag: Bag, x: number, z: number, rotation: number, y = 0): Pen {
    return new Pen(bag, new THREE.Matrix4().makeRotationY(-rotation).setPosition(x, y, z));
  }

  /** A child pen: moved, then turned (degrees). */
  to(x: number, y: number, z: number, rot?: Rot): Pen {
    return new Pen(this.bag, this.m.clone().multiply(local(x, y, z, rot)));
  }

  private put(finish: Finish, geo: THREE.BufferGeometry, color: RGB, m: THREE.Matrix4): void {
    this.bag.add(finish, geo, this.m.clone().multiply(m), color);
  }

  /** A box centred on (x, y, z). */
  box(finish: Finish, color: RGB, w: number, h: number, d: number, x: number, y: number, z: number, rot?: Rot): void {
    this.put(finish, new THREE.BoxGeometry(1, 1, 1), color, local(x, y, z, rot, w, h, d));
  }

  /** A soft-cornered box centred on (x, y, z): cushions, towels, throws. */
  soft(finish: Finish, color: RGB, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rot?: Rot): void {
    const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
    this.put(finish, new RoundedBoxGeometry(w, h, d, 2, Math.max(1e-3, rr)), color, local(x, y, z, rot));
  }

  /** An upright cylinder (or cone frustum) standing on (x, y, z). */
  cyl(finish: Finish, color: RGB, rBottom: number, rTop: number, h: number, x: number, y: number, z: number, seg = 12, rot?: Rot): void {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, false);
    geo.translate(0, h / 2, 0);
    this.put(finish, geo, color, local(x, y, z, rot));
  }

  /** A turned shape: `profile` is [radius, height] pairs from the bottom up, standing on (x, y, z). */
  lathe(finish: Finish, color: RGB, profile: readonly (readonly [number, number])[], x: number, y: number, z: number, seg = 14): void {
    const pts = profile.map(([r, h]) => new THREE.Vector2(Math.max(r, 1e-4), h));
    this.put(finish, new THREE.LatheGeometry(pts, seg), color, local(x, y, z));
  }

  /** An ellipsoid centred on (x, y, z) with radii rx, ry, rz. */
  blob(finish: Finish, color: RGB, rx: number, ry: number, rz: number, x: number, y: number, z: number, rot?: Rot, seg = 8): void {
    const geo = new THREE.SphereGeometry(1, seg, Math.max(4, Math.round(seg * 0.75)));
    this.put(finish, geo, color, local(x, y, z, rot, rx, ry, rz));
  }
}
