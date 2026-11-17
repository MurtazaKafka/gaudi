/**
 * Bounce light for the live view.
 *
 * The photographed sky lights every surface as if it stood in the open, so a
 * room under a ceiling was as bright in its corners as on the lawn, and a
 * sunlit floor threw no warmth on the walls. Here each indoor room gets its
 * own light instead: BounceLight.tsx photographs the room from the middle (a
 * tiny cube of pictures), boils that down to nine numbers per colour
 * (spherical harmonics), and every patched material, wherever it lies inside
 * a room and below the wall tops, takes its soft light from its room's nine
 * numbers in place of the sky's. Reflections are left alone.
 *
 * A top-down map of the plan says which room each spot is in. Through a
 * doorway the light of the two rooms blends over half a metre or so, so a
 * floor running from one room into the next has no seam; a wall stops that.
 *
 * Outside every room, and until a first capture is in, the patched materials
 * draw exactly as they did before.
 */
import * as THREE from 'three';
import type { DetectedRoom } from '../rooms';
import type { Opening, Point, Wall } from '../types';

/** Rooms with a light of their own (the rest keep the sky's). */
export const MAX_BOUNCE_ROOMS = 24;

/**
 * 0 = off (every material as before), 1 = first capture (indoors lit by direct light only),
 * 2 = on (indoors lit by its room's captured light).
 */
export type BounceMode = 0 | 1 | 2;

/** Ground cell of the room map, in metres (grows for very large plans). */
const CELL = 0.05;
const MAX_CELLS = 1024;
/** How far a doorway's blend reaches into each room, in metres. */
const BLEND_REACH = 0.7;

