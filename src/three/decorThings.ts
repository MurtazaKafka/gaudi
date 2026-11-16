/**
 * The catalogue of room details, each drawn with a Pen in its own local frame
 * (x right, y up from where it stands, z toward the room). Sizes are real
 * ones. Colours come from the style through `Tones`; the variety (which
 * picture, which plant) comes from a `pick` value 0…1 the caller hashes.
 */
import type { FurniturePalette, HouseStyle } from './styles';
import { mix, rgb, tone } from './decorShapes';
import type { Pen, RGB } from './decorShapes';

export interface Tones {
  wood: RGB;
  woodDark: RGB;
  fabric: RGB;
  fabricDark: RGB;
  linen: RGB;
  white: RGB;
  dark: RGB;
  leaf: RGB;
  pot: RGB;
  steel: RGB;
  wall: RGB;
  brass: RGB;
  /** Colours for art, cushions and books: the style's own, plus a few muted hues pulled toward it. */
  accents: RGB[];
}

const ART_HUES = ['#c4774a', '#6d879c', '#d2a650', '#8d9b6a', '#a8655f', '#4f6170'];

export function tonesFor(style: HouseStyle, pal: FurniturePalette): Tones {
  const wall = rgb(style.wall);
  const base = rgb(pal.fabric);
  const accents = [
    rgb(pal.pot),
    rgb(pal.leaf),
    rgb(pal.fabricDark),
    rgb(pal.woodDark),
    ...ART_HUES.map((h) => mix(rgb(h), base, 0.22)),
  ];
  return {
    wood: rgb(pal.wood),
    woodDark: rgb(pal.woodDark),
    fabric: base,
    fabricDark: rgb(pal.fabricDark),
    linen: rgb(pal.linen),
    white: rgb(pal.white),
    dark: rgb(pal.dark),
    leaf: rgb(pal.leaf),
    pot: rgb(pal.pot),
    steel: rgb(pal.steel),
    wall,
    brass: rgb('#b8955a'),
    accents,
  };
}

/** A repeatable choice from a list. */
export const choose = <T>(list: readonly T[], pick: number): T => list[Math.min(list.length - 1, Math.floor(pick * list.length))];

/** A repeatable 0…1 from a few numbers. */
export function rand(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= Math.round(v * 1000) | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
  }
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------- pictures and mirrors ----------

/**
 * A framed picture hung on a wall: the pen sits on the wall face at the
 * picture's centre, z out into the room. A frame, a mount and the art.
 */
export function picture(pen: Pen, t: Tones, w: number, h: number, pick: number): void {
  const frameCol = choose([t.dark, t.woodDark, t.wood, t.white, tone(t.dark, 0.7)], rand(pick, 1));
  const f = Math.min(0.035, w * 0.06);
  const depth = 0.028;
  // Frame: four rails.
  pen.box('matte', frameCol, w, f, depth, 0, h / 2 - f / 2, depth / 2);
  pen.box('matte', frameCol, w, f, depth, 0, -h / 2 + f / 2, depth / 2);
  pen.box('matte', frameCol, f, h - 2 * f, depth, -w / 2 + f / 2, 0, depth / 2);
  pen.box('matte', frameCol, f, h - 2 * f, depth, w / 2 - f / 2, 0, depth / 2);
  // Mount (a white card) behind the art.
  const mount = mix(t.white, t.linen, rand(pick, 2) * 0.6);
  const mw = w - 2 * f;
  const mh = h - 2 * f;
  pen.box('matte', mount, mw, mh, 0.012, 0, 0, 0.008);
  const m = Math.min(mw, mh) * (rand(pick, 3) < 0.6 ? 0.14 : 0.07);
  const aw = mw - 2 * m;
  const ah = mh - 2 * m;
  const z = 0.0145;
  const kind = rand(pick, 4);
  if (kind < 0.4) landscape(pen, t, aw, ah, z, pick);
  else if (kind < 0.75) blocks(pen, t, aw, ah, z, pick);
  else arcs(pen, t, aw, ah, z, pick);
}

