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

const BACKDROP_ROWS = 256;
let backdrop: THREE.DataTexture | null = null;
let backdropHour = NaN;

function mix3(a: string, b: string, t: number): [number, number, number] {
  const pa = parseHex(a);
  const pb = parseHex(b);
  return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
}

/** The drawn sky for an hour. One texture, repainted when the hour changes. */
export function backdropFor(hour: number): THREE.DataTexture {
  if (!backdrop) {
    backdrop = new THREE.DataTexture(new Uint8Array(4 * BACKDROP_ROWS * 4), 4, BACKDROP_ROWS, THREE.RGBAFormat);
    backdrop.mapping = THREE.EquirectangularReflectionMapping;
    backdrop.colorSpace = THREE.SRGBColorSpace;
    backdrop.magFilter = THREE.LinearFilter;
    backdrop.minFilter = THREE.LinearFilter;
    backdrop.name = 'sky-backdrop';
  }
  if (hour === backdropHour) return backdrop;
  backdropHour = hour;
  const low = Math.pow(Math.abs(sunPhase(hour)), 1.7);
  const zenith = mix3(BACKDROP.day.zenith, BACKDROP.low.zenith, low);
  const mid = mix3(BACKDROP.day.mid, BACKDROP.low.mid, low);
  const horizon = mix3(BACKDROP.day.horizon, BACKDROP.low.horizon, low);
  const data = backdrop.image.data as Uint8Array;
  for (let row = 0; row < BACKDROP_ROWS; row++) {
    // Row 0 is straight down, the last row straight up; the horizon is halfway.
    const up = Math.max(0, (row / (BACKDROP_ROWS - 1)) * 2 - 1);
    // Most of the change happens low in the sky, as it does outdoors.
    const t = Math.pow(up, 0.55);
    const c =
      t < 0.45
        ? [0, 1, 2].map((k) => horizon[k] + (mid[k] - horizon[k]) * (t / 0.45))
        : [0, 1, 2].map((k) => mid[k] + (zenith[k] - mid[k]) * ((t - 0.45) / 0.55));
    for (let col = 0; col < 4; col++) {
      const o = (row * 4 + col) * 4;
      data[o] = Math.round(c[0]);
      data[o + 1] = Math.round(c[1]);
      data[o + 2] = Math.round(c[2]);
      data[o + 3] = 255;
    }
  }
  backdrop.needsUpdate = true;
  return backdrop;
}
