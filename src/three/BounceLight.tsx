/**
 * Captures the light in each room and hands it to the patched materials (see bounce.ts).
 *
 * From the middle of every indoor room, a little above a table, the scene is
 * photographed six ways into a tiny high-range picture (16 px a side); those
 * pictures are read back once for all rooms together and boiled down to nine
 * colour numbers per room. Two rounds: the first sees the rooms lit only by
 * the sun, the lamps and the sky through the openings; the second sees them
 * lit by the first, so light goes round a corner once more.
 *
 * Captured again when the house is rebuilt, the sun moves (at most every
 * 150 ms while the slider is dragged, and always once after it settles), the
 * view or the look changes, or a sky or a texture arrives. Nothing runs while
 * the view is idle.
 */
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { DetectedRoom } from '../rooms';
import { usePlanStore } from '../store';
import { useViewStore } from './viewStore';
import { useRenderStore } from './render/renderStore';
import { onSkyLoad } from './sky';
import { onTextureLoad } from './textureSet';
import { POP_MS, riseClock } from './rise';
import { blankLightTable, bounceAll, bounceUniforms, buildRoomMap, disposeRoomMap, resetBounceUniforms } from './bounce';
import type { RoomMap } from './bounce';

export interface BounceLightProps {
  rooms: DetectedRoom[];
  /** Rooms open to the sky. */
  open: ReadonlySet<string>;
  wallHeight: number;
  /** The house as currently built; a new array means it was rebuilt and the light must be captured again. */
  layers: readonly (THREE.Object3D | null)[];
}

/** Side of each captured picture, in pixels. */
const FACE = 16;
/** Rounds of capture: 2 = light from the sun's patch reaches the wall, and from the wall the far corner. */
const PASSES = 2;
/** Fastest re-capture while the sun slider moves. */
const THROTTLE_MS = 150;
/** Brightest a captured pixel may count for (linear light; a sunlit plaster wall is around 1). */
const HOT = 1.0;
/** Longest stretch of capture work before the main thread is let go, ms. */
const CHUNK_MS = 6;
/** Once the house has risen (or a new piece has dropped in), capture what is really standing. */
/** Long enough for a build or an edit to finish moving before the rooms' light is captured. */
const settledMs = (): number => Math.max(riseClock.ms, POP_MS) + 250;

/** The six ways the room is photographed: where it looks, and which way is up. */
const FACES: [THREE.Vector3, THREE.Vector3][] = [
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
  [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1)],
  [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
];

const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const nextTask = () => new Promise<void>((done) => setTimeout(done, 0));

/** Per pixel of the six pictures: its nine spherical-harmonic weights, already scaled for the area it covers. */
function projectionTable(n: number): { table: Float32Array; norm: number } {
  const table = new Float32Array(6 * n * n * 9);
  const basis = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const origin = new THREE.Vector3();
  let total = 0;
  FACES.forEach(([dir, up], f) => {
    q.setFromRotationMatrix(m.lookAt(origin, dir, up));
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        v.set(((i + 0.5) / n) * 2 - 1, ((j + 0.5) / n) * 2 - 1, -1);
        const len2 = v.lengthSq();
        const weight = 4 / (Math.sqrt(len2) * len2);
        total += weight;
        v.applyQuaternion(q).normalize();
        THREE.SphericalHarmonics3.getBasisAt(v, basis);
        const at = ((f * n + j) * n + i) * 9;
        for (let k = 0; k < 9; k++) table[at + k] = basis[k] * weight;
      }
    }
  });
  return { table, norm: (4 * Math.PI) / total };
}

function faceQuaternions(): THREE.Quaternion[] {
  const m = new THREE.Matrix4();
  const origin = new THREE.Vector3();
  return FACES.map(([dir, up]) => new THREE.Quaternion().setFromRotationMatrix(m.lookAt(origin, dir, up)));
}

const isDrawn = (o: THREE.Object3D): boolean => {
  const x = o as THREE.Mesh & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return x.isMesh === true || x.isLine === true || x.isPoints === true || x.isSprite === true;
};

/** Smaller than this (bounding radius, metres) and a thing hardly changes a room's light: left out of the capture. */
const SMALL = 0.3;

/**
 * Seen by the capture: the house's solid surfaces of some size. Glass, glows laid over things,
 * lines, overlays and small bits (handles, frames, books) are not: each costs a draw per picture.
 */