function blankRoomMap(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.name = 'bounce-rooms';
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Nine colour coefficients per room, one row per room; row 0 (outside) unused. */
export function blankLightTable(): THREE.DataTexture {
  const t = new THREE.DataTexture(
    new Float32Array(9 * (MAX_BOUNCE_ROOMS + 1) * 4),
    9,
    MAX_BOUNCE_ROOMS + 1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  t.name = 'bounce-light';
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const blankMap = blankRoomMap();
const blankTable = blankLightTable();

/** Shared by every patched material: change a value and call invalidate(). */
export const bounceUniforms = {
  bounceMode: { value: 0 as number },
  /**
   * Room map: r = room (1…, 0 = outside), g = the room blended in through a doorway, b = its weight ×2,
   * a = how open the spot is (1 in the middle of a room, less by a wall, least in a corner).
   */
  bounceRooms: { value: blankMap as THREE.Texture },
  /** Plan area the room map covers: min x, min z, size x, size z (metres). */
  bounceBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
  bounceLight: { value: blankTable as THREE.Texture },
  /** Wall tops: above this nothing is indoors. */
  bounceHeight: { value: 2.7 },
  /** Captured light × this. */
  bounceStrength: { value: 1.2 },
  /** How much of the sky's own soft light still reaches indoors (light the capture can't see: more bounces, a little leak). */
  bounceSky: { value: 0.1 },
  /** How much of the bounced light's colour is kept (1 = all; the floor's warmth, not a coat of its paint). */
  bounceChroma: { value: 0.45 },
  /** How much corners, wall feet and room edges darken (0 = not at all). */
  bounceShade: { value: 0.6 },
  /** 1 when the rooms have ceilings (walking): the tops of the walls darken too. */
  bounceCeiling: { value: 0 },
};

/** Free a room map that was in use (never the blank stand-in). */
export function disposeRoomMap(t: THREE.Texture): void {
  if (t !== blankMap && t.name === 'bounce-rooms') t.dispose();
}

export function resetBounceUniforms(): void {
  bounceUniforms.bounceMode.value = 0;
  bounceUniforms.bounceRooms.value = blankMap;
  bounceUniforms.bounceLight.value = blankTable;
}

// ---------- the shader patch ----------

const VERTEX_PARS = /* glsl */ `
varying vec3 vBounceWorld;`;

const VERTEX_MAIN = /* glsl */ `
{
  vec4 bounceWorld = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    bounceWorld = batchingMatrix * bounceWorld;
  #endif
  #ifdef USE_INSTANCING
    bounceWorld = instanceMatrix * bounceWorld;
  #endif
  vBounceWorld = ( modelMatrix * bounceWorld ).xyz;
}`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vBounceWorld;
uniform float bounceMode;
uniform sampler2D bounceRooms;
uniform vec4 bounceBounds;
uniform sampler2D bounceLight;
uniform float bounceHeight;
uniform float bounceStrength;
uniform float bounceSky;
uniform float bounceChroma;
uniform float bounceShade;
uniform float bounceCeiling;

vec3 bounceRoomIrradiance( const in int room, const in vec3 worldNormal, const in vec3 sky ) {
  if ( room <= 0 ) return sky;
  if ( bounceMode < 1.5 ) return sky * bounceSky;
  vec3 c[ 9 ];
  for ( int k = 0; k < 9; k ++ ) c[ k ] = texelFetch( bounceLight, ivec2( k, room ), 0 ).rgb;
  vec3 e = max( shGetIrradianceAt( worldNormal, c ), vec3( 0.0 ) );
  // A ceiling sees the floor and the lower walls. The one capture per room under-counts the sunlit
  // floor, and a ceiling left to it sits like a dark lid: let it share most of what the walls get.
  float bounceDown = smoothstep( 0.5, 0.95, - worldNormal.y );
  if ( bounceDown > 0.0 ) {
    vec3 side = 0.25 * ( shGetIrradianceAt( vec3( 1.0, 0.0, 0.0 ), c ) + shGetIrradianceAt( vec3( - 1.0, 0.0, 0.0 ), c )
      + shGetIrradianceAt( vec3( 0.0, 0.0, 1.0 ), c ) + shGetIrradianceAt( vec3( 0.0, 0.0, - 1.0 ), c ) );
    e = mix( e, max( e, max( side, vec3( 0.0 ) ) * 0.85 ), bounceDown );
  }
  e *= bounceStrength;
  e = mix( vec3( dot( e, vec3( 0.2126, 0.7152, 0.0722 ) ) ), e, bounceChroma );
  return e + sky * bounceSky;
}`;

const FRAGMENT_MAIN = /* glsl */ `
#if defined( RE_IndirectDiffuse )
if ( bounceMode > 0.5 ) {
  // Which room: looked up a little in front of the surface, so a wall's outside face (on the room's
  // edge) reads as outdoors and its inside face as the room it faces.
  vec3 bounceFace = inverseTransformDirection( nonPerturbedNormal, viewMatrix );
  vec3 bounceAt = vBounceWorld + bounceFace * 0.12;
  vec2 bounceUv = ( bounceAt.xz - bounceBounds.xy ) / bounceBounds.zw;
  if ( bounceAt.y > - 0.05 && bounceAt.y < bounceHeight && all( greaterThanEqual( bounceUv, vec2( 0.0 ) ) ) && all( lessThan( bounceUv, vec2( 1.0 ) ) ) ) {
    vec4 bounceCell = texture2D( bounceRooms, bounceUv );
    int bounceA = int( bounceCell.r * 255.0 + 0.5 );
    if ( bounceA > 0 ) {
      vec3 bounceN = inverseTransformDirection( geometryNormal, viewMatrix );
      vec3 bounceSkyLight = iblIrradiance + irradiance;
      vec3 bounceLit = bounceRoomIrradiance( bounceA, bounceN, bounceSkyLight );
      float bounceW = bounceCell.b * 0.5;
      if ( bounceW > 0.002 ) {
        int bounceB = int( bounceCell.g * 255.0 + 0.5 );
        bounceLit = mix( bounceLit, bounceRoomIrradiance( bounceB, bounceN, bounceSkyLight ), bounceW );
      }
      // Less light where the room closes in: corners, along the walls, where wall meets floor (and ceiling).
      float bounceSide = clamp( length( bounceFace.xz ), 0.0, 1.0 );
      float bounceOpen = clamp( bounceCell.a / mix( 1.0, 0.6, bounceSide ), 0.0, 1.0 );
      float bounceFoot = mix( 1.0, 0.72 + 0.28 * smoothstep( 0.0, 0.5, vBounceWorld.y ), bounceSide );
      float bounceTop = mix( 1.0, 0.8 + 0.2 * smoothstep( 0.0, 0.45, bounceHeight - vBounceWorld.y ), bounceSide * bounceCeiling );
      bounceLit *= mix( 1.0, bounceOpen * bounceFoot * bounceTop, bounceShade );
      iblIrradiance = bounceLit;
      irradiance = vec3( 0.0 );
    }
  }
}
#endif`;

const patched = new WeakSet<THREE.Material>();
const defaultKey = THREE.Material.prototype.customProgramCacheKey;

/** True for the materials withBounce knows how to patch. */
function patchable(m: THREE.Material): m is THREE.MeshStandardMaterial {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
}

/** Patch a material so that, indoors, it is lit by its room's captured light. Returns the same material. */
export function withBounce<T extends THREE.Material>(material: T): T {
  if (!patchable(material) || patched.has(material)) return material;
  patched.add(material);
  const before = material.onBeforeCompile;
  const ownKey = material.customProgramCacheKey !== defaultKey;
  const keyBefore = ownKey ? material.customProgramCacheKey.bind(material) : () => before.toString();
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    const v = shader.vertexShader;
    const f = shader.fragmentShader;
    if (
      !v.includes('#include <common>') ||
      !v.includes('#include <project_vertex>') ||
      !f.includes('#include <lights_pars_begin>') ||
      !f.includes('#include <lights_fragment_maps>')
    )
      return;
    shader.vertexShader = v
      .replace('#include <common>', `#include <common>${VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>${VERTEX_MAIN}`);
    shader.fragmentShader = f
      .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>${FRAGMENT_PARS}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>${FRAGMENT_MAIN}`);
    Object.assign(shader.uniforms, bounceUniforms);
  };
  material.customProgramCacheKey = () => `${keyBefore()}|bounce2`;
  material.needsUpdate = true;
  return material;
}

/** Patch every standard material under these objects (things built elsewhere: decor, lamps). */
export function bounceAll(roots: readonly (THREE.Object3D | null)[]): void {
  for (const root of roots) {
    root?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      if (Array.isArray(m)) m.forEach((x) => withBounce(x));
      else withBounce(m);
    });
  }
}

// ---------- the room map ----------

export interface RoomMap {
  texture: THREE.DataTexture;
  /** min x, min z, size x, size z */
  bounds: THREE.Vector4;
  /** The rooms that have a light, in map order (index + 1 in the map). */
  rooms: DetectedRoom[];
  /** Where each room's light is captured from (plan x, plan y). */
  probes: Point[];
}

const finite = (...n: number[]) => n.every(Number.isFinite);

/**
 * The top-down map: which room each ground cell is in, and, near a doorway,
 * which neighbouring room's light blends in and how much.
 */
export function buildRoomMap(
  rooms: DetectedRoom[],
  open: ReadonlySet<string>,
  walls: Wall[],
  openings: Opening[],
  wallThickness: number,
): RoomMap | null {
  const lit = rooms
    .filter((r) => !open.has(r.key) && r.polygon.length >= 3 && r.polygon.every((p) => finite(p.x, p.y)))
    .slice(0, MAX_BOUNCE_ROOMS);
  if (lit.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of lit)
    for (const p of r.polygon) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  const pad = 0.5;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const cell = Math.max(CELL, (maxX - minX) / MAX_CELLS, (maxY - minY) / MAX_CELLS);
  const W = Math.max(1, Math.ceil((maxX - minX) / cell));
  const H = Math.max(1, Math.ceil((maxY - minY) / cell));
  const room = new Uint8Array(W * H);

  // Rooms, filled row by row (cell centres).
  lit.forEach((r, i) => {
    const poly = r.polygon;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of poly) {
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const j0 = Math.max(0, Math.floor((y0 - minY) / cell));
    const j1 = Math.min(H - 1, Math.ceil((y1 - minY) / cell));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const y = minY + (j + 0.5) * cell;
      xs.length = 0;
      for (let k = 0, n = poly.length; k < n; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % n];
        if (a.y <= y !== b.y <= y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5));
        const i1 = Math.min(W - 1, Math.floor((xs[k + 1] - minX) / cell - 0.5));
        for (let c = i0; c <= i1; c++) room[j * W + c] = i + 1;
      }
    }
  });

  // Solid wall (doors cut out): light does not blend through it.
  const solid = new Uint8Array(W * H);
  const half = Math.max(0.03, wallThickness / 2) + cell * 0.5;
  const byWall = new Map<string, Opening[]>();
  for (const o of openings) if (o.type === 'door') byWall.set(o.wallId, [...(byWall.get(o.wallId) ?? []), o]);
  for (const w of walls) {
    if (!finite(w.a.x, w.a.y, w.b.x, w.b.y)) continue;
    const dx = w.b.x - w.a.x;
    const dy = w.b.y - w.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const ux = dx / len;
    const uy = dy / len;
    const doors = (byWall.get(w.id) ?? []).map((o) => [o.offset - o.width / 2, o.offset + o.width / 2]);
    const i0 = Math.max(0, Math.floor((Math.min(w.a.x, w.b.x) - half - minX) / cell));
    const i1 = Math.min(W - 1, Math.ceil((Math.max(w.a.x, w.b.x) + half - minX) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(w.a.y, w.b.y) - half - minY) / cell));
    const j1 = Math.min(H - 1, Math.ceil((Math.max(w.a.y, w.b.y) + half - minY) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = minX + (i + 0.5) * cell - w.a.x;
        const py = minY + (j + 0.5) * cell - w.a.y;
        const s = px * ux + py * uy;
        const across = Math.abs(px * uy - py * ux);
        const along = s < 0 ? -s : s > len ? s - len : 0;
        if (Math.hypot(along, across) > half) continue;
        if (doors.some(([a, b]) => s > a && s < b)) continue;
        solid[j * W + i] = 1;
      }
    }
  }

  // Doorways: from every cell that touches another room (or outdoors) across no wall, spread
  // outward through its own room, remembering the nearest such crossing.
  const other = new Uint8Array(W * H);
  const seedX = new Float64Array(W * H);
  const seedY = new Float64Array(W * H);
  const dist = new Float64Array(W * H).fill(Infinity);
  const queue: number[] = [];
  const reach = BLEND_REACH / cell;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const at = j * W + i;
      const a = room[at];
      if (a === 0 || solid[at]) continue;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nb = nj * W + ni;
        if (room[nb] === a || solid[nb]) continue;
        // The crossing lies halfway between the two cells.
        const d = 0.5;
        if (d < dist[at]) {
          dist[at] = d;
          other[at] = room[nb];
          seedX[at] = i + di * 0.5;
          seedY[at] = j + dj * 0.5;
          queue.push(at);
        }
      }
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const at = queue[q];
    const i = at % W;
    const j = (at - i) / W;
    const a = room[at];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nb = nj * W + ni;
        if (room[nb] !== a || solid[nb]) continue;
        const d = Math.hypot(ni - seedX[at], nj - seedY[at]);
        if (d >= dist[nb] - 1e-9 || d > reach) continue;
        dist[nb] = d;
        other[nb] = other[at];
        seedX[nb] = seedX[at];
        seedY[nb] = seedY[at];
        queue.push(nb);
      }
    }
  }

  const openness = opennessOf(room, solid, W, H, cell);
  const data = new Uint8Array(W * H * 4);
  for (let at = 0; at < W * H; at++) {
    data[at * 4] = room[at];
    data[at * 4 + 3] = openness[at];
    const d = dist[at];
    if (room[at] !== 0 && d <= reach) {
      const t = Math.min(1, Math.max(0, d / reach));
      const w = 1 - t * t * (3 - 2 * t); // 1 at the crossing … 0 at full reach
      data[at * 4 + 1] = other[at];
      data[at * 4 + 2] = Math.round(w * 255);
    }
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'bounce-rooms';
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;

  // Where to stand in each room: its centroid when that is well inside, else the cell furthest from its edges.
  const probes = lit.map((r) => probePoint(r));
  return { texture, bounds: new THREE.Vector4(minX, minY, W * cell, H * cell), rooms: lit, probes };
}

/** How far (metres) a spot looks along the floor before a wall closes it in. */
const OPEN_REACH = 1.1;
const OPEN_RAYS = 12;

/**
 * How open each indoor spot is, 0…255: the average of how far it sees in a
 * dozen directions (up to OPEN_REACH) before a wall. Worked out on every
 * other cell and filled in between, so it stays quick on a big plan.
 */
function opennessOf(room: Uint8Array, solid: Uint8Array, W: number, H: number, cell: number): Uint8Array {
  const out = new Uint8Array(W * H).fill(255);
  const step = 2;
  const cw = Math.ceil(W / step) + 1;
  const ch = Math.ceil(H / step) + 1;
  const coarse = new Float32Array(cw * ch).fill(1);
  const steps = Math.ceil(OPEN_REACH / cell);
  const dirs: [number, number][] = [];
  for (let k = 0; k < OPEN_RAYS; k++) {
    const a = ((k + 0.5) / OPEN_RAYS) * Math.PI * 2;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }
  // Inside a wall: about what a spot just in front of one sees.
  const WALL = 0.6;
  for (let cj = 0; cj < ch; cj++) {
    for (let ci = 0; ci < cw; ci++) {
      const i = Math.min(W - 1, ci * step);
      const j = Math.min(H - 1, cj * step);
      const at = j * W + i;
      if (room[at] === 0) continue;
      if (solid[at]) {
        coarse[cj * cw + ci] = WALL;
        continue;
      }
      let sum = 0;
      for (const [dx, dy] of dirs) {
        let s = 1;
        for (; s <= steps; s++) {
          const x = Math.round(i + dx * s);
          const y = Math.round(j + dy * s);
          if (x < 0 || y < 0 || x >= W || y >= H) break;
          if (solid[y * W + x]) break;
        }
        sum += Math.min(s - 1, steps) / steps;
      }
      coarse[cj * cw + ci] = sum / OPEN_RAYS;
    }
  }
  for (let j = 0; j < H; j++) {
    const fy = j / step;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let i = 0; i < W; i++) {
      if (room[j * W + i] === 0) continue;
      const fx = i / step;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const a = coarse[y0 * cw + x0];
      const b = coarse[y0 * cw + x0 + 1];
      const c = coarse[(y0 + 1) * cw + x0];
      const d = coarse[(y0 + 1) * cw + x0 + 1];
      const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      out[j * W + i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return out;
}

function edgeDistance(poly: Point[], p: Point): number {
  let best = Infinity;
  for (let k = 0, n = poly.length; k < n; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1e-9;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

function inside(poly: Point[], p: Point): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function probePoint(r: DetectedRoom): Point {
  const poly = r.polygon;
  const c = r.centroid;
  if (finite(c.x, c.y) && inside(poly, c) && edgeDistance(poly, c) > 0.6) return c;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  let best = finite(c.x, c.y) && inside(poly, c) ? c : poly[0];
  let bestD = inside(poly, best) ? edgeDistance(poly, best) : -1;
  const steps = 14;
  for (let a = 0; a <= steps; a++) {
    for (let b = 0; b <= steps; b++) {
      const p = { x: x0 + ((x1 - x0) * (a + 0.5)) / (steps + 1), y: y0 + ((y1 - y0) * (b + 0.5)) / (steps + 1) };
      if (!inside(poly, p)) continue;
      // Prefer well inside, then near the middle.
      const d = edgeDistance(poly, p) - 0.05 * Math.hypot(p.x - c.x, p.y - c.y);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}