/** Bands of sky, hills and field, and a low sun. */
function landscape(pen: Pen, t: Tones, w: number, h: number, z: number, pick: number): void {
  const sky = mix(t.white, choose([rgb('#c9d6dc'), rgb('#ead8bd'), rgb('#dfd3c6')], rand(pick, 5)), 0.8);
  const far = mix(choose(t.accents, rand(pick, 6)), sky, 0.45);
  const near = mix(t.leaf, t.fabricDark, rand(pick, 7) * 0.5);
  const field = mix(near, t.wood, 0.45);
  pen.box('matte', sky, w, h, 0.002, 0, 0, z);
  const hy = -h / 2;
  const hills = 3;
  for (let i = 0; i < hills; i++) {
    const cw = w * (0.45 + 0.35 * rand(pick, 10 + i));
    const ch = h * (0.28 + 0.2 * rand(pick, 20 + i));
    const cx = -w / 2 + cw / 2 + (w - cw) * rand(pick, 30 + i);
    pen.box('matte', mix(far, near, i / hills), cw, ch, 0.002, cx, hy + ch / 2, z + 0.001 + i * 0.0005);
  }
  pen.box('matte', field, w, h * 0.2, 0.002, 0, hy + h * 0.1, z + 0.003);
  const sun = choose(t.accents.slice(4), rand(pick, 8));
  const r = Math.min(w, h) * 0.1;
  pen.cyl('matte', mix(sun, t.white, 0.2), r, r, 0.002, w * (rand(pick, 9) - 0.5) * 0.6, h * 0.22, z + 0.0005, 16, [90, 0, 0]);
}

/** A few overlapping colour fields, mid-century style. */
function blocks(pen: Pen, t: Tones, w: number, h: number, z: number, pick: number): void {
  const ground = mix(t.linen, t.white, 0.4);
  pen.box('matte', ground, w, h, 0.002, 0, 0, z);
  const n = 3 + Math.floor(rand(pick, 11) * 2);
  for (let i = 0; i < n; i++) {
    const bw = w * (0.25 + 0.4 * rand(pick, 40 + i));
    const bh = h * (0.2 + 0.45 * rand(pick, 50 + i));
    const bx = (w - bw) * (rand(pick, 60 + i) - 0.5);
    const by = (h - bh) * (rand(pick, 70 + i) - 0.5);
    pen.box('matte', choose(t.accents, rand(pick, 80 + i)), bw, bh, 0.002, bx, by, z + 0.0006 * (i + 1));
  }
}

/** Circles and a stripe: quiet abstract shapes. */
function arcs(pen: Pen, t: Tones, w: number, h: number, z: number, pick: number): void {
  const ground = mix(t.fabric, t.white, 0.55);
  pen.box('matte', ground, w, h, 0.002, 0, 0, z);
  const r = Math.min(w, h) * (0.24 + 0.1 * rand(pick, 12));
  const c1 = choose(t.accents, rand(pick, 13));
  const c2 = choose(t.accents, rand(pick, 14));
  pen.cyl('matte', c1, r, r, 0.002, -w * 0.12, h * 0.08, z + 0.0005, 24, [90, 0, 0]);
  pen.cyl('matte', mix(c2, ground, 0.25), r * 0.7, r * 0.7, 0.002, w * 0.16, -h * 0.12, z + 0.001, 24, [90, 0, 0]);
  pen.box('matte', t.dark, w * 0.7, Math.max(0.006, h * 0.02), 0.002, 0, -h * 0.32, z + 0.0015);
}

