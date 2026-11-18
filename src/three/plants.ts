/**
 * Planting around the house, placed the way a person would place it rather
 * than scattered: two different pots at the front door, beds of grasses,
 * lavender and flowering perennials along the front and sunny walls, shrubs
 * gathered at the fence corners and along the path, and three trees of clearly
 * different sizes standing off the house's corners, where they frame it from
 * the usual viewpoints instead of hiding it or sitting on its roof.
 *
 * Foliage is a cloud of small almond leaves around a dark inner core, each
 * leaf lit as if it were part of one soft ball (its normal points out from the
 * middle of its clump), darker underneath and inside, lighter on top — the
 * Tiny Glade trick, kept to plain one-sided triangles so the live view, its
 * shading pass and the path tracer all draw it the same. Scene dressing only:
 * never in the plan or in exports.
 *
 * The mesh carries `userData.spheres` ({x, y, z, r} in world metres): every
 * tree crown clump, shrub and pot, so the camera can be kept out of them.
 */
import * as THREE from 'three';
import type { Point } from '../types';
import { pointInPolygon } from '../geometry';
import { convexHull, hash } from './pieces';
import type { P2 } from './pieces';
import { terrainFor } from './grounds';
import type { SitePlan } from './site';

type V3 = [number, number, number];

/** Something the camera should stay out of. */
export interface PlantSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const pick = <T>(list: T[], u: number): T => list[Math.min(list.length - 1, Math.floor(u * list.length))];
const UP: V3 = [0, 1, 0];

/** Triangles with their own normals and colours (RGBA, for the path tracer). */
class Batch {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];

  private vertex(p: V3, n: V3, c: V3): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2], 1);
  }

  /** One triangle, wound to face `facing` whichever order its corners come in; lit with normal `n`. */
  tri(a: V3, b: V3, c: V3, n: V3, ca: V3, cb: V3 = ca, cc: V3 = ca, facing: V3 = n): void {
    if (dot(crossV(sub(b, a), sub(c, a)), facing) < 0) {
      this.vertex(a, n, ca);
      this.vertex(c, n, cc);
      this.vertex(b, n, cb);
    } else {
      this.vertex(a, n, ca);
      this.vertex(b, n, cb);
      this.vertex(c, n, cc);
    }
  }

  /** A flat convex card, one-sided, fanned from its first corner. */
  card(pts: V3[], n: V3, c: V3, facing: V3 = n): void {
    for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], n, c, c, c, facing);
  }

  /**
   * A thin thing seen from both sides (a grass blade, a flower spike): two
   * faces a hair apart rather than one face wound both ways, so a path tracer
   * meets each of them instead of skipping the pair.
   */
  twoSided(pts: V3[], n: V3, cols: V3[]): void {
    const face = norm(crossV(sub(pts[1], pts[0]), sub(pts[pts.length - 1], pts[0])));
    for (const side of [1, -1]) {
      const off = mul(face, 0.0015 * side);
      const f = mul(face, side);
      const q = pts.map((p) => add(p, off));
      for (let i = 1; i < q.length - 1; i++) this.tri(q[0], q[i], q[i + 1], n, cols[0], cols[i], cols[i + 1], f);
    }
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.pos.length === 0 || !this.pos.every((v) => Number.isFinite(v))) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    return geo;
  }
}