function captured(o: THREE.Object3D): boolean {
  const mesh = o as THREE.Mesh & { isInstancedMesh?: boolean; boundingSphere?: THREE.Sphere | null };
  if (!mesh.isMesh || o.name === 'room-hover' || o.name === 'grass') return false;
  const m = mesh.material as THREE.Material | THREE.Material[];
  const list = Array.isArray(m) ? m : [m];
  if (!list.every((x) => !x.transparent && x.blending === THREE.NormalBlending && x.visible)) return false;
  let sphere: THREE.Sphere | null | undefined;
  if (mesh.isInstancedMesh) {
    sphere = mesh.boundingSphere;
  } else {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    sphere = mesh.geometry.boundingSphere;
  }
  if (!sphere) return true;
  return sphere.radius * mesh.matrixWorld.getMaxScaleOnAxis() >= SMALL;
}

export interface BounceStats {
  rooms: number;
  /** The last capture was a quick one (one round, while the sun moves). */
  quick: boolean;
  /** Draw calls the last capture made. */
  calls: number;
  /** Time spent issuing the renders, ms (main thread). */
  renderMs: number;
  /** Waiting for capture shaders to be ready, ms (mostly off the main thread). */
  compileMs: number;
  /** Turning the read-back pictures into room light, ms (main thread). */
  projectMs: number;
  /** From start to the light being in use, ms (includes waiting for the GPU). */
  totalMs: number;
  bakes: number;
}

/** Dev: compare with and without. */
let forcedOff = false;
const stats: BounceStats = { rooms: 0, quick: false, calls: 0, compileMs: 0, renderMs: 0, projectMs: 0, totalMs: 0, bakes: 0 };