/** A mirror on the wall; the pen sits at its centre on the wall face. */
export function mirror(pen: Pen, t: Tones, w: number, h: number, pick: number): void {
  const round = rand(pick, 1) < 0.35;
  const frame = choose([t.wood, t.dark, t.brass], rand(pick, 2));
  const fin = frame === t.brass ? 'metal' : 'matte';
  const glass = mix(t.white, rgb('#b9cbd3'), 0.55);
  const shine = mix(glass, rgb('#ffffff'), 0.6);
  // Two soft streaks of reflected light across the glass, kept well inside it.
  const streaks = (size: number, z: number): void => {
    pen.box('glaze', shine, size * 0.5, 0.035, 0.001, -size * 0.1, size * 0.1, z, [0, 0, 40]);
    pen.box('glaze', shine, size * 0.28, 0.018, 0.001, size * 0.02, -size * 0.04, z, [0, 0, 40]);
  };
  if (round) {
    const r = Math.min(w, h) / 2;
    pen.cyl(fin, frame, r, r, 0.022, 0, 0, 0, 32, [90, 0, 0]);
    pen.cyl('mirror', glass, r - 0.025, r - 0.025, 0.004, 0, 0, 0.022, 32, [90, 0, 0]);
    streaks(r * 1.2, 0.0265);
    return;
  }
  const f = 0.025;
  pen.box(fin, frame, w, h, 0.02, 0, 0, 0.01);
  pen.box('mirror', glass, w - 2 * f, h - 2 * f, 0.004, 0, 0, 0.022);
  streaks(Math.min(w, h) - 2 * f, 0.0245);
}

// ---------- lamps ----------

/** A table lamp standing at the pen: a turned base and a drum shade. */
export function tableLamp(pen: Pen, t: Tones, pick: number, scale = 1): void {
  const s = scale;
  const base = choose([t.white, t.pot, t.dark, mix(t.accents[5], t.white, 0.2)], rand(pick, 1));
  if (rand(pick, 2) < 0.5) {
    pen.lathe('glaze', base, [[0, 0], [0.05 * s, 0], [0.075 * s, 0.05 * s], [0.08 * s, 0.11 * s], [0.055 * s, 0.17 * s], [0.02 * s, 0.2 * s], [0, 0.205 * s]], 0, 0, 0);
  } else {
    pen.cyl('glaze', base, 0.06 * s, 0.06 * s, 0.018 * s, 0, 0, 0, 16);
    pen.cyl('metal', t.brass, 0.008 * s, 0.008 * s, 0.2 * s, 0, 0.018 * s, 0, 8);
  }
  pen.cyl('metal', t.brass, 0.006 * s, 0.006 * s, 0.08 * s, 0, 0.19 * s, 0, 6);
  const shade = mix(t.linen, t.white, 0.5);
  pen.cyl('shade', shade, 0.12 * s, 0.085 * s, 0.15 * s, 0, 0.225 * s, 0, 18);
}

/** A floor lamp standing at the pen. */
export function floorLamp(pen: Pen, t: Tones, pick: number): void {
  const metal = choose([t.dark, t.brass], rand(pick, 1));
  pen.cyl('metal', metal, 0.13, 0.12, 0.025, 0, 0, 0, 20);
  pen.cyl('metal', metal, 0.011, 0.011, 1.38, 0, 0.025, 0, 8);
  const shade = mix(t.linen, t.white, 0.4);
  pen.cyl('shade', shade, 0.21, 0.16, 0.28, 0, 1.3, 0, 22);
}

// ---------- plants ----------