const linear = (hex: string): V3 => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** A colour with its saturation eased off (greens straight from a swatch read neon in sunlight). */
const muted = (hex: string, k = 0.85): V3 => {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(hsl.h, hsl.s * k, hsl.l, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

const greens = (hexes: string[]): V3[] => hexes.map((h) => muted(h));

const LEAF_COLORS = {
  /** A broad, oak-like feature tree. */
  broad: greens(['#5f7f3c', '#6f8c43', '#55733a', '#7a9446', '#687f3a']),
  /** Birch-like: lighter and yellower. */
  birch: greens(['#7f9a48', '#8ea552', '#748f45', '#99ab5a']),
  /** A columnar hornbeam: deep and dense. */
  column: greens(['#4a6a38', '#55753d', '#43603a', '#5e7a42']),
  shrub: greens(['#4f6f3a', '#5d7d40', '#48663a', '#6a8648']),
  box: greens(['#46643a', '#4f6e3d', '#3f5a36', '#557240']),
  lavender: greens(['#8a9a7c', '#7d8f72', '#97a487']),
  perennial: greens(['#5f7d42', '#6d8a49', '#58743f', '#67853f']),
};

/** The few warm accents a tended garden has. */
const FLOWERS = {
  lavender: ['#8d7bc0', '#7d6cae', '#9a89c9'].map((h) => muted(h, 0.9)),
  pink: muted('#e3909d', 0.9),
  white: linear('#f0ebe0'),
  yellow: muted('#e9c75b', 0.9),
  rust: muted('#df8f4c', 0.9),
};

// ---------- foliage ----------

interface Clump {
  c: V3;
  /** Radii across and up. */
  r: number;
  ry: number;
}

interface Leafing {
  size: number;
  greens: V3[];
  /** The height band the light ramps over: the bottom of the plant to its top. */
  baseY: number;
  topY: number;
  /** Half-width of a leaf against its length. */
  width?: number;
  /** A share of the outer leaves are blossoms instead. */
  bloom?: { share: number; colors: V3[] };
}

/** Leaves over a set of clumps; `seed` makes the same plant every time. */
function foliage(b: Batch, clumps: Clump[], count: number, seed: number, leaf: Leafing): void {
  // Leaves go where the surface is: a big clump gets more than a small lobe.
  const weights = clumps.map((k) => k.r * (k.r + 2 * k.ry));
  const total = weights.reduce((s, w) => s + w, 0);
  const hw = leaf.width ?? 0.36;
  let made = 0;
  for (let i = 0; made < count && i < count * 2; i++) {
    let w = hash(seed, i, 1) * total;
    let ki = 0;
    while (ki < clumps.length - 1 && w > weights[ki]) {
      w -= weights[ki];
      ki++;
    }
    const k = clumps[ki];
    // A point in the clump, mostly near its skin.
    const u = hash(seed, i, 2) * 2 - 1;
    const a = hash(seed, i, 3) * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const out: V3 = [s * Math.cos(a), u, s * Math.sin(a)];
    const depth = 0.76 + 0.26 * hash(seed, i, 4) ** 0.6;
    const p: V3 = [k.c[0] + out[0] * k.r * depth, k.c[1] + out[1] * k.ry * depth, k.c[2] + out[2] * k.r * depth];
    // Buried inside a neighbouring clump nobody would see it: spend it somewhere else.
    const buried = clumps.some((o, j) => {
      if (j === ki) return false;
      const dx = (p[0] - o.c[0]) / o.r;
      const dy = (p[1] - o.c[1]) / o.ry;
      const dz = (p[2] - o.c[2]) / o.r;
      return dx * dx + dy * dy + dz * dz < 0.55;
    });
    if (buried) continue;
    made++;
    // Lit as part of the soft ball: out from the clump, leaning up toward the sky.
    const n = norm([out[0], out[1] * 0.8 + 0.35, out[2]]);
    // The leaf lies roughly across that normal, turned at random and tipped a little out of the skin.
    const r1 = norm(crossV(n, [hash(seed, i, 5) - 0.5, hash(seed, i, 6) - 0.5, hash(seed, i, 7) - 0.5]));
    const r2 = crossV(n, r1);
    const tilt = (hash(seed, i, 10) - 0.5) * 1.0;
    const along = norm(add(mul(r1, Math.cos(tilt)), mul(n, Math.sin(tilt))));
    const sz = leaf.size * (0.75 + 0.5 * hash(seed, i, 8));
    // Darker low in the plant and much darker deep inside it, so the crown has a shaded core.
    const h = clamp01((p[1] - leaf.baseY) / Math.max(0.01, leaf.topY - leaf.baseY));
    const t = (depth - 0.7) / 0.32;
    const jitter = 0.94 + 0.12 * hash(seed, i, 11);
    let c: V3;
    if (leaf.bloom && out[1] > -0.15 && hash(seed, i, 12) < leaf.bloom.share) {
      c = mul(pick(leaf.bloom.colors, hash(seed, i, 9)), (0.62 + 0.4 * t) * (0.8 + 0.25 * h) * jitter);
    } else {
      c = mul(pick(leaf.greens, hash(seed, i, 9)), (0.55 + 0.55 * h) * (0.35 + 0.75 * t ** 1.5) * jitter);
    }
    const at = (l: number, side: number): V3 => add(p, add(mul(along, sz * l), mul(r2, sz * hw * side)));
    // An almond: a pointed tip, rounded sides, a blunter stalk end.
    b.card([at(-0.5, 0), at(-0.2, 0.95), at(0.2, 0.85), at(0.5, 0), at(0.2, -0.85), at(-0.2, -0.95)], n, c);
  }
}

/**
 * The dark heart of a clump: a low ellipsoid just inside its deepest leaves,
 * so gaps between leaves show shaded leafage instead of sky.
 */
function core(b: Batch, k: Clump, color: V3, baseY: number, topY: number): void {
  const rings = 5;
  const segs = 9;
  const seed = Math.round(k.c[0] * 100) * 7919 + Math.round(k.c[2] * 100) * 31 + Math.round(k.c[1] * 100);
  const at = (i: number, j: number): { p: V3; o: V3 } => {
    const th = (i / rings) * Math.PI;
    const ph = (j / segs) * Math.PI * 2;
    const o: V3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    // Lumpy, so its outline never reads as a ball through the gaps; the poles and the seam stay shut.
    const s = 0.55 + 0.1 * hash(seed, i, i === 0 || i === rings ? 0 : (j % segs) + 1);
    return { p: [k.c[0] + o[0] * k.r * s, k.c[1] + o[1] * k.ry * s, k.c[2] + o[2] * k.r * s], o };
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const mid = norm(q.reduce<V3>((m, v) => add(m, v.o), [0, 0, 0]));
      const n = norm([mid[0], mid[1] * 0.8 + 0.35, mid[2]]);
      const y = (q[0].p[1] + q[2].p[1]) / 2;
      const c = mul(color, (0.55 + 0.55 * clamp01((y - baseY) / Math.max(0.01, topY - baseY))) * (0.8 + 0.4 * hash(seed, i * segs + j, 9)));
      if (i < rings - 1) b.tri(q[0].p, q[1].p, q[2].p, n, c, c, c, mid);
      if (i > 0) b.tri(q[0].p, q[2].p, q[3].p, n, c, c, c, mid);
    }
  }
}

const meanOf = (list: V3[]): V3 => mul(list.reduce<V3>((m, v) => add(m, v), [0, 0, 0]), 1 / list.length);

/** Clumps of leaves around dark cores. */
function leafy(b: Batch, clumps: Clump[], count: number, seed: number, leaf: Leafing): void {
  const dark = mul(meanOf(leaf.greens), 0.3);
  for (const k of clumps) core(b, k, dark, leaf.baseY, leaf.topY);
  foliage(b, clumps, count, seed, leaf);
}

/** An upright tapered prism (trunk, limb, pot), seen from outside; `cap` closes its top. */
function prism(b: Batch, x: number, z: number, y0: number, y1: number, r0: number, r1: number, sides: number, color: V3, lean: V3 = [0, 0, 0], cap?: V3): void {
  const at = (a: number, r: number, y: number, t: number): V3 => [x + Math.cos(a) * r + lean[0] * t, y, z + Math.sin(a) * r + lean[2] * t];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const n: V3 = [Math.cos(am), 0, Math.sin(am)];
    const k = 0.8 + 0.25 * Math.max(0, Math.cos(am - 0.8));
    const c = mul(color, k);
    const p00 = at(a0, r0, y0, 0);
    const p10 = at(a1, r0, y0, 0);
    const p01 = at(a0, r1, y1, 1);
    const p11 = at(a1, r1, y1, 1);
    b.tri(p00, p10, p11, n, c);
    b.tri(p00, p11, p01, n, c);
    if (cap) b.tri([x + lean[0], y1, z + lean[2]], p01, p11, UP, cap);
  }
}

// ---------- trees ----------

type TreeForm = 'broad' | 'column' | 'multi';

interface TreeSpec {
  form: TreeForm;
  /** Height, metres. */
  h: number;
  /** Crown radius across. */
  R: number;
  seed: number;
}

/** Where a tree's crown sits and how big it looks, for placing it. */
function crownOf(t: TreeSpec): { y: number; r: number; bottom: number } {
  if (t.form === 'column') return { y: t.h * 0.6, r: (t.R + t.h * 0.33) / 2, bottom: t.h * 0.18 };
  if (t.form === 'multi') return { y: t.h - t.R * 0.85, r: t.R * 1.1, bottom: t.h - t.R * 1.7 };
  return { y: t.h - t.R * 0.8, r: t.R * 1.15, bottom: t.h - t.R * 1.45 };
}

const BARK = linear('#6a5340');
const BIRCH = linear('#d6cebf');
const BIRCH_MARK = linear('#6f675e');

