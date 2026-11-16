/**
 * Real skies for the styled looks: photographed HDR panoramas (Poly Haven,
 * CC0) that light the model and show behind it. The maquette keeps its plain
 * studio light.
 *
 * The sun itself stays ours (a directional light that follows the time-of-day
 * slider), so the panorama's own sun is toned down to a bright patch of sky
 * and turned to sit where our sun is.
 */
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { parseHex, sunPhase } from './sun';

export type SkyId = 'day' | 'dusk';

const FILES: Record<SkyId, string> = {
  day: 'kloofendal_48d_partly_cloudy_puresky',
  dusk: 'belfast_sunset_puresky',
};

export interface Sky {
  id: SkyId;
  texture: THREE.DataTexture;
  /** Compass angle (radians, atan2(z, x)) of the panorama's sun. */
  sunAzimuth: number;
}

/** Brightest a sky pixel may be: enough for a glowing patch, not a second sun casting its own shadows. */
const MAX_RADIANCE = 12;
/** How far the lighting sky is pulled toward grey (0 = as photographed), and what is left of its blue. */
const ENV_DESATURATE = 0.35;
const ENV_BLUE = 0.92;

const cache = new Map<SkyId, Sky | null>();
const loading = new Set<SkyId>();
const listeners = new Set<() => void>();