/** A potted plant standing at the pen, about `height` tall. */
export function pottedPlant(pen: Pen, t: Tones, pick: number, height = 1): void {
  const potCol = choose([t.pot, t.white, mix(t.pot, t.wood, 0.4), t.dark], rand(pick, 1));
  const pr = 0.15 * Math.min(1.2, Math.max(0.6, height));
  const ph = pr * 1.6;
  pen.lathe('glaze', potCol, [[0, 0], [pr * 0.72, 0], [pr * 0.9, ph * 0.55], [pr, ph * 0.95], [pr * 1.05, ph], [pr * 0.95, ph], [0, ph - 0.02]], 0, 0, 0, 16);
  pen.cyl('matte', rgb('#4a3a2c'), pr * 0.92, pr * 0.92, 0.004, 0, ph - 0.025, 0, 14);
  const leaf = t.leaf;
  const leafs = [tone(leaf, 0.82), leaf, tone(leaf, 1.12), mix(leaf, rgb('#6f8f4e'), 0.35)];
  const top = height - ph;
  if (rand(pick, 2) < 0.45) {
    // Upright blades (a snake plant).
    const n = 7 + Math.floor(rand(pick, 3) * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 360 + rand(pick, 10 + i) * 40;
      const h = top * (0.55 + 0.45 * rand(pick, 20 + i));
      const lean = 6 + 12 * rand(pick, 30 + i);
      const r = pr * 0.45 * rand(pick, 40 + i);
      const x = Math.cos((a * Math.PI) / 180) * r;
      const z = Math.sin((a * Math.PI) / 180) * r;
      const p = pen.to(x, ph - 0.03, z, [0, -a, lean]);
      p.blob('matte', choose(leafs, rand(pick, 50 + i)), 0.035, h / 2, 0.012, 0, h / 2, 0, undefined, 6);
    }
  } else {
    // Arching leaves on short stems (a peace lily / rubber plant).
    const n = 9 + Math.floor(rand(pick, 4) * 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 360 * 1.618 + rand(pick, 60 + i) * 30;
      const up = i / n;
      const y = ph + top * (0.25 + 0.6 * up);
      const out = pr * (1.6 - up * 0.9);
      const len = 0.14 + 0.1 * (1 - up) * height;
      const tilt = 20 + 45 * (1 - up);
      const p = pen.to(0, y, 0, [0, -a, 0]);
      p.blob('matte', choose(leafs, rand(pick, 70 + i)), len / 2, 0.012, len * 0.22, out * 0.75, 0, 0, [0, 0, tilt - 30], 7);
      p.cyl('matte', tone(leaf, 0.8), 0.006, 0.006, Math.max(0.05, y - ph + 0.02), out * 0.25, ph - y - 0.02, 0, 4, [0, 0, -tilt * 0.4]);
    }
  }
}

// ---------- textiles ----------

/**
 * A rug lying flat at the pen, `w` across (x) by `d` deep (z): a field, a
 * border and a simple woven pattern. `round` makes it an oval.
 */