function tree(b: Batch, x: number, z: number, gy: number, t: TreeSpec, spheres: PlantSphere[]): void {
  const { h, R, seed } = t;
  const clumps: Clump[] = [];
  let palette = LEAF_COLORS.broad;
  let leaves: number;
  let size: number;
  if (t.form === 'broad') {
    // A flared trunk splitting into limbs under one wide, lobed crown.
    const k = h / 10;
    const fork = gy + h * 0.42;
    prism(b, x, z, gy - 0.05, gy + 0.5, 0.42 * k, 0.3 * k, 9, BARK);
    prism(b, x, z, gy + 0.5, fork, 0.3 * k, 0.22 * k, 9, BARK);
    const cy = gy + h - R * 0.8;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + hash(seed, i, 20);
      const reach = R * (0.35 + 0.15 * hash(seed, i, 21));
      prism(b, x, z, fork - 0.25, cy - R * 0.1, 0.17 * k, 0.07 * k, 6, BARK, [Math.cos(a) * reach, 0, Math.sin(a) * reach]);
    }
    clumps.push({ c: [x, cy, z], r: R * 0.85, ry: R * 0.68 });
    clumps.push({ c: [x + (hash(seed, 0, 22) - 0.5) * R * 0.3, cy + R * 0.42, z + (hash(seed, 0, 23) - 0.5) * R * 0.3], r: R * 0.58, ry: R * 0.46 });
    const lobes = 7;
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + hash(seed, i, 16) * 0.6;
      const d = R * (0.5 + 0.22 * hash(seed, i, 17));
      const r = R * (0.42 + 0.16 * hash(seed, i, 19));
      clumps.push({ c: [x + Math.cos(a) * d, cy + R * (-0.28 + 0.55 * hash(seed, i, 18)), z + Math.sin(a) * d], r, ry: r * 0.78 });
    }
    leaves = Math.round(15000 * Math.min(1.3, (R / 3.6) ** 2));
    size = 0.18;
  } else if (t.form === 'column') {
    // Upright and narrow: a short trunk, the crown stacked up a single axis.
    palette = LEAF_COLORS.column;
    prism(b, x, z, gy - 0.05, gy + h * 0.32, 0.22, 0.14, 8, BARK);
    const profile = [0.8, 1, 0.95, 0.75, 0.45];
    const step = (h * 0.6) / (profile.length - 1);
    profile.forEach((f, i) => {
      const y = gy + h * 0.28 + step * i;
      clumps.push({
        c: [x + (hash(seed, i, 24) - 0.5) * 0.3, y, z + (hash(seed, i, 25) - 0.5) * 0.3],
        r: R * f,
        ry: step * (i === profile.length - 1 ? 0.8 : 0.95),
      });
    });
    leaves = Math.round(9000 * Math.min(1.3, (h / 8.6) * (R / 1.8)));
    size = 0.16;
  } else {
    // Three pale stems leaning apart from one root, each with a crown of its own.
    palette = LEAF_COLORS.birch;
    const Rs = R * 0.55;
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * Math.PI * 2 + hash(seed, s, 26) * 0.8;
      const bx = x + Math.cos(a) * 0.16;
      const bz = z + Math.sin(a) * 0.16;
      const reach = R * (0.32 + 0.18 * hash(seed, s, 27));
      const hs = h * (0.8 + 0.2 * hash(seed, s, 28));
      const top = gy + hs - Rs * 0.9;
      const lean: V3 = [Math.cos(a) * reach, 0, Math.sin(a) * reach];
      // The stem in lengths of pale bark broken by thin dark marks.
      const stemLen = top - gy;
      let t0 = 0;
      for (let j = 0; t0 < 1 && j < 40; j++) {
        const mark = j % 2 === 1 && hash(seed, s * 50 + j, 29) < 0.6;
        const t1 = Math.min(1, t0 + (mark ? 0.04 + 0.05 * hash(seed, s * 50 + j, 30) : 0.3 + 0.5 * hash(seed, s * 50 + j, 30)) / stemLen);
        prism(b, bx + lean[0] * t0, bz + lean[2] * t0, gy + stemLen * t0 - 0.01, gy + stemLen * t1, 0.12 - 0.07 * t0, 0.12 - 0.07 * t1, 6, mark ? BIRCH_MARK : BIRCH, mul(lean, t1 - t0));
        t0 = t1;
      }
      const cx = bx + lean[0] * 1.1;
      const cz = bz + lean[2] * 1.1;
      clumps.push({ c: [cx, top + Rs * 0.35, cz], r: Rs, ry: Rs * 1.05 });
      for (let i = 0; i < 2; i++) {
        const la = a + (i === 0 ? -0.9 : 0.9) + hash(seed, s * 4 + i, 30) * 0.4;
        clumps.push({ c: [cx + Math.cos(la) * Rs * 0.6, top + Rs * (0.05 + 0.5 * hash(seed, s * 4 + i, 31)), cz + Math.sin(la) * Rs * 0.6], r: Rs * 0.6, ry: Rs * 0.58 });
      }
    }
    leaves = Math.round(9000 * Math.min(1.3, (R / 2.7) ** 2));
    size = 0.16;
  }
  let top = -Infinity;
  let bottom = Infinity;
  for (const k of clumps) {
    top = Math.max(top, k.c[1] + k.ry);
    bottom = Math.min(bottom, k.c[1] - k.ry);
  }
  leafy(b, clumps, leaves, seed, { size, greens: palette, baseY: bottom, topY: top });
  for (const k of clumps) spheres.push({ x: k.c[0], y: k.c[1], z: k.c[2], r: Math.max(k.r, k.ry) });
}

// ---------- shrubs, pots and bed plants ----------

function shrub(b: Batch, x: number, z: number, seed: number, r: number, palette: V3[], spheres: PlantSphere[], bloom?: Leafing['bloom']): void {
  const clumps: Clump[] = [{ c: [x, r * 0.62, z], r, ry: r * 0.74 }];
  for (let i = 0; i < 2; i++) {
    const a = hash(seed, i, 21) * Math.PI * 2;
    clumps.push({ c: [x + Math.cos(a) * r * 0.45, r * 0.5, z + Math.sin(a) * r * 0.45], r: r * 0.7, ry: r * 0.55 });
  }
  leafy(b, clumps, Math.round(1700 * r * r), seed, { size: 0.09, greens: palette, baseY: 0, topY: r * 1.36, bloom });
  spheres.push({ x, y: r * 0.62, z, r: r * 1.15 });
}

const TERRACOTTA = linear('#b56c4a');
const GLAZE = linear('#55635e');
const SOIL = linear('#4a3a2e');

/** A tall glazed pot with a clipped column of box in it. */
function tallPot(b: Batch, x: number, z: number, seed: number, spheres: PlantSphere[]): void {
  prism(b, x, z, 0, 0.6, 0.15, 0.19, 12, GLAZE);
  prism(b, x, z, 0.6, 0.64, 0.205, 0.205, 12, mul(GLAZE, 0.9), [0, 0, 0], SOIL);
  const clumps: Clump[] = [
    { c: [x, 0.9, z], r: 0.21, ry: 0.3 },
    { c: [x, 1.2, z], r: 0.16, ry: 0.22 },
    { c: [x, 1.4, z], r: 0.09, ry: 0.12 },
  ];
  leafy(b, clumps, 420, seed, { size: 0.08, greens: LEAF_COLORS.box, baseY: 0.62, topY: 1.52 });
  spheres.push({ x, y: 1.0, z, r: 0.5 });
}

