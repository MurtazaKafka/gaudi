/**
 * Procedural floor textures: planks, tiles, stone, concrete, carpet. Each is
 * drawn once onto a small canvas, tiles seamlessly, and is cached for the
 * life of the page — no image downloads.
 */
import * as THREE from 'three';
import type { FloorSpec } from './styles';
import { parseHex, toHex } from './sun';

const cache = new Map<string, THREE.Texture | null>();

/** Small deterministic PRNG so a texture looks the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Lighten (f > 0) or darken a color by a fraction. */
function shade(hex: string, f: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex([r * (1 + f), g * (1 + f), b * (1 + f)]);
}

type Ctx = CanvasRenderingContext2D;

/** Soft blotches that wrap around the edges. */
function mottle(ctx: Ctx, S: number, rand: () => number, count: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const r = S * (0.08 + rand() * 0.2);
    const light = rand() > 0.5;
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, light ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
}

/** Per-pixel grain. */
function speckle(ctx: Ctx, S: number, rand: () => number, amount: number): void {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = 1 + (rand() - 0.5) * amount;
    d[i] = Math.min(255, d[i] * k);
    d[i + 1] = Math.min(255, d[i + 1] * k);
    d[i + 2] = Math.min(255, d[i + 2] * k);
  }
  ctx.putImageData(img, 0, 0);
}

function drawWood(ctx: Ctx, S: number, spec: FloorSpec, rand: () => number): void {
  const rows = 8;
  const rh = S / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh;
    // Two or three end joints per row; the last board wraps round to the first joint.
    const joints = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => Math.floor(rand() * S)).sort((a, b) => a - b);
    for (let j = 0; j < joints.length; j++) {
      const x0 = joints[j];
      const x1 = j + 1 < joints.length ? joints[j + 1] : joints[0] + S;
      ctx.fillStyle = shade(spec.color, (rand() - 0.5) * 0.14);
      ctx.fillRect(x0, y, x1 - x0, rh);
      if (x1 > S) ctx.fillRect(0, y, x1 - S, rh);
    }
    // grain
    for (let g = 0; g < 5; g++) {
      ctx.fillStyle = rand() > 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, y + 2 + rand() * (rh - 4), S, 1);
    }
    ctx.fillStyle = spec.line;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(0, y, S, 1.5);
    for (const x of joints) ctx.fillRect(x, y, 1.5, rh);
    ctx.globalAlpha = 1;
  }
}

function drawTiles(ctx: Ctx, S: number, spec: FloorSpec, rand: () => number, vary: number, grout: number): void {
  const n = 2;
  const t = S / n;
  ctx.fillStyle = spec.line;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      ctx.fillStyle = shade(spec.color, (rand() - 0.5) * vary);
      ctx.fillRect(i * t + grout / 2, j * t + grout / 2, t - grout, t - grout);
    }
  }
}

function draw(spec: FloorSpec, S: number, ctx: Ctx): void {
  const rand = rng(hash(`${spec.kind}${spec.color}${spec.line}`));
  ctx.fillStyle = spec.color;
  ctx.fillRect(0, 0, S, S);
  switch (spec.kind) {
    case 'wood':
      drawWood(ctx, S, spec, rand);
      break;
    case 'tile':
      drawTiles(ctx, S, spec, rand, 0.05, 5);
      break;
    case 'stone':
      drawTiles(ctx, S, spec, rand, 0.12, 3);
      mottle(ctx, S, rand, 14, 0.05);
      speckle(ctx, S, rand, 0.05);
      break;
    case 'concrete':
      mottle(ctx, S, rand, 22, 0.045);
      speckle(ctx, S, rand, 0.07);
      break;
    case 'carpet':
      mottle(ctx, S, rand, 8, 0.03);
      speckle(ctx, S, rand, 0.16);
      break;
    case 'plain':
      break;
  }
}

/**
 * The texture for a floor, or null for plain floors (and outside a browser).
 * UVs are expected in pattern repeats: world meters ÷ `spec.size`.
 */
export function floorTexture(spec: FloorSpec): THREE.Texture | null {
  if (spec.kind === 'plain') return null;
  const key = `${spec.kind}|${spec.color}|${spec.line}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let texture: THREE.Texture | null = null;
  try {
    if (typeof document !== 'undefined') {
      const S = 256;
      const canvas = document.createElement('canvas');
      canvas.width = S;
      canvas.height = S;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        draw(spec, S, ctx);
        texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        texture.name = `floor-${spec.kind}`;
      }
    }
  } catch {
    texture = null; // a flat color is a fine floor
  }
  cache.set(key, texture);
  return texture;
}