export function rug(pen: Pen, t: Tones, w: number, d: number, pick: number, round = false): void {
  const pal = choose(
    [
      [t.linen, t.fabricDark, t.accents[0]],
      [mix(t.fabric, t.linen, 0.4), t.woodDark, t.accents[5]],
      [mix(t.accents[4], t.linen, 0.55), t.linen, t.dark],
      [mix(t.fabricDark, t.fabric, 0.5), t.linen, t.accents[6]],
      [mix(t.accents[7], t.linen, 0.6), t.fabricDark, t.linen],
    ] as const,
    rand(pick, 1),
  );
  const [field, border, pattern] = pal;
  if (round) {
    const r = Math.min(w, d) / 2;
    pen.cyl('matte', border, r, r, 0.004, 0, 0, 0, 40);
    pen.cyl('matte', field, r - 0.08, r - 0.08, 0.0045, 0, 0, 0, 40);
    pen.cyl('matte', pattern, r * 0.45, r * 0.45, 0.005, 0, 0, 0, 32);
    pen.cyl('matte', field, r * 0.45 - 0.05, r * 0.45 - 0.05, 0.0055, 0, 0, 0, 32);
    return;
  }
  const b = Math.min(0.1, Math.min(w, d) * 0.08);
  pen.box('matte', border, w, 0.004, d, 0, 0.002, 0);
  pen.box('matte', field, w - 2 * b, 0.0045, d - 2 * b, 0, 0.00225, 0);
  const style = rand(pick, 2);
  const iw = w - 2 * b;
  const id = d - 2 * b;
  if (style < 0.4) {
    // Stripes across.
    const n = 3 + Math.floor(rand(pick, 3) * 3);
    for (let i = 0; i < n; i++) {
      const z = -id / 2 + (id * (i + 0.5)) / n;
      pen.box('matte', i % 2 ? pattern : mix(pattern, field, 0.5), iw * 0.9, 0.005, Math.min(0.06, id / (n * 3)), 0, 0.0025, z);
    }
  } else if (style < 0.75) {
    // A row of diamonds down the middle.
    const n = Math.max(1, Math.round(Math.max(iw, id) / 0.55));
    const along = iw > id;
    for (let i = 0; i < n; i++) {
      const s = -0.5 + (i + 0.5) / n;
      const x = along ? s * iw * 0.85 : 0;
      const z = along ? 0 : s * id * 0.85;
      const size = Math.min(iw, id) * 0.32;
      pen.box('matte', pattern, size, 0.005, size, x, 0.0025, z, [0, 45, 0]);
      pen.box('matte', field, size * 0.45, 0.0055, size * 0.45, x, 0.00275, z, [0, 45, 0]);
    }
  } else {
    // An inner line.
    pen.box('matte', pattern, iw - 0.12, 0.005, id - 0.12, 0, 0.0025, 0);
    pen.box('matte', field, iw - 0.18, 0.0055, id - 0.18, 0, 0.00275, 0);
  }
  // Fringe at the short ends.
  if (rand(pick, 4) < 0.6) {
    const fr = mix(t.linen, t.white, 0.5);
    if (w >= d) {
      pen.box('matte', fr, 0.04, 0.003, d * 0.94, -w / 2 - 0.02, 0.0015, 0);
      pen.box('matte', fr, 0.04, 0.003, d * 0.94, w / 2 + 0.02, 0.0015, 0);
    } else {
      pen.box('matte', fr, w * 0.94, 0.003, 0.04, 0, 0.0015, -d / 2 - 0.02);
      pen.box('matte', fr, w * 0.94, 0.003, 0.04, 0, 0.0015, d / 2 + 0.02);
    }
  }
}

/** A cushion standing at the pen (centre of its bottom edge), leaning back by `lean` degrees. */
export function cushion(pen: Pen, color: RGB, w: number, h: number, lean: number, piping?: RGB): void {
  const p = pen.to(0, 0, 0, [-lean, 0, 0]);
  p.soft('matte', color, w, h, 0.12, 0.05, 0, h / 2, 0);
  if (piping) p.soft('matte', piping, w * 0.5, h * 0.5, 0.124, 0.03, 0, h / 2, 0);
}

/** A folded throw lying across a bed or sofa, `w` across, `d` deep, at the pen (its underside). */
export function throwBlanket(pen: Pen, color: RGB, stripe: RGB, w: number, d: number): void {
  pen.soft('matte', color, w, 0.05, d, 0.022, 0, 0.025, 0);
  pen.box('matte', stripe, w + 0.002, 0.052, 0.03, 0, 0.025, d / 2 - 0.07);
}

// ---------- shelves and tops ----------

/** A row of books standing on a shelf at the pen, filling up to `span` (x), at most `maxH` tall. */
export function bookRow(pen: Pen, t: Tones, span: number, maxH: number, depth: number, pick: number): number {
  const cols = [...t.accents, t.linen, t.dark, t.fabricDark, t.white];
  let x = -span / 2;
  let i = 0;
  while (x < span / 2 - 0.03) {
    const bw = 0.022 + 0.026 * rand(pick, i, 1);
    if (x + bw > span / 2) break;
    const bh = Math.min(maxH, 0.17 + 0.09 * rand(pick, i, 2));
    const bd = Math.min(depth, 0.14 + 0.06 * rand(pick, i, 3));
    pen.box('matte', tone(choose(cols, rand(pick, i, 4)), 0.85 + 0.25 * rand(pick, i, 5)), bw, bh, bd, x + bw / 2, bh / 2, 0);
    x += bw + 0.002;
    i++;
  }
  // The last one leans on the row.
  if (x < span / 2 - 0.08 && maxH > 0.2) {
    const bh = Math.min(maxH - 0.02, 0.2);
    const lean = 18;
    const bw = 0.03;
    const dx = Math.sin((lean * Math.PI) / 180) * bh;
    pen.box('matte', choose(cols, rand(pick, 99)), bw, bh, Math.min(depth, 0.16), x + dx / 2 + bw / 2, (bh * Math.cos((lean * Math.PI) / 180)) / 2 + 0.008, 0, [0, 0, -lean]);
    x += dx + bw;
  }
  return x + span / 2;
}