/** A low terracotta bowl spilling over with a flowering mound. */
function lowPot(b: Batch, x: number, z: number, seed: number, spheres: PlantSphere[]): void {
  prism(b, x, z, 0, 0.27, 0.23, 0.32, 12, TERRACOTTA);
  prism(b, x, z, 0.27, 0.31, 0.345, 0.345, 12, mul(TERRACOTTA, 0.92), [0, 0, 0], SOIL);
  const clumps: Clump[] = [{ c: [x, 0.42, z], r: 0.34, ry: 0.2 }];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + hash(seed, i, 35);
    clumps.push({ c: [x + Math.cos(a) * 0.33, 0.3, z + Math.sin(a) * 0.33], r: 0.13, ry: 0.11 });
  }
  const bloom = { share: 0.22, colors: hash(seed, 0, 36) < 0.5 ? [FLOWERS.pink, FLOWERS.white] : [FLOWERS.white, FLOWERS.yellow] };
  leafy(b, clumps, 440, seed, { size: 0.075, greens: LEAF_COLORS.perennial, baseY: 0.25, topY: 0.62, bloom });
  spheres.push({ x, y: 0.35, z, r: 0.5 });
}

/** A fountain of arching grass blades, straw at the tips. */
function grassFan(b: Batch, x: number, z: number, seed: number, h: number): void {
  const base = muted('#6c7d44');
  const tip = muted('#bdae70');
  const blades = 16;
  for (let i = 0; i < blades; i++) {
    const a = hash(seed, i, 41) * Math.PI * 2;
    const lean = 0.12 + 0.75 * hash(seed, i, 42) ** 1.4;
    const len = h * (0.6 + 0.4 * hash(seed, i, 43));
    const dir: V3 = [Math.cos(a), 0, Math.sin(a)];
    const side: V3 = [-Math.sin(a), 0, Math.cos(a)];
    const root: V3 = [x + dir[0] * 0.03, 0, z + dir[2] * 0.03];
    const along = (s: number): V3 => add(root, [dir[0] * len * Math.sin(lean) * s ** 1.6, len * Math.cos(lean) * s * (1 - 0.3 * s * s * lean), dir[2] * len * Math.sin(lean) * s ** 1.6]);
    const w = 0.018 * (0.8 + 0.4 * hash(seed, i, 44));
    const ss = [0, 0.45, 0.8];
    const pts: V3[] = [];
    const cols: V3[] = [];
    const tone = (s: number): V3 => add(mul(base, 1 - s), mul(tip, s));
    // Up one edge to the tip and back down the other: one fan per side of the blade.
    for (const s of ss) {
      pts.push(add(along(s), mul(side, w * (1 - s) ** 0.7)));
      cols.push(tone(s));
    }
    pts.push(along(1));
    cols.push(tone(1));
    for (const s of [...ss].reverse()) {
      pts.push(add(along(s), mul(side, -w * (1 - s) ** 0.7)));
      cols.push(tone(s));
    }
    b.twoSided(pts, norm([dir[0] * 0.5, 1, dir[2] * 0.5]), cols);
  }
}

/** A low grey-green mound with violet spikes standing out of it. */
function lavender(b: Batch, x: number, z: number, seed: number, r: number): void {
  const clumps: Clump[] = [{ c: [x, r * 0.45, z], r, ry: r * 0.62 }];
  leafy(b, clumps, Math.round(1500 * r * r), seed, { size: 0.07, greens: LEAF_COLORS.lavender, baseY: 0, topY: r * 1.1, width: 0.25 });
  const stem = muted('#7d8a63');
  const spikes = 16;
  for (let i = 0; i < spikes; i++) {
    const a = hash(seed, i, 51) * Math.PI * 2;
    const d = r * 0.7 * Math.sqrt(hash(seed, i, 52));
    const foot: V3 = [x + Math.cos(a) * d, r * 0.45 + r * 0.45 * (1 - (d / r) ** 2), z + Math.sin(a) * d];
    const tall = 0.14 + 0.12 * hash(seed, i, 53);
    const tipV: V3 = add(foot, [Math.cos(a) * d * 0.25, tall, Math.sin(a) * d * 0.25]);
    const turn = hash(seed, i, 54) * Math.PI;
    const side: V3 = [Math.cos(turn), 0, Math.sin(turn)];
    const head = add(foot, mul(sub(tipV, foot), 0.55));
    const col = pick(FLOWERS.lavender, hash(seed, i, 55));
    b.twoSided([add(foot, mul(side, 0.005)), add(head, mul(side, 0.005)), add(head, mul(side, -0.005)), add(foot, mul(side, -0.005))], UP, [stem, stem, stem, stem]);
    const mid = add(head, mul(sub(tipV, head), 0.4));
    b.twoSided([head, add(mid, mul(side, 0.016)), tipV, add(mid, mul(side, -0.016))], UP, [col, col, mul(col, 1.1), col]);
  }
}

/** A leafy mound with a scatter of flower heads on top, one colour per drift. */
function perennial(b: Batch, x: number, z: number, seed: number, r: number, flower: V3): void {
  const clumps: Clump[] = [{ c: [x, r * 0.55, z], r, ry: r * 0.7 }];
  leafy(b, clumps, Math.round(1500 * r * r), seed, { size: 0.08, greens: LEAF_COLORS.perennial, baseY: 0, topY: r * 1.25 });
  const heads = 7 + Math.floor(hash(seed, 0, 61) * 6);
  for (let i = 0; i < heads; i++) {
    const a = hash(seed, i, 62) * Math.PI * 2;
    const d = r * 0.8 * Math.sqrt(hash(seed, i, 63));
    const y = r * 0.55 + r * 0.7 * Math.sqrt(Math.max(0, 1 - (d / r) ** 2)) + 0.04 + 0.06 * hash(seed, i, 64);
    const centre: V3 = [x + Math.cos(a) * d, y, z + Math.sin(a) * d];
    const face = norm([Math.cos(a) * 0.5 * (d / r), 1, Math.sin(a) * 0.5 * (d / r)]);
    const u = norm(crossV(face, [1, 0, 0.3]));
    const v = crossV(face, u);
    const rr = 0.035 + 0.02 * hash(seed, i, 65);
    const ring: V3[] = [];
    for (let k = 0; k < 6; k++) {
      const t = (k / 6) * Math.PI * 2;
      ring.push(add(centre, add(mul(u, Math.cos(t) * rr), mul(v, Math.sin(t) * rr))));
    }
    b.card(ring, face, mul(flower, 0.92 + 0.12 * hash(seed, i, 66)));
  }
}

// ---------- where things go ----------