export function onSkyLoad(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const BASE = `${import.meta.env?.BASE_URL ?? '/'}sky/`;

function prepare(id: SkyId, texture: THREE.DataTexture): Sky {
  const { data, width, height } = texture.image as { data: Float32Array; width: number; height: number };
  const stride = Math.round(data.length / (width * height));
  let best = -1;
  let bestX = 0;
  for (let i = 0, px = 0; i < data.length; i += stride, px++) {
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (lum > best) {
      best = lum;
      bestX = px % width;
    }
    const peak = Math.max(data[i], data[i + 1], data[i + 2]);
    if (peak > MAX_RADIANCE) {
      const k = MAX_RADIANCE / peak;
      data[i] *= k;
      data[i + 1] *= k;
      data[i + 2] *= k;
    }
    // A photographed blue sky lighting the shade turns white plaster slate-grey. Take some of the
    // colour out and a little of the blue, so shade reads as a warm off-white.
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    data[i] += (l - data[i]) * ENV_DESATURATE;
    data[i + 1] += (l - data[i + 1]) * ENV_DESATURATE;
    data[i + 2] = (data[i + 2] + (l - data[i + 2]) * ENV_DESATURATE) * ENV_BLUE;
  }
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  texture.name = `sky-${id}`;
  return { id, texture, sunAzimuth: ((bestX + 0.5) / width - 0.5) * Math.PI * 2 };
}

/** The sky if it has arrived; otherwise null, and it starts loading. */
export function skyFor(id: SkyId): Sky | null {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  if (!loading.has(id) && typeof document !== 'undefined') {
    loading.add(id);
    new HDRLoader().setDataType(THREE.FloatType).load(
      `${BASE}${FILES[id]}.hdr`,
      (texture) => {
        try {
          cache.set(id, prepare(id, texture as THREE.DataTexture));
        } catch {
          cache.set(id, null);
        }
        loading.delete(id);
        for (const fn of [...listeners]) fn();
      },
      undefined,
      () => {
        cache.set(id, null); // the plain light stays
        loading.delete(id);
      },
    );
  }
  return null;
}

/** Which sky an hour calls for: the low sun of early morning and evening gets the dusk sky. */
export function skyIdFor(hour: number): SkyId {
  return hour >= 17.5 || hour <= 7 ? 'dusk' : 'day';
}

// ---------- what shows behind the house ----------

/**
 * The sky you see is drawn, not photographed: three colours from the horizon
 * up, shifting with the hour. A photograph has a murky side and a busy side;
 * this looks the same calm way wherever the camera turns, and its pale
 * horizon is where the lawn fades to. (The photograph still does the lighting.)
 */
const BACKDROP: Record<'day' | 'low', { zenith: string; mid: string; horizon: string }> = {
  day: { zenith: '#6c9fd6', mid: '#a8cbe9', horizon: '#e6eef0' },
  low: { zenith: '#43548c', mid: '#cf9a98', horizon: '#fbc592' },
};

const BACKDROP_W = 512;
const BACKDROP_ROWS = 256;
let backdrop: THREE.DataTexture | null = null;
let backdropHour = NaN;

function mix3(a: string, b: string, t: number): [number, number, number] {
  const pa = parseHex(a);
  const pb = parseHex(b);
  return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
}

/** The three sky colours (0…255) for an hour. */
function keys(hour: number): { zenith: number[]; mid: number[]; horizon: number[]; low: number } {
  const low = Math.pow(Math.abs(sunPhase(hour)), 1.7);
  return {
    zenith: mix3(BACKDROP.day.zenith, BACKDROP.low.zenith, low),
    mid: mix3(BACKDROP.day.mid, BACKDROP.low.mid, low),
    horizon: mix3(BACKDROP.day.horizon, BACKDROP.low.horizon, low),
    low,
  };
}

/** The colour at the horizon for an hour: the haze over the far lawn is this colour, so the two meet without a line. */
export function horizonFor(hour: number): string {
  return hex3(keys(hour).horizon);
}

/** The colour straight up for an hour. */
export function zenithFor(hour: number): string {
  return hex3(keys(hour).zenith);
}

function hex3(c: number[]): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

// ---------- clouds: drawn once, coloured by the hour ----------

function cellHash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise that wraps every `period` cells across (the panorama's seam). */
function noise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number): number => cellHash(((i % period) + period) % period, j, seed);
  const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
  const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

let cloudCover: Float32Array | null = null;

/** How much cloud each pixel of the panorama holds, 0…1: soft heaps low in the sky, thinning upward. */
function clouds(): Float32Array {
  if (cloudCover) return cloudCover;
  const out = new Float32Array(BACKDROP_W * BACKDROP_ROWS);
  for (let row = 0; row < BACKDROP_ROWS; row++) {
    const up = (row / (BACKDROP_ROWS - 1)) * 2 - 1; // −1 down … 1 up
    if (up <= 0.02) continue;
    const elev = Math.asin(Math.min(1, up)); // radians above the horizon
    // A band of weather between a few degrees and ~40°: most cloud is seen low, foreshortened.
    const band = Math.min(1, (elev - 0.02) / 0.06) * Math.max(0, 1 - (elev - 0.18) / 0.45);
    if (band <= 0) continue;
    for (let col = 0; col < BACKDROP_W; col++) {
      const u = col / BACKDROP_W;
      // Squashed vertically, as clouds near the horizon are.
      const y = elev * 14;
      let n = 0;
      let amp = 0.55;
      let f = 1;
      for (let o = 0; o < 4; o++) {
        n += noise(u * 10 * f, y * f, 10 * f, 7 + o) * amp;
        amp *= 0.5;
        f *= 2;
      }
      const c = Math.max(0, Math.min(1, (n - 0.46) / 0.16)) * band;
      out[row * BACKDROP_W + col] = c * c * (3 - 2 * c);
    }
  }
  cloudCover = out;
  return out;
}

/**
 * The drawn sky for an hour. A new texture each time the hour changes: the
 * renderer turns a panorama into a cube once per texture and never looks at
 * it again, so repainting the old one would leave the old sky on screen.
 */
export function backdropFor(hour: number): THREE.DataTexture {
  if (backdrop && hour === backdropHour) return backdrop;
  backdrop?.dispose();
  backdrop = new THREE.DataTexture(new Uint8Array(4 * BACKDROP_W * BACKDROP_ROWS), BACKDROP_W, BACKDROP_ROWS, THREE.RGBAFormat);
  backdrop.mapping = THREE.EquirectangularReflectionMapping;
  backdrop.colorSpace = THREE.SRGBColorSpace;
  backdrop.magFilter = THREE.LinearFilter;
  backdrop.minFilter = THREE.LinearFilter;
  backdrop.wrapS = THREE.RepeatWrapping;
  backdrop.name = 'sky-backdrop';
  backdropHour = hour;
  const { zenith, mid, horizon, low } = keys(hour);
  // Clouds are lit white by day and catch the low sun's colour at either end of it, with darker bellies.
  const lit = mix3('#ffffff', '#ffd2b0', low);
  const belly = mix3('#bcc6d3', '#8f7d96', low);
  const cover = clouds();
  const data = backdrop.image.data as Uint8Array;
  for (let row = 0; row < BACKDROP_ROWS; row++) {
    // Row 0 is straight down, the last row straight up; the horizon is halfway.
    const up = Math.max(0, (row / (BACKDROP_ROWS - 1)) * 2 - 1);
    // Most of the change happens low in the sky, as it does outdoors.
    const t = Math.pow(up, 0.55);
    const sky =
      t < 0.45
        ? [0, 1, 2].map((k) => horizon[k] + (mid[k] - horizon[k]) * (t / 0.45))
        : [0, 1, 2].map((k) => mid[k] + (zenith[k] - mid[k]) * ((t - 0.45) / 0.55));
    for (let col = 0; col < BACKDROP_W; col++) {
      const c = cover[row * BACKDROP_W + col] * 0.95;
      // The top of a heap is brighter than its base.
      const above = row + 3 < BACKDROP_ROWS ? cover[(row + 3) * BACKDROP_W + col] : 0;
      const top = Math.max(0, Math.min(1, 0.5 + (cover[row * BACKDROP_W + col] - above) * 3));
      const o = (row * BACKDROP_W + col) * 4;
      for (let k = 0; k < 3; k++) {
        const cloud = belly[k] + (lit[k] - belly[k]) * top;
        data[o + k] = Math.round(sky[k] + (cloud - sky[k]) * c);
      }
      data[o + 3] = 255;
    }
  }
  backdrop.needsUpdate = true;
  return backdrop;
}