/** A small stack of books lying flat at the pen. */
export function bookStack(pen: Pen, t: Tones, n: number, pick: number): number {
  let y = 0;
  const cols = [...t.accents, t.linen, t.dark];
  for (let i = 0; i < n; i++) {
    const w = 0.2 + 0.06 * rand(pick, i, 1);
    const d = 0.14 + 0.04 * rand(pick, i, 2);
    const h = 0.025 + 0.02 * rand(pick, i, 3);
    pen.box('matte', choose(cols, rand(pick, i, 4)), w, h, d, 0, y + h / 2, 0, [0, (rand(pick, i, 5) - 0.5) * 16, 0]);
    y += h;
  }
  return y;
}

/** A small vase, sometimes with a few stems. */
export function vase(pen: Pen, t: Tones, pick: number, scale = 1, flowers = rand(pick, 2) < 0.6): void {
  const s = scale;
  const c = choose([t.white, t.pot, t.accents[5], t.dark, t.accents[1]], rand(pick, 1));
  pen.lathe('glaze', c, [[0, 0], [0.035 * s, 0], [0.05 * s, 0.05 * s], [0.045 * s, 0.11 * s], [0.022 * s, 0.16 * s], [0.026 * s, 0.18 * s], [0.02 * s, 0.18 * s], [0, 0.17 * s]], 0, 0, 0);
  if (flowers) {
    const n = 3 + Math.floor(rand(pick, 3) * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 360;
      const lean = 8 + 14 * rand(pick, 10 + i);
      const h = (0.18 + 0.12 * rand(pick, 20 + i)) * s;
      const p = pen.to(0, 0.16 * s, 0, [0, a, lean]);
      p.cyl('matte', tone(t.leaf, 0.75), 0.003, 0.003, h, 0, 0, 0, 4);
      const bloom = rand(pick, 30 + i) < 0.5 ? t.accents[6] : mix(t.white, t.accents[2], 0.3);
      p.blob('matte', bloom, 0.018 * s, 0.014 * s, 0.018 * s, 0, h, 0, undefined, 6);
    }
  }
}

/** A wide bowl with a few pieces of fruit. */
export function fruitBowl(pen: Pen, t: Tones, pick: number): void {
  const c = choose([t.white, t.wood, t.dark, t.pot], rand(pick, 1));
  const r = 0.14;
  pen.lathe(c === t.wood ? 'matte' : 'glaze', c, [[0, 0], [0.05, 0], [0.1, 0.03], [r, 0.075], [r - 0.008, 0.078], [0.09, 0.035], [0, 0.03]], 0, 0, 0, 18);
  const fruit = [rgb('#d9822b'), rgb('#e0c341'), rgb('#9fb33d'), rgb('#b9352c')];
  const n = 3 + Math.floor(rand(pick, 2) * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(pick, 3);
    const rr = i === n - 1 ? 0 : 0.055;
    const y = i === n - 1 ? 0.1 : 0.07;
    const fr = 0.036 + 0.008 * rand(pick, 10 + i);
    pen.blob('glaze', choose(fruit, rand(pick, 20 + i)), fr, fr * 0.95, fr, Math.cos(a) * rr, y, Math.sin(a) * rr, undefined, 8);
  }
}