function distToLoop(p: Point, loop: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const c = loop[(i + 1) % loop.length];
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return best;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const outlineBoxes = new WeakMap<Point[][], Box[]>();

/**
 * How far a point is from the house (0 inside it), or `limit` if it is at least that far: callers
 * only ever ask "nearer than so much?", and on a plan of many buildings almost every outline is
 * too far to matter, so each is ruled out by the box around it before its sides are measured.
 */
function clearance(p: Point, outlines: Point[][], limit = Infinity): number {
  let boxes = outlineBoxes.get(outlines);
  if (!boxes) {
    boxes = outlines.map((o) => {
      const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const q of o) {
        b.x0 = Math.min(b.x0, q.x);
        b.y0 = Math.min(b.y0, q.y);
        b.x1 = Math.max(b.x1, q.x);
        b.y1 = Math.max(b.y1, q.y);
      }
      return b;
    });
    outlineBoxes.set(outlines, boxes);
  }
  let best = limit;
  for (let i = 0; i < outlines.length; i++) {
    const b = boxes[i];
    const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
    const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
    if (dx === 0 && dy === 0) {
      if (pointInPolygon(p, outlines[i])) return 0;
    } else if (dx * dx + dy * dy >= best * best) continue;
    best = Math.min(best, distToLoop(p, outlines[i]));
  }
  return best;
}

function onStrip(p: Point, strip: Point[] | null, pad: number): boolean {
  if (!strip) return false;
  if (pointInPolygon(p, strip)) return true;
  return distToLoop(p, strip) < pad;
}

function segDist(p: Point, a: Point, c: Point): number {
  return distToLoop(p, [a, c]);
}

/** Where the gravel strip along the foundation ends (grounds.ts lays it 0.42 m wide). */
const GRAVEL_EDGE = 0.45;
/** Roughly the noon-to-afternoon sun, in plan (x east, y south): walls facing it get beds. */
const SUN = (() => {
  const l = Math.hypot(0.45, -1);
  return { x: 0.45 / l, y: -1 / l };
})();

interface BedRun {
  a: Point;
  /** Along the wall, and out of the house. */
  t: Point;
  n: Point;
  from: number;
  to: number;
  width: number;
  seed: number;
}

/** Stretches of wall that get a planted bed: the front, and the walls that face the sun. */
function bedRuns(site: SitePlan): BedRun[] {
  const runs: BedRun[] = [];
  const e = site.entrance;
  for (const s of site.skirts) {
    const loop = s.inner;
    if (loop.length < 3) continue;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const c = loop[(i + 1) % loop.length];
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (!(len >= 1.6)) continue;
      const t = { x: (c.x - a.x) / len, y: (c.y - a.y) / len };
      let n = { x: -t.y, y: t.x };
      const mid = { x: a.x + t.x * len * 0.5, y: a.y + t.y * len * 0.5 };
      if (pointInPolygon({ x: mid.x + n.x * 0.05, y: mid.y + n.y * 0.05 }, loop)) n = { x: -n.x, y: -n.y };
      let front = false;
      if (e) {
        const off = (e.x - a.x) * n.x + (e.y - a.y) * n.y;
        const along = (e.x - a.x) * t.x + (e.y - a.y) * t.y;
        front = Math.abs(off) < 0.4 && along > 0 && along < len && e.nx * n.x + e.ny * n.y > 0.9;
      }
      const sunny = n.x * SUN.x + n.y * SUN.y > 0.35;
      if (!front && !sunny) continue;
      const seed = Math.round(a.x * 10) * 7919 + Math.round(a.y * 10) * 31 + Math.round(c.x * 10);
      runs.push({ a, t, n, from: 0.25, to: len - 0.25, width: 0.8 + 0.4 * hash(seed, 0, 71), seed });
    }
  }
  return runs;
}

/** The planted beds, as plan quads (for keeping lawn tufts out of them). */
export function plantingBeds(site: SitePlan): Point[][] {
  return bedRuns(site).map(({ a, t, n, from, to, width }) => {
    const at = (s: number, v: number): Point => ({ x: a.x + t.x * s + n.x * v, y: a.y + t.y * s + n.y * v });
    return [at(from, GRAVEL_EDGE), at(to, GRAVEL_EDGE), at(to, GRAVEL_EDGE + width), at(from, GRAVEL_EDGE + width)];
  });
}

// ---------- seeing the house as the camera does ----------

interface View {
  pos: V3;
  f: V3;
  rt: V3;
  up: V3;
}

function viewFrom(pos: V3, target: V3): View {
  const f = norm(sub(target, pos));
  const rt = norm(crossV(f, UP));
  return { pos, f, rt, up: crossV(rt, f) };
}

/** Where a point lands on the picture (tangent units: x right, y up); null behind the camera. */
function onScreen(v: View, p: V3): Point | null {
  const d = sub(p, v.pos);
  const z = dot(d, v.f);
  if (z < 0.1) return null;
  return { x: dot(d, v.rt) / z, y: dot(d, v.up) / z };
}

/** The house's outline on the picture: footprints at the ground and at the roof's height. */
function houseOnScreen(v: View, outlines: Point[][], top: number): Point[] {
  const pts: P2[] = [];
  for (const loop of outlines) {
    for (const p of loop) {
      for (const y of [0, top]) {
        const s = onScreen(v, [p.x, y, p.y]);
        if (s) pts.push([s.x, s.y]);
      }
    }
  }
  return convexHull(pts).map(([x, y]) => ({ x, y }));
}

/** How a tree at a spot sits against the house on one picture. */
interface Seen {
  /** The trunk or the crown's middle is over the house. */
  blocks: boolean;
  /** How much of the crown is over the house, 0…1. */
  overlap: number;
  centre: Point | null;
  /** Nearer the camera than the house's middle. */
  front: boolean;
  /** The crown's radius on the picture (tangent units; the frame is about ±0.38 high). */
  size: number;
}

function treeAgainst(v: View, hull: Point[], houseDepth: number, x: number, z: number, gy: number, t: TreeSpec): Seen {
  const crown = crownOf(t);
  const cc: V3 = [x, gy + crown.y, z];
  const centre = onScreen(v, cc);
  const depth = dot(sub(cc, v.pos), v.f);
  const front = depth < houseDepth;
  const size = depth > 0.1 ? crown.r / depth : Infinity;
  const blocked: Seen = { blocks: true, overlap: 1, centre, front, size };
  if (hull.length < 3) return { blocks: false, overlap: 0, centre, front, size };
  // The trunk standing in front of the house, or rising from behind its roof, or the crown's middle over it.
  for (const k of [0, 0.33, 0.66, 1]) {
    const s = onScreen(v, [x, gy + crown.bottom * k, z]);
    if (s && pointInPolygon(s, hull)) return blocked;
  }
  if (centre && pointInPolygon(centre, hull)) return blocked;
  let inside = 0;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const p = add(cc, add(mul(v.rt, Math.cos(a) * crown.r * 0.85), mul(v.up, Math.sin(a) * crown.r * 0.85)));
    const s = onScreen(v, p);
    if (s && pointInPolygon(s, hull)) inside++;
  }
  return { blocks: false, overlap: inside / 10, centre, front, size };
}