export function BounceLight({ rooms, open, wallHeight, layers }: BounceLightProps) {
  const get = useThree((s) => s.get);
  const walls = usePlanStore((s) => s.walls);
  const openings = usePlanStore((s) => s.openings);
  const thickness = usePlanStore((s) => s.settings.wallThickness);
  const styleId = usePlanStore((s) => s.look?.style);
  const sunHour = useViewStore((s) => s.sunHour);
  // Lamp-lit rooms are warm, not bright: by evening the bounced light is held back.
  useEffect(() => {
    const evening = sunHour >= 18 || sunHour <= 6.5;
    bounceUniforms.bounceStrength.value = evening ? 0.62 : 1.2;
    bounceUniforms.bounceChroma.value = evening ? 0.3 : 0.45;
    get().invalidate();
  }, [sunHour, get]);
  const view = useViewStore((s) => s.view);
  const walking = useViewStore((s) => s.walking);
  const rendering = useRenderStore((s) => s.phase !== 'off');
  // The maquette is a white model under a studio lamp: it keeps the light it always had.
  const enabled = styleId !== 'maquette' && styleId !== undefined;

  const map = useMemo(
    () =>
      buildRoomMap(
        rooms,
        open,
        Array.isArray(walls) ? walls : [],
        Array.isArray(openings) ? openings : [],
        Number.isFinite(thickness) ? thickness : 0.15,
      ),
    [rooms, open, walls, openings, thickness],
  );
  // A map that never made it into use is freed when it is replaced; one in use is freed by the next capture.
  useEffect(
    () => () => {
      if (map && bounceUniforms.bounceRooms.value !== map.texture) map.texture.dispose();
    },
    [map],
  );

  /** What the next capture should use: always the latest. */
  const input = useRef({ map, layers, wallHeight, enabled, rendering, ceilings: walking });
  useEffect(() => {
    input.current = { map, layers, wallHeight, enabled, rendering, ceilings: walking };
  }, [map, layers, wallHeight, enabled, rendering, walking]);

  const baker = useRef<{ request: (delay?: number) => void; sync: () => void } | null>(null);

  // The capture machinery, for the life of the view.
  useEffect(() => {
    const { gl, scene } = get();
    let alive = true;
    let busy = false;
    let dirty = false;
    let last = -Infinity;
    let timer = 0;
    let type: THREE.TextureDataType = THREE.HalfFloatType;
    let target: THREE.WebGLRenderTarget | null = null;
    const camera = new THREE.PerspectiveCamera(90, 1, 0.03, 80);
    const quats = faceQuaternions();
    const { table, norm } = projectionTable(FACE);
    const display = blankLightTable();
    const scratch = blankLightTable();

    const targetFor = (count: number): THREE.WebGLRenderTarget => {
      const w = FACE * 6;
      const h = FACE * count;
      if (target && target.width === w && target.height === h && target.texture.type === type) return target;
      target?.dispose();
      target = new THREE.WebGLRenderTarget(w, h, {
        type,
        format: THREE.RGBAFormat,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        generateMipmaps: false,
        depthBuffer: true,
      });
      target.texture.name = 'bounce-capture';
      return target;
    };

    /** Everything drawn that the capture must not see, hidden; returns how to put it back. */
    const hideForCapture = (roots: readonly (THREE.Object3D | null)[]): (() => void) => {
      const keep = new Set<THREE.Object3D>();
      for (const r of roots) r?.traverse((o) => void (captured(o) && keep.add(o)));
      const hidden: THREE.Object3D[] = [];
      scene.traverse((o) => {
        if (o.visible && isDrawn(o) && !keep.has(o)) {
          o.visible = false;
          hidden.push(o);
        }
      });
      const bg = scene.background;
      const bgIntensity = scene.backgroundIntensity;
      const bgBlur = scene.backgroundBlurriness;
      const bgTurn = scene.backgroundRotation.clone();
      // Through the windows (and over the dollhouse's open top) the rooms see the sky that lights everything else.
      if (scene.environment) {
        scene.background = scene.environment;
        scene.backgroundIntensity = scene.environmentIntensity;
        scene.backgroundBlurriness = 0;
        scene.backgroundRotation.copy(scene.environmentRotation);
      }
      return () => {
        for (const o of hidden) o.visible = true;
        scene.background = bg;
        scene.backgroundIntensity = bgIntensity;
        scene.backgroundBlurriness = bgBlur;
        scene.backgroundRotation.copy(bgTurn);
      };
    };

    let calls = 0;
    /** Render rooms [from, to)'s six pictures into the atlas, with the materials set up as given. */
    const shoot = (
      m: RoomMap,
      rt: THREE.WebGLRenderTarget,
      mode: 1 | 2,
      light: THREE.Texture,
      height: number,
      y: number,
      from: number,
      to: number,
    ) => {
      const u = bounceUniforms;
      const saved = {
        mode: u.bounceMode.value,
        rooms: u.bounceRooms.value,
        bounds: u.bounceBounds.value,
        light: u.bounceLight.value,
        height: u.bounceHeight.value,
      };
      u.bounceMode.value = mode;
      u.bounceRooms.value = m.texture;
      u.bounceBounds.value = m.bounds;
      u.bounceLight.value = light;
      u.bounceHeight.value = height;
      const before = gl.getRenderTarget();
      const autoClear = gl.autoClear;
      const shadowAuto = gl.shadowMap.autoUpdate;
      gl.autoClear = true;
      // The sun's shadows are the same from every point of view: the main view's, drawn just before, are reused.
      gl.shadowMap.autoUpdate = false;
      rt.scissorTest = true;
      try {
        m.probes.slice(from, to).forEach((p, k) => {
          const r = from + k;
          camera.position.set(p.x, y, p.y);
          for (let f = 0; f < 6; f++) {
            camera.quaternion.copy(quats[f]);
            camera.updateMatrixWorld(true);
            rt.viewport.set(f * FACE, r * FACE, FACE, FACE);
            rt.scissor.set(f * FACE, r * FACE, FACE, FACE);
            gl.setRenderTarget(rt);
            gl.render(scene, camera);
            calls += gl.info.render.calls;
          }
        });
      } finally {
        gl.shadowMap.autoUpdate = shadowAuto;
        gl.setRenderTarget(before);
        gl.autoClear = autoClear;
        u.bounceMode.value = saved.mode;
        u.bounceRooms.value = saved.rooms;
        u.bounceBounds.value = saved.bounds;
        u.bounceLight.value = saved.light;
        u.bounceHeight.value = saved.height;
      }
    };

    /**
     * All rooms, a few at a time: the main thread is let go every few milliseconds, so a capture never
     * holds up a frame for long. Returns the time spent drawing.
     */
    const shootAll = async (
      m: RoomMap,
      roots: readonly (THREE.Object3D | null)[],
      rt: THREE.WebGLRenderTarget,
      mode: 1 | 2,
      light: THREE.Texture,
      height: number,
      y: number,
    ): Promise<number> => {
      let ms = 0;
      let r = 0;
      while (r < m.probes.length && alive) {
        const a = performance.now();
        const restore = hideForCapture(roots);
        try {
          do {
            shoot(m, rt, mode, light, height, y, r, r + 1);
            r++;
          } while (r < m.probes.length && performance.now() - a < CHUNK_MS);
        } finally {
          restore();
        }
        ms += performance.now() - a;
        if (r < m.probes.length) await nextTask();
      }
      return ms;
    };

    /** The atlas read back, as nine colour coefficients per room into `into`. */
    const project = (pixels: Uint16Array | Float32Array, count: number, into: THREE.DataTexture) => {
      const out = into.image.data as Float32Array;
      out.fill(0);
      const W = FACE * 6;
      const half = pixels instanceof Uint16Array;
      const read = (x: number) => (half ? THREE.DataUtils.fromHalfFloat(x) : x);
      for (let r = 0; r < count; r++) {
        const c = new Float64Array(27);
        for (let f = 0; f < 6; f++) {
          for (let j = 0; j < FACE; j++) {
            for (let i = 0; i < FACE; i++) {
              const at = ((r * FACE + j) * W + f * FACE + i) * 4;
              let red = read(pixels[at]);
              let green = read(pixels[at + 1]);
              let blue = read(pixels[at + 2]);
              // A hot spot (the ceiling right over a lamp, a bulb, the sun) is held down to a bright
              // surface's worth: the lamps are placed for their direct light, not to light the room twice.
              const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
              if (lum > HOT) {
                const k = HOT / lum;
                red *= k;
                green *= k;
                blue *= k;
              }
              const t = ((f * FACE + j) * FACE + i) * 9;
              for (let k = 0; k < 9; k++) {
                const w = table[t + k];
                c[k * 3] += red * w;
                c[k * 3 + 1] += green * w;
                c[k * 3 + 2] += blue * w;
              }
            }
          }
        }
        const row = (r + 1) * 9 * 4;
        for (let k = 0; k < 9; k++) {
          // A stray bright pixel (a lamp's bulb, the sun in the sky) must not turn into a wild coefficient.
          out[row + k * 4] = Number.isFinite(c[k * 3]) ? c[k * 3] * norm : 0;
          out[row + k * 4 + 1] = Number.isFinite(c[k * 3 + 1]) ? c[k * 3 + 1] * norm : 0;
          out[row + k * 4 + 2] = Number.isFinite(c[k * 3 + 2]) ? c[k * 3 + 2] * norm : 0;
          out[row + k * 4 + 3] = 1;
        }
      }
      into.needsUpdate = true;
    };

    const readBack = async (rt: THREE.WebGLRenderTarget): Promise<Uint16Array | Float32Array> => {
      const n = rt.width * rt.height * 4;
      const buffer = rt.texture.type === THREE.FloatType ? new Float32Array(n) : new Uint16Array(n);
      await gl.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height, buffer);
      return buffer;
    };

    const off = () => {
      if (bounceUniforms.bounceMode.value !== 0) {
        bounceUniforms.bounceMode.value = 0;
        get().invalidate();
      }
    };

    /** The map the light in `display` belongs to, whether that light was a quick one, and when it came in. */
    let shownMap: RoomMap | null = null;
    let shownQuick = false;
    let shownAt = -Infinity;
    let wantFull = false;

    /**
     * Capture the rooms. In full: from scratch, two rounds. Quick (while the sun slider is being dragged):
     * one round, with the light last captured standing in for the first; a full capture follows once it settles.
     */
    const bake = async (allowQuick: boolean) => {
      const { map: m, layers: roots, wallHeight: height, enabled: on } = input.current;
      if (!on || forcedOff || !m) {
        off();
        return;
      }
      const t0 = performance.now();
      // Let the main view draw the change first (its sun shadows are reused here).
      await nextFrame();
      await nextFrame();
      if (!alive) return;
      bounceAll(roots);
      const rt = targetFor(m.probes.length);
      const y = Math.min(1.2, height * 0.45);
      // The capture draws to a high-range target, which needs its own shader variants: built off the main
      // thread first (all of them the first time, then whatever is new: the evening's lamps, a new look).
      const c0 = performance.now();
      {
        const restore = hideForCapture(roots);
        const before = gl.getRenderTarget();
        let job: Promise<unknown>;
        try {
          camera.position.set(m.probes[0].x, y, m.probes[0].y);
          camera.updateMatrixWorld(true);
          gl.setRenderTarget(rt);
          job = gl.compileAsync(scene, camera);
        } finally {
          gl.setRenderTarget(before);
          restore();
        }
        await job;
        if (!alive) return;
      }
      const compileMs = performance.now() - c0;
      let renderMs = 0;
      let projectMs = 0;
      const quick = allowQuick && m === shownMap && performance.now() - shownAt < 600;
      const passes = quick ? 1 : PASSES;
      let light: THREE.Texture = quick ? display : scratch;
      calls = 0;
      for (let pass = 1; pass <= passes; pass++) {
        const into = pass === passes ? display : scratch;
        renderMs += await shootAll(m, roots, rt, pass === 1 && !quick ? 1 : 2, light, height, y);
        if (!alive) return;
        let pixels: Uint16Array | Float32Array;
        try {
          pixels = await readBack(rt);
        } catch (e) {
          // This GPU can't read half floats back: full floats next time.
          if (type === THREE.HalfFloatType) {
            type = THREE.FloatType;
            dirty = true;
            return;
          }
          throw e;
        }
        if (!alive) return;
        const b = performance.now();
        project(pixels, m.probes.length, into);
        projectMs += performance.now() - b;
        light = into;
      }
      // In use, all at once: the map, its rooms' light, the wall height.
      const u = bounceUniforms;
      const old = u.bounceRooms.value;
      u.bounceRooms.value = m.texture;
      u.bounceBounds.value = m.bounds;
      u.bounceLight.value = display;
      u.bounceHeight.value = height;
      u.bounceCeiling.value = input.current.ceilings ? 1 : 0;
      if (old !== m.texture) disposeRoomMap(old);
      u.bounceMode.value = input.current.enabled && !forcedOff ? 2 : 0;
      shownMap = m;
      shownQuick = quick;
      shownAt = performance.now();
      Object.assign(stats, {
        quick,
        calls,
        rooms: m.probes.length,
        renderMs: +renderMs.toFixed(2),
        compileMs: +compileMs.toFixed(2),
        projectMs: +projectMs.toFixed(2),
        totalMs: +(performance.now() - t0).toFixed(2),
        bakes: stats.bakes + 1,
      });
      get().invalidate();
    };

    const kick = () => {
      if (!alive || busy || !dirty) return;
      window.clearTimeout(timer);
      // On a big plan a capture takes longer: keep it to a fair share of the main thread.
      const gap = Math.max(THROTTLE_MS, stats.renderMs * 4);
      timer = window.setTimeout(run, Math.max(0, last + gap - performance.now()));
    };
    const run = () => {
      if (!alive || busy || !dirty) return;
      // The path tracer has the renderer; capture again when it is done.
      if (input.current.rendering) return;
      dirty = false;
      busy = true;
      last = performance.now();
      const allowQuick = !wantFull;
      wantFull = false;
      bake(allowQuick)
        .catch((e: unknown) => {
          if (import.meta.env.DEV) console.warn('[bounce]', e);
          off();
        })
        .finally(() => {
          busy = false;
          kick();
        });
    };
    const lateTimers = new Set<number>();
    let settle = 0;
    baker.current = {
      request: (delay = 0) => {
        if (delay > 0) {
          const id = window.setTimeout(() => {
            lateTimers.delete(id);
            baker.current?.request();
          }, delay);
          lateTimers.add(id);
          return;
        }
        dirty = true;
        kick();
        // However the requests came, the last one ends in a full capture.
        window.clearTimeout(settle);
        settle = window.setTimeout(() => {
          if (!shownQuick && !busy && !dirty) return;
          wantFull = true;
          dirty = true;
          kick();
        }, THROTTLE_MS * 2.5);
      },
      sync: () => {
        if (!input.current.enabled || forcedOff) off();
      },
    };
    const unSky = onSkyLoad(() => baker.current?.request());
    const unTex = onTextureLoad(() => baker.current?.request(60));
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__bounce = {
        stats,
        uniforms: bounceUniforms,
        setEnabled: (on: boolean) => {
          forcedOff = !on;
          if (forcedOff) off();
          else baker.current?.request();
        },
        recapture: () => baker.current?.request(),
      };
    }
    return () => {
      alive = false;
      unSky();
      unTex();
      window.clearTimeout(timer);
      window.clearTimeout(settle);
      for (const id of lateTimers) window.clearTimeout(id);
      baker.current = null;
      const inUse = bounceUniforms.bounceRooms.value;
      resetBounceUniforms();
      disposeRoomMap(inUse);
      target?.dispose();
      display.dispose();
      scratch.dispose();
      get().invalidate();
    };
  }, [get]);

  // What changes the light in the rooms.
  useEffect(() => {
    baker.current?.sync();
    baker.current?.request();
  }, [map, sunHour, view, walking, styleId, wallHeight, enabled, rendering]);
  useEffect(() => {
    baker.current?.request();
    // A house still rising (or a piece still dropping in) is captured again once it stands.
    baker.current?.request(settledMs());
  }, [layers]);

  return null;
}