/** A row of storage jars with wooden lids. */
export function jars(pen: Pen, t: Tones, pick: number): void {
  const glass = mix(t.white, rgb('#cfdcd8'), 0.4);
  const fill = [rgb('#e9dfc8'), rgb('#9a6a3e'), rgb('#efe9dc'), rgb('#c78f4a')];
  const hs = [0.2, 0.15, 0.11];
  let x = 0;
  for (let i = 0; i < 3; i++) {
    const r = 0.05 - i * 0.006;
    const h = hs[i];
    pen.cyl('glaze', glass, r, r, h, x, 0, 0, 14);
    pen.cyl('matte', choose(fill, rand(pick, i)), r - 0.006, r - 0.006, h * 0.65, x, 0.004, 0, 12);
    pen.cyl('matte', t.wood, r + 0.004, r + 0.004, 0.022, x, h, 0, 14);
    x += r * 2 + 0.02;
  }
}

/** A chopping board leaning against the wall behind a counter, with a small bowl in front. */
export function board(pen: Pen, t: Tones, pick: number): void {
  const w = 0.3 + 0.08 * rand(pick, 1);
  const h = 0.4 + 0.08 * rand(pick, 2);
  pen.soft('matte', mix(t.wood, rgb('#c9a173'), 0.4), w, h, 0.022, 0.03, 0, h / 2 * 0.97, 0, [-10, 0, 0]);
  pen.cyl('matte', t.woodDark, 0.02, 0.02, 0.024, 0, h * 0.85, 0.004 - Math.sin((10 * Math.PI) / 180) * h * 0.85, 10, [80, 0, 0]);
}

/** A candle in a low holder. */
export function candle(pen: Pen, t: Tones): void {
  pen.cyl('glaze', t.dark, 0.035, 0.03, 0.02, 0, 0, 0, 12);
  pen.cyl('glaze', mix(t.white, t.linen, 0.3), 0.022, 0.022, 0.09, 0, 0.02, 0, 10);
}

// ---------- bathroom ----------

/** A towel rail on the wall with a towel folded over it; pen on the wall face at the rail's height. */
export function towelRail(pen: Pen, t: Tones, w: number, pick: number): void {
  const metal = choose([t.steel, t.brass, t.dark], rand(pick, 1));
  pen.cyl('metal', metal, 0.009, 0.009, w, -w / 2, 0, 0.07, 8, [0, 0, -90]);
  pen.cyl('metal', metal, 0.012, 0.012, 0.07, -w / 2 + 0.02, 0, 0, 8, [90, 0, 0]);
  pen.cyl('metal', metal, 0.012, 0.012, 0.07, w / 2 - 0.02, 0, 0, 8, [90, 0, 0]);
  const towel = choose([t.white, t.linen, mix(t.accents[5], t.white, 0.45), mix(t.accents[3], t.white, 0.5)], rand(pick, 2));
  const tw = w * 0.72;
  pen.soft('matte', towel, tw, 0.5, 0.018, 0.008, 0, -0.25, 0.085);
  pen.soft('matte', tone(towel, 0.93), tw, 0.36, 0.018, 0.008, 0, -0.18, 0.052);
  pen.cyl('matte', towel, 0.02, 0.02, tw, -tw / 2, 0, 0.068, 10, [0, 0, -90]);
  pen.box('matte', tone(towel, 0.85), tw, 0.03, 0.019, 0, -0.44, 0.0855);
}

/** A bath mat on the floor. */
export function bathMat(pen: Pen, t: Tones, w: number, d: number, pick: number): void {
  const c = choose([mix(t.accents[5], t.white, 0.3), mix(t.leaf, t.white, 0.3), mix(t.accents[6], t.white, 0.35), mix(t.fabricDark, t.white, 0.2)], rand(pick, 1));
  pen.soft('matte', c, w, 0.016, d, 0.008, 0, 0.008, 0);
  if (rand(pick, 2) < 0.5) {
    for (const s of [-1, 1]) pen.box('matte', tone(c, 0.82), w * 0.86, 0.017, 0.025, 0, 0.0085, s * d * 0.32);
  }
}

// ---------- by the door ----------