/** Everything planted around a house, as one mesh. Null when there is nowhere to plant. */
export function buildPlanting(site: SitePlan, centre: Point): THREE.Mesh | null {
  const outlines = site.skirts.map((s) => s.inner).filter((o) => o.length >= 3);
  if (outlines.length === 0) return null;
  const b = new Batch();
  const spheres: PlantSphere[] = [];
  const { lot } = site;
  const e = site.entrance;
  const keepClear = (p: Point, pad: number): boolean => onStrip(p, site.path, pad) || onStrip(p, site.step, pad);
  const inLot = (p: Point, pad: number): boolean => p.x > lot.x0 + pad && p.x < lot.x1 - pad && p.y > lot.y0 + pad && p.y < lot.y1 - pad;
  /** In front of the door, where people walk and the pots stand. */
  const atDoor = (p: Point): boolean => {
    if (!e) return false;
    const across = Math.abs((p.x - e.x) * -e.ny + (p.y - e.y) * e.nx);
    const out = (p.x - e.x) * e.nx + (p.y - e.y) * e.ny;
    return across < e.width / 2 + 0.95 && out > -0.5 && out < 2.4;
  };
  // Everything with a footprint, so nothing grows into anything else.
  // Kept in a coarse grid: a campus has tens of thousands of plants, and each new one only needs its neighbours.
  const CELL = 3;
  const taken = new Map<number, { x: number; y: number; r: number }[]>();
  let widest = 0;
  const cellOf = (v: number): number => Math.floor(v / CELL);
  const cellKey = (ix: number, iy: number): number => (ix + 32768) * 65536 + (iy + 32768);
  const roomFor = (p: Point, r: number): boolean => {
    const reach = (widest + r) * 0.8;
    for (let ix = cellOf(p.x - reach); ix <= cellOf(p.x + reach); ix++) {
      for (let iy = cellOf(p.y - reach); iy <= cellOf(p.y + reach); iy++) {
        const cell = taken.get(cellKey(ix, iy));
        if (cell && !cell.every((t) => Math.hypot(t.x - p.x, t.y - p.y) > (t.r + r) * 0.8)) return false;
      }
    }
    return true;
  };
  const take = (p: Point, r: number): void => {
    const key = cellKey(cellOf(p.x), cellOf(p.y));
    const cell = taken.get(key);
    if (cell) cell.push({ x: p.x, y: p.y, r });
    else taken.set(key, [{ x: p.x, y: p.y, r }]);
    widest = Math.max(widest, r);
  };

  // Two different pots either side of the front door: one tall, one low.
  if (e) {
    const tx = -e.ny;
    const ty = e.nx;
    const doorSeed = Math.round(e.x * 10) * 7919 + Math.round(e.y * 10);
    const tallSide = hash(doorSeed, 0, 81) < 0.5 ? -1 : 1;
    for (const side of [-1, 1]) {
      const tall = side === tallSide;
      const along = e.width / 2 + (tall ? 0.5 : 0.64);
      const outward = tall ? 0.42 : 0.5;
      const p = { x: e.x + tx * along * side + e.nx * outward, y: e.y + ty * along * side + e.ny * outward };
      if (keepClear(p, 0.2) || clearance(p, outlines, 0.2) < 0.15) continue;
      if (tall) tallPot(b, p.x, p.y, 101 + side, spheres);
      else lowPot(b, p.x, p.y, 101 + side, spheres);
      take(p, tall ? 0.25 : 0.4);
    }
  }

  // Beds between the gravel and the lawn, in odd-numbered drifts of one kind each.
  const warm = [FLOWERS.pink, FLOWERS.white, FLOWERS.yellow, FLOWERS.rust];
  for (const run of bedRuns(site)) {
    const { a, t, n, width, seed } = run;
    const at = (s: number, v: number): Point => ({ x: a.x + t.x * s + n.x * v, y: a.y + t.y * s + n.y * v });
    const usable = (p: Point, pad: number): boolean =>
      !keepClear(p, pad) && !atDoor(p) && clearance(p, outlines, GRAVEL_EDGE + 0.1) >= GRAVEL_EDGE + 0.05 && inLot(p, 0.3);
    // The soil, a little mounded, its outer edge wandering.
    const step = 0.35;
    const chunks = Math.max(1, Math.round((run.to - run.from) / step));
    const ds = (run.to - run.from) / chunks;
    const reachAt = (j: number): number => width * (0.88 + 0.2 * hash(seed, j, 72));
    for (let j = 0; j < chunks; j++) {
      const s0 = run.from + ds * j;
      const s1 = s0 + ds;
      if (!usable(at((s0 + s1) / 2, GRAVEL_EDGE + width / 2), 0.25)) continue;
      const tone = 0.85 + 0.25 * hash(seed, j, 73);
      const c = mul(SOIL, tone);
      const w0 = reachAt(j);
      const w1 = reachAt(j + 1);
      const p = (s: number, v: number, y: number): V3 => {
        const q = at(s, v);
        return [q.x, y, q.y];
      };
      const inner0 = p(s0, GRAVEL_EDGE - 0.03, 0.016);
      const inner1 = p(s1, GRAVEL_EDGE - 0.03, 0.016);
      const ridge0 = p(s0, GRAVEL_EDGE + w0 * 0.55, 0.03);
      const ridge1 = p(s1, GRAVEL_EDGE + w1 * 0.55, 0.03);
      const outer0 = p(s0, GRAVEL_EDGE + w0, 0.006);
      const outer1 = p(s1, GRAVEL_EDGE + w1, 0.006);
      b.card([inner0, inner1, ridge1, ridge0], UP, c);
      b.card([ridge0, ridge1, outer1, outer0], UP, mul(c, 0.94));
    }
    // The drifts.
    let s = run.from + 0.1;
    let last = -1;
    for (let d = 0; s < run.to - 0.5; d++) {
      const L = Math.min(run.to - 0.1 - s, 1.1 + 1.2 * hash(seed, d, 74));
      let kind = Math.floor(hash(seed, d, 75) * 3);
      if (kind === last) kind = (kind + 1) % 3;
      last = kind;
      const count = L < 1.3 ? 3 : L < 1.9 ? 5 : 7;
      const flower = pick(warm, hash(seed, d, 76));
      const spots: { p: Point; k: number }[] = [];
      for (let k = 0; k < count; k++) {
        const along = s + (L * (k + 0.5)) / count + (hash(seed * 3 + d, k, 77) - 0.5) * 0.15;
        const row = kind === 0 ? (k % 2 === 0 ? 0.28 : 0.6) : k % 2 === 0 ? 0.34 : 0.7;
        const p = at(along, GRAVEL_EDGE + width * (row + (hash(seed * 3 + d, k, 78) - 0.5) * 0.12));
        if (usable(p, 0.3)) spots.push({ p, k });
      }
      // Drifts come in odd numbers.
      if (spots.length % 2 === 0) spots.pop();
      for (const { p, k } of spots) {
        const ps = seed * 13 + d * 101 + k;
        if (kind === 0) {
          grassFan(b, p.x, p.y, ps, 0.45 + 0.2 * hash(ps, 0, 79));
          take(p, 0.22);
        } else if (kind === 1) {
          const r = 0.2 + 0.06 * hash(ps, 0, 79);
          lavender(b, p.x, p.y, ps, r);
          take(p, r);
        } else {
          const r = 0.18 + 0.07 * hash(ps, 0, 79);
          perennial(b, p.x, p.y, ps, r, flower);
          take(p, r);
        }
      }
      s += L + 0.08;
    }
  }

  // Shrubs along the path: a drift of three near the gate on one side, smaller ones midway on the other.
  const path = site.path;
  if (path && path.length === 4) {
    const [p0, p1, , p3] = path;
    const len = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const wid = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (len >= 3 && wid > 0) {
      const ux = (p3.x - p0.x) / len;
      const uy = (p3.y - p0.y) / len;
      const vx = (p1.x - p0.x) / wid;
      const vy = (p1.y - p0.y) / wid;
      const mid0 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const pathSeed = Math.round(mid0.x * 10) * 7919 + Math.round(mid0.y * 10);
      const flip = hash(pathSeed, 0, 82) < 0.5 ? 1 : -1;
      const drifts = [
        { side: flip, fracs: [0.74, 0.83, 0.93], r: [0.55, 0.42, 0.5], palette: LEAF_COLORS.shrub },
        { side: -flip, fracs: [0.38, 0.47, 0.56], r: [0.36, 0.3, 0.34], palette: LEAF_COLORS.box },
      ];
      drifts.forEach((dr, di) => {
        dr.fracs.forEach((f, k) => {
          const r = dr.r[k] * (0.9 + 0.2 * hash(pathSeed, di * 10 + k, 83));
          const off = wid / 2 + 0.3 + r + (k % 2) * 0.3;
          const p = { x: mid0.x + ux * len * f + vx * off * dr.side, y: mid0.y + uy * len * f + vy * off * dr.side };
          if (!inLot(p, r * 0.5) || keepClear(p, r + 0.15) || clearance(p, outlines, r + 0.7) < r + 0.6 || !roomFor(p, r)) return;
          shrub(b, p.x, p.y, pathSeed + di * 31 + k, r, dr.palette, spheres);
          take(p, r);
        });
      });
    }
  }

  // Trees: three, of clearly different sizes, off the house's corners as the usual cameras see it.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const o of outlines) {
    for (const p of o) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const radius = Math.min(500, Math.max((maxX - minX) / 2, (maxY - minY) / 2, 3));
  const roofTop = 2.8 + Math.min(3.5, radius * 0.4);
  const cx = centre.x;
  const cz = centre.y;
  const r = radius;
  const [fx, fz] = e ? [e.nx, e.ny] : [0, 1];
  const [sx, sz] = [-fz, fx];
  // The opening view, the review's low corner, and the corner shot (see Scene3D's defaultPose and shots).
  const views = [
    viewFrom([cx + r * 1.4, r * 2.3, cz + r * 1.8], [cx, 0, cz]),
    viewFrom([cx + r * 1.7, r * 0.62 + 2.1, cz + r * 1.95], [cx, 1.2, cz]),
    viewFrom([cx + fx * r * 2.5 + sx * r * 2.2, r * 0.8 + 2.5, cz + fz * r * 2.5 + sz * r * 2.2], [cx, 1.1, cz]),
  ];
  const street = viewFrom([cx + fx * r * 2.6 + sx * r * 0.5, 1.65, cz + fz * r * 2.6 + sz * r * 0.5], [cx, 1.1, cz]);
  const hulls = views.map((v) => houseOnScreen(v, outlines, roofTop));
  const depthOf = (v: View): number => dot(sub([cx, roofTop * 0.5, cz], v.pos), v.f);
  const depths = views.map(depthOf);
  const streetHull = houseOnScreen(street, outlines, roofTop);
  const houseMid = onScreen(views[0], [cx, roofTop * 0.5, cz]);
  const camDir = (() => {
    const dx = views[0].pos[0] - cx;
    const dz = views[0].pos[2] - cz;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, y: dz / l };
  })();
  const ground = terrainFor(lot);
  // The path, carried on past the lot where a lane might run.
  const pathLine = path && path.length === 4 && e ? { a: { x: e.x, y: e.y }, c: { x: (path[2].x + path[3].x) / 2 + e.nx * 6, y: (path[2].y + path[3].y) / 2 + e.ny * 6 } } : null;

  const treeSeed = Math.round(cx * 10) * 7919 + Math.round(cz * 10);
  const specs: TreeSpec[] = [
    { form: 'broad', h: 10.3 + 0.6 * hash(treeSeed, 0, 91), R: 3.4 + 0.4 * hash(treeSeed, 0, 92), seed: 501 },
    { form: 'column', h: 8.4 + 0.5 * hash(treeSeed, 1, 91), R: 1.7 + 0.2 * hash(treeSeed, 1, 92), seed: 598 },
    { form: 'multi', h: 7.0 + 0.4 * hash(treeSeed, 2, 91), R: 2.5 + 0.3 * hash(treeSeed, 2, 92), seed: 695 },
  ];
  const planted: { p: Point; R: number; side: number }[] = [];
  const reach = 4;
  // Every 0.8 m on a house lot; coarser on a very large site, so the search stays about the same size.
  const gridStep = Math.max(0.8, Math.sqrt(((lot.x1 - lot.x0 + 2 * reach) * (lot.y1 - lot.y0 + 2 * reach)) / 30000));
  for (const spec of specs) {
    const R = spec.form === 'column' ? spec.R : spec.R * 1.05;
    let best: { p: Point; score: number; side: number } | null = null;
    for (let x = lot.x0 - reach; x <= lot.x1 + reach; x += gridStep) {
      for (let y = lot.y0 - reach; y <= lot.y1 + reach; y += gridStep) {
        const p = { x, y };
        const c = clearance(p, outlines, R + 44); // past that, farther is no worse
        // The crown stays off the roof.
        if (c < R * 0.8 + 0.7 || keepClear(p, 2) || !roomFor(p, 0.6)) continue;
        if (pathLine && segDist(p, pathLine.a, pathLine.c) < 2.5) continue;
        if (planted.some((q) => Math.hypot(q.p.x - p.x, q.p.y - p.y) < (q.R + R) * 0.95)) continue;
        const outside = Math.max(lot.x0 - x, 0, x - lot.x1, lot.y0 - y, 0, y - lot.y1);
        if (outside > 0 && e && (x - centre.x) * e.nx + (y - centre.y) * e.ny > 0) continue; // the street side of the fence
        const gy = ground(x, y);
        let score = 0;
        let side = 0;
        views.forEach((v, i) => {
          const seen = treeAgainst(v, hulls[i], depths[i], x, y, gy, spec);
          // Never standing in front of the house, nor rising out of its roof.
          if (seen.blocks || (seen.front && seen.overlap > 0.1)) score -= 100;
          else {
            if (!seen.front && seen.overlap > 0.05 && seen.overlap <= 0.4) score += 0.4; // behind a corner, framing it
            score -= Math.max(0, seen.overlap - 0.45) * 5;
          }
          // Not so near the camera that it fills the picture.
          if (i < 2) score -= Math.max(0, seen.size - 0.2) * 40;
          if (i === 0 && seen.centre) {
            // In the picture, not off past its edge.
            score -= Math.max(0, Math.abs(seen.centre.x) - 0.7) * 4;
            if (houseMid) side = Math.sign(seen.centre.x - houseMid.x);
          }
        });
        const fromStreet = treeAgainst(street, streetHull, depthOf(street), x, y, gy, spec);
        if (fromStreet.blocks || (fromStreet.front && fromStreet.overlap > 0.15)) score -= 6;
        // 30–50° off the camera's line through the house: best behind a corner, framing it, but in front will do.
        const dl = Math.hypot(x - cx, y - cz) || 1;
        const cos = ((x - cx) * camDir.x + (y - cz) * camDir.y) / dl;
        const off = (Math.acos(Math.min(1, Math.abs(cos))) * 180) / Math.PI;
        score += (cos < 0 ? 1.6 : 0.6) * Math.exp(-(((off - 40) / 14) ** 2));
        score -= outside > 0 ? 0.4 + outside * 0.5 : 0;
        score -= Math.max(0, c - (R + 4)) * 0.15;
        if (planted.length > 0 && planted.every((q) => q.side === planted[0].side) && side !== 0 && side !== planted[0].side) score += 0.8;
        score += 0.3 * hash(Math.round(x * 10), Math.round(y * 10), 93 + spec.seed);
        if (!best || score > best.score) best = { p, score, side };
      }
    }
    if (!best || best.score < -50) continue;
    planted.push({ p: best.p, R, side: best.side });
    take(best.p, 0.6);
    tree(b, best.p.x, best.p.y, ground(best.p.x, best.p.y), spec, spheres);
  }

  // Shrub drifts in the fence corners, though not every corner: a garden that repeats looks like a pattern.
  const corners = [
    { x: lot.x0, y: lot.y0, sx: 1, sy: 1 },
    { x: lot.x1, y: lot.y0, sx: -1, sy: 1 },
    { x: lot.x1, y: lot.y1, sx: -1, sy: -1 },
    { x: lot.x0, y: lot.y1, sx: 1, sy: -1 },
  ];
  const cornerSeeds = corners.map((c) => Math.round(c.x * 10) * 7919 + Math.round(c.y * 10));
  const skip = cornerSeeds.reduce((lo, s, i) => (hash(s, 0, 94) < hash(cornerSeeds[lo], 0, 94) ? i : lo), 0);
  const bloomers = [FLOWERS.white, FLOWERS.pink];
  corners.forEach((corner, ci) => {
    if (ci === skip) return;
    const seed = cornerSeeds[ci];
    const five = hash(seed, 0, 95) < 0.5;
    const members = [
      { u: 1.0, v: 1.0, r: 0.78 + 0.17 * hash(seed, 0, 96) },
      { u: 2.3, v: 0.8, r: 0.52 + 0.13 * hash(seed, 1, 96) },
      { u: 0.8, v: 2.2, r: 0.5 + 0.13 * hash(seed, 2, 96) },
      ...(five
        ? [
            { u: 3.3, v: 0.7, r: 0.38 + 0.08 * hash(seed, 3, 96) },
            { u: 0.7, v: 3.2, r: 0.38 + 0.08 * hash(seed, 4, 96) },
          ]
        : []),
    ];
    const kind = hash(seed, 0, 97);
    const palette = kind < 0.4 ? LEAF_COLORS.shrub : kind < 0.7 ? LEAF_COLORS.box : LEAF_COLORS.perennial;
    const bloom = kind >= 0.7 ? { share: 0.14, colors: [pick(bloomers, hash(seed, 0, 98))] } : undefined;
    const spots: { p: Point; r: number; k: number }[] = [];
    members.forEach((m, k) => {
      const p = { x: corner.x + corner.sx * m.u, y: corner.y + corner.sy * m.v };
      if (keepClear(p, m.r + 0.3) || clearance(p, outlines, m.r + 0.9) < m.r + 0.8 || !roomFor(p, m.r)) return;
      spots.push({ p, r: m.r, k });
    });
    if (spots.length % 2 === 0) spots.pop();
    for (const { p, r: sr, k } of spots) {
      shrub(b, p.x, p.y, seed + k * 17, sr, palette, spheres, bloom);
      take(p, sr);
    }
  });

  // A shrub or two at some of the house's outside corners, where no bed already is.
  for (const loop of outlines) {
    const area = loop.reduce((s, p, i) => s + p.x * loop[(i + 1) % loop.length].y - loop[(i + 1) % loop.length].x * p.y, 0);
    const ccw = area > 0;
    for (let i = 0; i < loop.length; i++) {
      const prev = loop[(i + loop.length - 1) % loop.length];
      const p = loop[i];
      const next = loop[(i + 1) % loop.length];
      const turn = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x);
      if (ccw ? turn <= 1e-6 : turn >= -1e-6) continue; // an inside corner
      const seed = Math.round(p.x * 10) * 7919 + Math.round(p.y * 10);
      if (hash(seed, 0, 31) < 0.4) continue;
      const d1 = Math.hypot(p.x - prev.x, p.y - prev.y) || 1;
      const d2 = Math.hypot(next.x - p.x, next.y - p.y) || 1;
      const ox = (p.x - prev.x) / d1 - (next.x - p.x) / d2;
      const oy = (p.y - prev.y) / d1 - (next.y - p.y) / d2;
      const ol = Math.hypot(ox, oy) || 1;
      const count = 1 + Math.floor(hash(seed, 0, 32) * 2);
      for (let k = 0; k < count; k++) {
        const sr = 0.42 + 0.28 * hash(seed, k, 33);
        const wallDir = k % 2 === 0 ? { x: (prev.x - p.x) / d1, y: (prev.y - p.y) / d1 } : { x: (next.x - p.x) / d2, y: (next.y - p.y) / d2 };
        const along = k === 0 ? 0 : 1.1;
        const q = { x: p.x + (ox / ol) * (sr + 0.3) + wallDir.x * along, y: p.y + (oy / ol) * (sr + 0.3) + wallDir.y * along };
        if (keepClear(q, sr + 0.3) || clearance(q, outlines, sr * 0.6 + 0.1) < sr * 0.6 || atDoor(q) || !roomFor(q, sr)) continue;
        shrub(b, q.x, q.y, seed + k, sr, LEAF_COLORS.shrub, spheres);
        take(q, sr);
      }
    }
  }

  const geo = b.geometry();
  if (!geo) return null;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  material.name = 'planting';
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'planting';
  mesh.userData.spheres = spheres;
  return mesh;
}
