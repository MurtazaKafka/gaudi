/**
 * The photographed materials the styled looks are built from. Pure data — no
 * three.js. Files live in public/textures/{id}/(color|normal|rough).jpg; all
 * are CC0 from Poly Haven (polyhaven.com), 1K.
 */
export type TextureId =
  | 'oak'
  | 'walnut'
  | 'tile'
  | 'mosaic'
  | 'stone'
  | 'concrete'
  | 'carpet'
  | 'plaster'
  | 'render'
  | 'brick'
  | 'timber'
  | 'charred'
  | 'slate'
  | 'clay'
  | 'metal'
  | 'shingle';

export interface TextureInfo {
  /** Poly Haven asset id, for credit and re-download. */
  source: string;
  /** Meters covered by one repeat. */
  size: number;
  /** Average colour of the photo; a surface's own colour is expressed relative to it. */
  avg: string;
  /** How much of the photo's light-and-dark to keep (1 = all of it): a stain-blotched photo is calmed toward its average. */
  contrast?: number;
  /** Strength of the photo's relief (normal map), 1 = as photographed. */
  relief?: number;
  /** How far the tint may lift the photo (default 2.4): a grey photo of a pale wall needs more to reach its colour. */
  maxTint?: number;
}

export const TEXTURES: Record<TextureId, TextureInfo> = {
  oak: { source: 'laminate_floor_02', size: 1.7, avg: '#9b8064' },
  walnut: { source: 'wood_floor', size: 1.7, avg: '#806042' },
  tile: { source: 'marble_01', size: 1.5, avg: '#b19d7a' },
  mosaic: { source: 'long_white_tiles', size: 1.27, avg: '#cdc6b6' },
  stone: { source: 'floor_tiles_02', size: 4.0, avg: '#9f917e' },
  concrete: { source: 'concrete_pavement', size: 1.8, avg: '#7f7466' },
  carpet: { source: 'curly_teddy_natural', size: 0.34, avg: '#e9d3bb' },
  plaster: { source: 'white_stucco', size: 2.0, avg: '#d7d3d0' },
  // A grey, stain-mottled photo: laid big, calmed, and lifted all the way to the wall's own colour, so it reads as fresh lime render.
  render: { source: 'white_plaster_02', size: 3.5, avg: '#8e877b', contrast: 0.4, relief: 0.55, maxTint: 3.4 },
  brick: { source: 'red_brick_03', size: 1.0, avg: '#6a544c' },
  timber: { source: 'wood_planks', size: 1.5, avg: '#795939' },
  charred: { source: 'black_painted_planks', size: 1.6, avg: '#1a1b20' },
  slate: { source: 'grey_roof_tiles_02', size: 1.5, avg: '#787a78' },
  clay: { source: 'clay_roof_tiles_02', size: 2.5, avg: '#92502b' },
  metal: { source: 'corrugated_iron_02', size: 2.7, avg: '#595851' },
  shingle: { source: 'roof_slates_02', size: 3.0, avg: '#908676' },
  // Laid larger than life: at its true 2 m the repeat shows from the air.
};

const channel = (hex: string, i: number): number => {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16) / 255;
  return Math.pow(Number.isFinite(v) ? v : 1, 2.2); // to linear light
};

/** A texture's average colour in linear light, for calming a photo toward it in a shader. */
export function averageLinear(id: TextureId): [number, number, number] {
  const avg = TEXTURES[id].avg;
  return [channel(avg, 0), channel(avg, 1), channel(avg, 2)];
}

/**
 * The multiplier (linear RGB) that makes a photo read as `wanted` overall
 * while keeping its grain: wanted ÷ the photo's average, kept within bounds so
 * a dark photo is never blown out and a pale one never crushed.
 */
export function tintFor(wanted: string, id: TextureId): [number, number, number] {
  const { avg, maxTint = 2.4 } = TEXTURES[id];
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const ratio = channel(wanted, i) / Math.max(0.004, channel(avg, i));
    out.push(Math.min(maxTint, Math.max(0.2, ratio)));
  }
  return out as [number, number, number];
}