/** A coat stand: a turned pole with pegs, a coat and a hat. */
export function coatRack(pen: Pen, t: Tones, pick: number): void {
  const wood = choose([t.woodDark, t.dark, t.wood], rand(pick, 1));
  pen.cyl('matte', wood, 0.19, 0.17, 0.03, 0, 0, 0, 16);
  pen.cyl('matte', wood, 0.018, 0.016, 1.72, 0, 0.03, 0, 8);
  pen.blob('matte', wood, 0.028, 0.028, 0.028, 0, 1.76, 0, undefined, 8);
  for (let i = 0; i < 4; i++) {
    const a = i * 90 + 45;
    pen.to(0, 1.62, 0, [0, a, 0]).cyl('matte', wood, 0.01, 0.008, 0.13, 0, 0, 0, 6, [0, 0, -55]);
  }
  // A coat: shoulders, a body that widens a little toward the hem, and a scarf over the next peg.
  const coat = choose([mix(t.accents[3], t.linen, 0.15), rgb('#b08a5a'), mix(t.accents[5], t.linen, 0.2), mix(t.accents[7], t.linen, 0.2)], rand(pick, 2));
  const c = pen.to(0, 1.6, 0, [0, 45 + 90 * Math.floor(rand(pick, 3) * 4), 0]).to(0.11, 0, 0, [0, 90, 0]);
  c.soft('matte', coat, 0.3, 0.16, 0.09, 0.04, 0, -0.08, 0);
  c.soft('matte', coat, 0.34, 0.6, 0.08, 0.035, 0, -0.42, 0.005, [-3, 0, 0]);
  c.box('matte', tone(coat, 0.8), 0.012, 0.5, 0.082, 0, -0.42, 0.006, [-3, 0, 0]);
  if (rand(pick, 4) < 0.6) {
    const scarf = mix(choose(t.accents, rand(pick, 5)), t.linen, 0.2);
    pen.to(0, 1.58, 0, [0, -45, 0]).to(0.1, 0, 0, [0, 90, 0]).soft('matte', scarf, 0.09, 0.42, 0.03, 0.012, 0, -0.2, 0, [0, 0, 3]);
  }
}

/** A low bench with a cushion and a basket beneath. Pen at its centre on the floor, back to the wall. */
export function bench(pen: Pen, t: Tones, w: number, pick: number): void {
  const wood = choose([t.wood, t.woodDark], rand(pick, 1));
  const d = 0.36;
  const h = 0.45;
  pen.box('matte', wood, w, 0.04, d, 0, h - 0.02, 0);
  for (const s of [-1, 1]) {
    pen.box('matte', wood, 0.04, h - 0.04, d - 0.04, s * (w / 2 - 0.06), (h - 0.04) / 2, 0);
  }
  pen.box('matte', wood, w - 0.12, 0.03, d - 0.08, 0, 0.12, 0);
  pen.soft('matte', mix(t.fabric, t.linen, 0.3), w * 0.45, 0.05, d - 0.06, 0.02, -w * 0.18, h + 0.025, 0);
  // A pair of shoes on the low shelf.
  const shoe = choose([t.dark, t.woodDark, t.accents[5]], rand(pick, 2));
  for (const s of [-1, 1]) pen.soft('matte', shoe, 0.09, 0.07, 0.26, 0.03, w * 0.2 + s * 0.06, 0.17, 0.0);
}

/** A woven basket, optionally with folded cloth. */
export function basket(pen: Pen, t: Tones, w: number, d: number, h: number, pick: number): void {
  const c = mix(rgb('#b8915c'), t.wood, 0.4);
  pen.soft('matte', c, w, h, d, 0.02, 0, h / 2, 0);
  pen.box('matte', tone(c, 0.8), w + 0.004, 0.02, d + 0.004, 0, h - 0.015, 0);
  if (rand(pick, 1) < 0.7) {
    pen.soft('matte', choose([t.white, t.linen, t.accents[5]], rand(pick, 2)), w - 0.05, 0.05, d - 0.05, 0.02, 0, h, 0);
  }
}
