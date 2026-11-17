import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { useKeyStore } from '../ai/client';
import { buildWallModel, wallBlockers } from '../build';
import type { WallModel } from '../build';
import { furnitureDef } from '../catalog';
import { partsBounds } from '../customItems';
import { detectRooms } from '../rooms';
import type { DetectedRoom } from '../rooms';
import { downloadBlob } from '../serialize';
import { toast, toastError } from '../toast';
import type { PlanSettings, Point, RoofKind, Wall } from '../types';
import {
  buildCeilings,
  buildRoomLamps,
  lampsOn,
  buildFloors,
  buildFurniture,
  buildOpenings,
  buildRoofGroup,
  buildWalls,
  disposeGroup,
  indoorRooms,
  materialKit,
  sanitizeForScene,
} from '../three/house';
import { openAirRooms } from '../three/footprint';
import { chooseRoof, chooseStyle } from '../three/lookActions';
import { buildRoof } from '../three/roof';
import { SceneBar } from '../three/SceneBar';
import { buildSite, planSite } from '../three/site';
import { capturePng, fileSlug } from '../three/snapshot';
import { PathTrace } from '../three/render/PathTrace';
import { LivePost } from '../three/LivePost';
import { livePost } from '../three/postState';
import { onTextureLoad } from '../three/textureSet';
import { onModelLoad } from '../three/furnitureModels';
import { backdropFor, horizonFor, onSkyLoad, skyFor, skyGain, skyIdFor, zenithFor } from '../three/sky';
import { buildLawn, disposeGarden, lawnColor } from '../three/garden';
import { buildPlanting } from '../three/plants';
import { buildDecor } from '../three/decor';
import { BounceLight } from '../three/BounceLight';
import { buildGrounds } from '../three/grounds';
import { applyPop, applyRise, calmMotion, keysOf, newcomers, POP_MS, riseClock } from '../three/rise';
import type { Pop } from '../three/rise';
import { RenderOverlay } from '../three/render/RenderOverlay';
import { useRenderStore } from '../three/render/renderStore';
import { effectiveRoof, STYLES, styleById } from '../three/styles';
import { LAMP_DISTANCE, mixHex, sunState, sunPhase } from '../three/sun';
import { useViewStore } from '../three/viewStore';
import { LENS_FOV, lensReach } from '../three/lens';
import type { CameraPose } from '../three/viewStore';
import {
  BODY_RADIUS,
  EYE_HEIGHT,
  furnitureObstacles,
  settleWalker,
  stepWalker,
  WALK_SPEED,
  walkDelta,
} from '../three/walk';
import type { WalkWorld } from '../three/walk';
import '../styles/scene.css';
import '../styles/roofs.css';

const WALK_FOV = 68;

/** The slice of OrbitControls this file drives. */
interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
}

interface SceneHandles {
  camera: THREE.PerspectiveCamera;
  controls: (OrbitLike & { enableDamping: boolean }) | null;
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Ask for a frame: the view renders on demand, so moving the camera by hand needs one. */
  invalidate: () => void;
}

declare global {
  interface Window {
    __three?: SceneHandles;
  }
}

// ---------- plan → scene inputs ----------

interface Bounds {
  x: number;
  z: number;
  radius: number;
}

function planBounds(walls: Wall[]): Bounds {
  if (walls.length === 0) return { x: 0, z: 0, radius: 6 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const w of walls) {
    for (const p of [w.a, w.b]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return {
    x: (minX + maxX) / 2,
    z: (minY + maxY) / 2,
    radius: Math.min(500, Math.max((maxX - minX) / 2, (maxY - minY) / 2, 3)),
  };
}

/** The camera that looks down into the house from the south-east, as far back as the lens needs to frame it. */
function defaultPose(b: Bounds, fitNonce: number): CameraPose {
  const k = b.radius * lensReach(useViewStore.getState().lens);
  return {
    position: [b.x + k * 1.4, k * 2.3, b.z + k * 1.8],
    target: [b.x, 0, b.z],
    fitNonce,
  };
}

interface ScenePlan {
  walls: Wall[];
  settings: PlanSettings;
  rooms: DetectedRoom[];
  /** Keys of rooms open to the sky: courtyards, patios. */
  open: ReadonlySet<string>;
  model: WallModel;
  bounds: Bounds;
}

function useScenePlan(): ScenePlan {
  const rawWalls = usePlanStore((s) => s.walls);
  const openings = usePlanStore((s) => s.openings);
  const rawSettings = usePlanStore((s) => s.settings);
  const { walls, settings } = useMemo(() => sanitizeForScene(rawWalls, rawSettings), [rawWalls, rawSettings]);
  const roomNames = usePlanStore((s) => s.roomNames);
  const rooms = useMemo(() => detectRooms(walls), [walls]);
  // Renaming a room only matters here when it changes which rooms are open air: keep the set stable otherwise.
  const openKey = useMemo(() => [...openAirRooms(rooms, roomNames)].sort().join('\n'), [rooms, roomNames]);
  const open = useMemo<ReadonlySet<string>>(() => new Set(openKey ? openKey.split('\n') : []), [openKey]);
  const model = useMemo(
    () => buildWallModel(walls, openings, settings, indoorRooms(rooms, open)),
    [walls, openings, settings, rooms, open],
  );
  const bounds = useMemo(() => planBounds(walls), [walls]);
  return useMemo(
    () => ({ walls, settings, rooms, open, model, bounds }),
    [walls, settings, rooms, open, model, bounds],
  );
}

/** Free a layer's geometry when it is replaced or the scene goes away. */
function useDisposal(group: THREE.Group | null): void {
  useEffect(() => () => disposeGroup(group), [group]);
}

// ---------- the house ----------

function House({ plan }: { plan: ScenePlan }) {
  const furniture = usePlanStore((s) => s.furniture);
  const customItems = usePlanStore((s) => s.customItems);
  const roomNames = usePlanStore((s) => s.roomNames);
  const styleId = usePlanStore((s) => s.look?.style);
  const planRoof = usePlanStore((s) => s.look?.roof ?? 'none');
  const view = useViewStore((s) => s.view);
  const orbitView = useViewStore((s) => s.orbitView);
  const walking = useViewStore((s) => s.walking);

  const { walls, settings, rooms, open, model } = plan;
  const style = styleById(styleId);
  const kit = useMemo(() => materialKit(style), [style]);

  const wallsGroup = useMemo(() => buildWalls(model, kit, true), [model, kit]);
  const openingsGroup = useMemo(() => buildOpenings(model.openings, kit, model.pieces), [model, kit]);
  const floorsGroup = useMemo(() => buildFloors(rooms, roomNames ?? {}, kit, open), [rooms, roomNames, kit, open]);
  // Furniture models arrive after the first build; build again when one does.
  const [modelsVersion, setModelsVersion] = useState(0);
  useEffect(() => onModelLoad(() => setModelsVersion((v) => v + 1)), []);
  const furnitureGroup = useMemo(() => {
    void modelsVersion;
    // furnitureDef reads a mirror of customItems, so a changed definition must rebuild.
    void customItems;
    return buildFurniture(Array.isArray(furniture) ? furniture : [], kit);
  }, [furniture, customItems, kit, modelsVersion]);

  // Dollhouse looks in; Exterior has the roof on; a walk gets ceilings, and the
  // roof too if the house has one (it casts nothing then, so rooms stay sunlit).
  const roofOn = view === 'exterior' || (walking && (orbitView === 'exterior' || planRoof !== 'none'));
  // Which roof to show is decided here, while drawing — looking never edits the plan.
  const roofKind = effectiveRoof(planRoof, style, roofOn);
  const roofGroup = useMemo(
    () =>
      roofKind === 'none' ? null : buildRoofGroup(buildRoof(roofKind, { rooms, walls, settings, open }), kit, !walking),
    [roofKind, rooms, walls, settings, open, kit, walking],
  );
  const ceilingsGroup = useMemo(
    () => (walking ? buildCeilings(rooms, settings.wallHeight, kit, open) : null),
    [walking, rooms, settings, kit, open],
  );

  // Evening: the rooms light up from inside.
  const sunHour = useViewStore((s) => s.sunHour);
  const lit = lampsOn(sunHour) && style.id !== 'maquette';
  // The glowing window panes only make sense seen from outside, with the roof on.
  const panes = view === 'exterior' && !walking;
  const lampsGroup = useMemo(
    () => (lit ? buildRoomLamps(rooms, settings.wallHeight, open, model.openings, model.pieces, panes) : null),
    [lit, rooms, settings.wallHeight, open, model, panes],
  );
  useDisposal(lampsGroup);

  // Rugs, pictures, lamps and the rest: the 3D view dresses the rooms; the plan never holds them.
  const details = useViewStore((s) => s.details);
  const decorGroup = useMemo(
    () =>
      details && style.id !== 'maquette'
        ? buildDecor({
            rooms,
            roomNames: roomNames ?? {},
            furniture: Array.isArray(furniture) ? furniture : [],
            openings: model.openings,
            pieces: model.pieces,
            settings,
            style,
            open,
            evening: lit,
          })
        : null,
    [details, style, rooms, roomNames, furniture, model, settings, open, lit],
  );
  useDisposal(decorGroup);
  const bounceLayers = useMemo(
    () => [wallsGroup, floorsGroup, furnitureGroup, openingsGroup, roofGroup, ceilingsGroup, lampsGroup, decorGroup],
    [wallsGroup, floorsGroup, furnitureGroup, openingsGroup, roofGroup, ceilingsGroup, lampsGroup, decorGroup],
  );

  // The house builds itself when it is first shown, and again when the plan is replaced.
  const fitNonce = useUiStore((s) => s.fitNonce);
  const getThree = useThree((s) => s.get);
  /** How far through the build, 0…1; 1 = standing. */
  const rise = useRef(1);
  const { x: bx, z: bz, radius: br } = plan.bounds;
  const riseParts = useMemo(
    () => ({
      walls: wallsGroup,
      openings: openingsGroup,
      furniture: furnitureGroup,
      roof: roofGroup,
      dressing: [decorGroup, lampsGroup],
      x: bx,
      z: bz,
      radius: br,
    }),
    [wallsGroup, openingsGroup, furnitureGroup, roofGroup, decorGroup, lampsGroup, bx, bz, br],
  );
  useLayoutEffect(() => {
    // Dev-only: the demo recorder slows one build down to show it.
    if (import.meta.env.DEV) (window as unknown as { __rise?: unknown }).__rise = riseClock;
    if (calmMotion()) return;
    rise.current = 0;
    getThree().invalidate();
  }, [fitNonce, getThree]);
  // Anything rebuilt mid-build (a furniture model arriving) joins at the same moment of it.
  useLayoutEffect(() => {
    applyRise(riseParts, rise.current);
  }, [riseParts]);
  useFrame(({ invalidate }, dt) => {
    if (rise.current >= 1) return;
    // Counted in drawn frames, not wall time: a slow first frame (shaders, textures) doesn't eat the build.
    rise.current = Math.min(1, rise.current + (Math.min(dt, 0.05) * 1000) / riseClock.ms);
    applyRise(riseParts, rise.current);
    if (rise.current < 1) invalidate();
  });

  // After the first build, anything new — a wall drawn, a chair placed, an undo bringing something back —
  // arrives on its own instead of blinking in.
  const seen = useRef<Set<string> | null>(null);
  const pops = useRef<Pop[]>([]);
  useLayoutEffect(() => {
    const layers = [wallsGroup, openingsGroup, furnitureGroup];
    const before = seen.current;
    seen.current = keysOf(layers);
    // The first build, and a plan swapped in whole, rise as a house instead (see above).
    if (!before || rise.current < 1 || calmMotion()) return;
    const fresh = newcomers(layers, before);
    // Hundreds of new things is a new plan, not an edit.
    if (fresh.length === 0 || fresh.length > 60) return;
    const t = performance.now();
    for (const object of fresh) {
      const pop: Pop = { object, kind: object.parent === wallsGroup ? 'grow' : 'drop', t };
      applyPop(pop, 0);
      pops.current.push(pop);
    }
    getThree().invalidate();
  }, [wallsGroup, openingsGroup, furnitureGroup, getThree]);
  useFrame(({ invalidate }) => {
    if (pops.current.length === 0) return;
    const now = performance.now();
    pops.current = pops.current.filter((p) => {
      const t = (now - p.t) / POP_MS;
      applyPop(p, t);
      return t < 1;
    });
    invalidate();
  });

  const solids = useMemo(() => [wallsGroup, furnitureGroup, openingsGroup], [wallsGroup, furnitureGroup, openingsGroup]);

  useDisposal(wallsGroup);
  useDisposal(openingsGroup);
  useDisposal(floorsGroup);
  useDisposal(furnitureGroup);
  useDisposal(roofGroup);
  useDisposal(ceilingsGroup);

  return (
    <>
      {view === 'dollhouse' && !walking && <RoomPicker floors={floorsGroup} solids={solids} />}
      {/* Keyed by the object itself: a rebuilt layer is unmounted and mounted, there and then. Left to swap
          in place, react-three-fiber holds the swap back until a later commit whenever the layer is not the
          last child, and the house would show its previous look. */}
      <primitive key={wallsGroup.uuid} object={wallsGroup} />
      <primitive key={openingsGroup.uuid} object={openingsGroup} />
      <primitive key={floorsGroup.uuid} object={floorsGroup} />
      <primitive key={furnitureGroup.uuid} object={furnitureGroup} />
      {roofGroup && <primitive key={roofGroup.uuid} object={roofGroup} />}
      {ceilingsGroup && <primitive key={ceilingsGroup.uuid} object={ceilingsGroup} />}
      {lampsGroup && <primitive key={lampsGroup.uuid} object={lampsGroup} />}
      {decorGroup && <primitive key={decorGroup.uuid} object={decorGroup} />}
      <BounceLight rooms={rooms} open={open} wallHeight={settings.wallHeight} layers={bounceLayers} />
    </>
  );
}

// ---------- pointing at rooms ----------

interface RoomInfo {
  key: string;
  name: string;
  polygon: { x: number; y: number }[];
  centroid: { x: number; y: number };
}

/**
 * In the dollhouse: the room under the pointer lights up and says its name;
 * a click flies the camera over to it. Looking only — nothing in the plan changes.
 */
function RoomPicker({ floors, solids }: { floors: THREE.Group; solids: THREE.Object3D[] }) {
  const get = useThree((s) => s.get);
  const [hover, setHover] = useState<RoomInfo | null>(null);
  const flight = useRef<{ p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; start: number } | null>(null);
  const rendering = useRenderStore((s) => s.phase !== 'off');

  const overlay = useMemo(() => {
    if (!hover) return null;
    const shape = new THREE.Shape(hover.polygon.map((p) => new THREE.Vector2(p.x, p.y)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: '#c14e33', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.025;
    mesh.renderOrder = 4;
    mesh.name = 'room-hover';
    mesh.raycast = () => {};
    return mesh;
  }, [hover]);
  useEffect(
    () => () => {
      overlay?.geometry.dispose();
      (overlay?.material as THREE.Material | undefined)?.dispose();
    },
    [overlay],
  );

  useEffect(() => {
    if (rendering) return;
    const el = get().gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    let frame = 0;
    let last: RoomInfo | null = null;
    const pick = (e: PointerEvent | MouseEvent): RoomInfo | null => {
      const rect = el.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, get().camera);
      // The first thing the pointer meets: a wall or a chair in front of a floor hides it.
      const hit = ray.intersectObjects([floors, ...solids], true).find((h) => h.object.visible && h.object.name !== 'edges');
      const info = hit?.object.userData.room as RoomInfo | undefined;
      return info ?? null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const info = pick(e);
        if (info?.key !== last?.key) {
          last = info;
          setHover(info);
          el.style.cursor = info ? 'pointer' : '';
          get().invalidate();
        }
      });
    };
    const onLeave = () => {
      last = null;
      setHover(null);
      el.style.cursor = '';
      get().invalidate();
    };
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const from = down;
      down = null;
      if (!from || Math.hypot(e.clientX - from.x, e.clientY - from.y) > 5) return;
      const info = pick(e);
      if (!info) return;
      const { camera, controls } = get();
      const orbit = controls as unknown as OrbitLike | null;
      if (!orbit) return;
      // Same angle on the house, closer in, centred on the room.
      let r = 0;
      for (const p of info.polygon) r = Math.max(r, Math.hypot(p.x - info.centroid.x, p.y - info.centroid.y));
      const t1 = new THREE.Vector3(info.centroid.x, 0.4, info.centroid.y);
      const dir = camera.position.clone().sub(orbit.target).normalize();
      if (dir.y < 0.75) dir.setY(0.75).normalize();
      const p1 = t1.clone().addScaledVector(dir, Math.min(16, Math.max(4.5, r * 2.5 + 2)));
      flight.current = { p0: camera.position.clone(), t0: orbit.target.clone(), p1, t1, start: performance.now() };
      get().invalidate();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.style.cursor = '';
    };
  }, [get, floors, solids, rendering]);

  useFrame(({ camera, controls, invalidate }) => {
    const f = flight.current;
    const orbit = controls as unknown as OrbitLike | null;
    if (!f || !orbit) return;
    const t = Math.min(1, (performance.now() - f.start) / 700);
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    camera.position.lerpVectors(f.p0, f.p1, k);
    orbit.target.lerpVectors(f.t0, f.t1, k);
    orbit.update();
    if (t >= 1) {
      flight.current = null;
      useViewStore.getState().setPose({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [orbit.target.x, orbit.target.y, orbit.target.z],
        fitNonce: useUiStore.getState().fitNonce,
      });
    } else invalidate();
  });

  if (!hover || !overlay || rendering) return null;
  return (
    <>
      <primitive key={overlay.uuid} object={overlay} />
      {hover.name && (
        <Html position={[hover.centroid.x, 0.3, hover.centroid.y]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
          <div className="room-chip">{hover.name}</div>
        </Html>
      )}
    </>
  );
}

// ---------- the ground it stands on ----------

/** Lot, doorstep and path, and the soft shadow where walls meet the ground. Never part of the plan. */
function Site({ plan }: { plan: ScenePlan }) {
  const invalidate = useThree((s) => s.invalidate);
  const sunHour = useViewStore((s) => s.sunHour);
  const styleId = usePlanStore((s) => s.look?.style);
  const ground = useMemo(() => sunState(sunHour, styleById(styleId)).ground, [sunHour, styleId]);
  const { rooms, walls, model, settings } = plan;
  const sitePlan = useMemo(() => {
    try {
      return planSite({ rooms, walls, openings: model.openings, wallThickness: settings.wallThickness });
    } catch {
      return null;
    }
  }, [rooms, walls, model, settings.wallThickness]);
  const site = useMemo(() => buildSite(sitePlan), [sitePlan]);
  // Camera shots need to know which way the house faces.
  useEffect(() => {
    const e = sitePlan?.entrance;
    useViewStore.getState().setFront(e && Number.isFinite(e.nx + e.ny) ? [e.nx, e.ny] : [0, 1]);
  }, [sitePlan]);
  useEffect(() => () => site.dispose(), [site]);

  // Styled looks stand on a lawn that runs to the horizon.
  const styled = styleById(styleId).id !== 'maquette';
  const garden = useMemo(() => {
    if (!styled || !sitePlan) return null;
    const { x, z, radius } = plan.bounds;
    const half = settings.wallThickness / 2;
    // Nothing grows through a room, a wall, the path or the doorstep.
    const keepOut: Point[][] = rooms.map((r) => r.polygon);
    for (const w of walls) {
      const dx = w.b.x - w.a.x;
      const dy = w.b.y - w.a.y;
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) continue;
      const nx = (-dy / len) * 0.01;
      const ny = (dx / len) * 0.01;
      keepOut.push([
        { x: w.a.x + nx, y: w.a.y + ny },
        { x: w.b.x + nx, y: w.b.y + ny },
        { x: w.b.x - nx, y: w.b.y - ny },
        { x: w.a.x - nx, y: w.a.y - ny },
      ]);
    }
    if (sitePlan.path) keepOut.push(sitePlan.path);
    if (sitePlan.step) keepOut.push(sitePlan.step);
    // Gravel along the foundation, a slab path, a fence round the lot, and the land rolling away beyond it.
    const look = styleById(styleId);
    const grounds = buildGrounds(sitePlan, {
      gravel: mixHex('#a59e92', look.ground, 0.15),
      stone: mixHex('#cfc9bd', look.ground, 0.2),
      fence: mixHex('#8d7a64', look.trim, 0.12),
    });
    keepOut.push(...grounds.gravel);
    const lawn = buildLawn({
      height: grounds.height,
      x,
      z,
      radius,
      color: lawnColor(styleById(styleId).ground),
      keepOut,
      gap: half + 0.04,
      margin: half + 0.6,
    });
    const planting = buildPlanting(sitePlan, { x, y: z });
    if (planting) lawn.add(planting);
    if (grounds.mesh) lawn.add(grounds.mesh);
    return lawn;
  }, [styled, sitePlan, plan.bounds, styleId, rooms, walls, settings.wallThickness]);
  useEffect(() => () => disposeGarden(garden), [garden]);
  useLayoutEffect(() => {
    // The lawn replaces the plot's flat tone.
    site.group.traverse((o) => {
      // …and the slab path replaces the flat one.
      if (o.name === 'lot' || o.name === 'lot-edge' || o.name === 'path') o.visible = !styled;
    });
  }, [site, styled]);
  useLayoutEffect(() => {
    site.setGround(ground);
    // Tinted in place, behind React's back: the view renders on demand, so ask for the frame.
    invalidate();
  }, [site, ground, invalidate]);
  return (
    <>
      <primitive key={site.group.uuid} object={site.group} />
      {garden && <primitive key={garden.uuid} object={garden} />}
    </>
  );
}

// ---------- light ----------

/** How strongly the photographed sky lights the model, and which way a positive turn rotates it. */
const SKY_LIGHT = 0.85;
const SKY_TURN_SIGN = -1;
/** How much darker the picture is with the sun on the horizon (exposure 1 − this). */
const DUSK_EXPOSURE_DROP = 0.35;
/** How far the haze leans from the horizon colour toward the sky overhead. */
const HAZE_TOWARD_ZENITH = 0.15;

/** The orbit controls' pivot, if they are mounted. */
function orbitTarget(controls: unknown): THREE.Vector3 | null {
  const t = (controls as { target?: unknown } | null)?.target;
  return t instanceof THREE.Vector3 ? t : null;
}

/**
 * Haze measured from the house, not the camera: it starts a little past the house however far
 * away the camera stands, and thickens over the land beyond. Only uniforms change, never shaders.
 */
function fitFog(fog: THREE.Fog, camera: THREE.Camera, target: THREE.Vector3 | null, radius: number): void {
  const r = Math.max(radius, 6);
  const dist = target ? camera.position.distanceTo(target) : r * 3;
  fog.near = dist + r * 1.5;
  fog.far = fog.near + r * 14;
}

function Lights({ bounds }: { bounds: Bounds }) {
  const sunHour = useViewStore((s) => s.sunHour);
  const styleId = usePlanStore((s) => s.look?.style);
  const style = styleById(styleId);
  const sun = useMemo(() => sunState(sunHour, style), [sunHour, style]);
  const target = useMemo(() => new THREE.Object3D(), []);
  const { x, z, radius } = bounds;
  const reach = radius * LAMP_DISTANCE;
  const span = radius * 2.2;

  // Styled looks are lit by a photographed sky; the maquette keeps its studio lamp.
  const view = useViewStore((s) => s.view);
  const getThree = useThree((s) => s.get);
  const [, setSkyVersion] = useState(0);
  useEffect(() => onSkyLoad(() => setSkyVersion((v) => v + 1)), []);
  const sky = style.id === 'maquette' ? null : skyFor(skyIdFor(sunHour));
  const showSky = sky !== null && view !== 'dollhouse';
  const sunAzimuth = Math.atan2(sun.dir[2], sun.dir[0]);
  // How light becomes screen colour. Styled looks use a neutral curve, so a wall is the colour its
  // style chose and highlights roll off softly; the maquette keeps the filmic curve that bleaches
  // it to paper white.
  useLayoutEffect(() => {
    const { gl, invalidate } = getThree();
    gl.toneMapping = style.id === 'maquette' ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
    invalidate();
  }, [getThree, style.id]);
  useLayoutEffect(() => {
    if (!sky) return;
    const { scene, invalidate } = getThree();
    // Turn the panorama so its bright side sits where our sun is.
    const turn = SKY_TURN_SIGN * (sunAzimuth - sky.sunAzimuth);
    scene.environment = sky.texture;
    scene.environmentRotation.set(0, turn, 0);
    // As the sun gets low the sky gives less light, so lamps and the low sun carry the evening.
    const dim = 1 - 0.72 * Math.pow(Math.abs(sunPhase(sunHour)), 2.2);
    scene.environmentIntensity = SKY_LIGHT * style.ambient * dim * skyGain(sunHour);
    if (showSky) {
      // Behind the house: a drawn sky, calm in every direction. The photograph only lights.
      scene.background = backdropFor(sunHour);
      scene.backgroundRotation.set(0, 0, 0);
      scene.backgroundIntensity = 1;
    }
    invalidate();
    return () => {
      scene.environment = null;
      scene.environmentIntensity = 1;
      if (showSky) scene.background = null;
      invalidate();
    };
  }, [getThree, sky, showSky, sunAzimuth, style.ambient, sunHour]);

  // Evening: the whole picture settles a little darker, so the lit windows and the low sun carry it.
  // Gentle on purpose: the house must stay readable. (The path tracer scales from whatever this is.)
  const styled = style.id !== 'maquette';
  const exposure = styled ? 1 - DUSK_EXPOSURE_DROP * Math.pow(Math.abs(sunPhase(sunHour)), 2) : 1;
  useLayoutEffect(() => {
    const { gl, invalidate } = getThree();
    const before = gl.toneMappingExposure;
    gl.toneMappingExposure = exposure;
    invalidate();
    return () => {
      gl.toneMappingExposure = before;
      invalidate();
    };
  }, [getThree, exposure]);

  // Haze: the far lawn fades into the sky's own horizon colour, so the ground never ends at a hard line.
  // One Fog for the life of the view: materials compile against the fog object itself, so swapping it
  // while the sun slider moves would rebuild every shader. Only its numbers change (here and as the camera moves).
  const fog = useMemo(() => new THREE.Fog('#ffffff', 1, 2), []);
  useLayoutEffect(() => {
    if (!styled) return;
    const { scene, invalidate } = getThree();
    scene.fog = fog;
    invalidate();
    return () => {
      if (scene.fog === fog) scene.fog = null;
      invalidate();
    };
  }, [getThree, styled, fog]);
  const hazeColor = showSky ? horizonFor(sunHour) : sun.background;
  // Toward the sky overhead, a touch cooler and darker than the horizon: distance, not a fog wall.
  // (Over the dollhouse's flat backdrop the haze must match it exactly.)
  const hazeTop = showSky ? zenithFor(sunHour) : null;
  useLayoutEffect(() => {
    const { camera, controls, invalidate } = getThree();
    fog.color.set(hazeColor);
    if (hazeTop) fog.color.lerp(new THREE.Color(hazeTop), HAZE_TOWARD_ZENITH);
    fitFog(fog, camera, orbitTarget(controls), radius);
    invalidate();
  }, [getThree, fog, hazeColor, hazeTop, radius]);

  const roomLight = sky !== null && view === 'dollhouse';

  return (
    <>
      {!showSky && <color attach="background" args={[sun.background]} />}
      {/* warm key light + soft sky fill: at noon, the maquette under its studio lamp */}
      {/* Light thrown back up off the ground: green off a lawn, onto the lower walls and eaves. */}
      {/* Under a photographed sky it only adds the lawn's bounce (the sky does the shade). Looking down
          into the rooms it is a warm room light instead, so white plaster reads warm, not slate. */}
      <hemisphereLight
        color={roomLight ? mixHex(sun.hemiSky, '#fff3e2', 0.8) : sun.hemiSky}
        groundColor={roomLight ? mixHex(style.floors.living.color, '#efe6d8', 0.6) : styled ? lawnColor(style.ground) : sun.hemiGround}
        intensity={sky ? sun.hemiIntensity * (roomLight ? 0.5 : 0.17) : sun.hemiIntensity}
      />
      <primitive object={target} position={[x, 0, z]} />
      <directionalLight
        position={[x + sun.dir[0] * reach, sun.dir[1] * reach, z + sun.dir[2] * reach]}
        target={target}
        intensity={sun.keyIntensity}
        color={sun.keyColor}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={2.5}
      >
        <orthographicCamera attach="shadow-camera" args={[-span, span, span, -span, 0.5, radius * 8]} />
      </directionalLight>
      {/* The maquette's studio fill. The styled looks have none: a shadowless light from a fixed side lit
          every wall facing the camera as if in sun, and the house lost its shape. */}
      {!styled && (
        <directionalLight
          position={[x - radius * 1.6, radius * 1.2, z + radius * 1.8]}
          intensity={sun.fillIntensity}
        />
      )}
      {style.id === 'maquette' && (
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, -0.002, z]} receiveShadow>
        <circleGeometry args={[Math.max(radius * 5, 24), 64]} />
        {/* Furthest back of the ground layers (see site.ts): the lot, path and floors always draw over it. */}
        <meshStandardMaterial color={sun.ground} roughness={1} polygonOffset polygonOffsetFactor={4} polygonOffsetUnits={4} />
      </mesh>
      )}
    </>
  );
}

// ---------- orbit camera ----------

/** True while `o` hangs somewhere under `scene`. */
function inScene(o: THREE.Object3D, scene: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === scene) return true;
  return false;
}

interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** The planting mesh, which lists its tree crowns and shrubs as spheres (userData.spheres). */
function findPlanting(scene: THREE.Object3D): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (!found && o.name === 'planting' && Array.isArray(o.userData.spheres)) found = o;
  });
  return found;
}

/** Room left between the camera and a crown or a shrub, in metres. */
const PLANT_CLEARANCE = 0.5;
const plantCentre = new THREE.Vector3();
const plantScale = new THREE.Vector3();

/** Push `eye` out of any crown or shrub of `planting`. True if it moved. */
function pushOutOfPlanting(eye: THREE.Vector3, planting: THREE.Object3D): boolean {
  const spheres = planting.userData.spheres as unknown;
  if (!Array.isArray(spheres)) return false;
  planting.updateWorldMatrix(true, false);
  plantScale.setFromMatrixScale(planting.matrixWorld);
  const scale = Math.max(plantScale.x, plantScale.y, plantScale.z);
  let moved = false;
  for (const s of spheres as Sphere[]) {
    if (!s || !Number.isFinite(s.x + s.y + s.z + s.r)) continue;
    plantCentre.set(s.x, s.y, s.z).applyMatrix4(planting.matrixWorld);
    const reach = s.r * scale + PLANT_CLEARANCE;
    const d = eye.distanceTo(plantCentre);
    if (d >= reach) continue;
    if (d < 1e-4) eye.y += reach;
    else eye.sub(plantCentre).multiplyScalar(reach / d).add(plantCentre);
    moved = true;
  }
  return moved;
}

function CameraRig({ bounds, start }: { bounds: Bounds; start: CameraPose }) {
  const get = useThree((s) => s.get);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const walking = useViewStore((s) => s.walking);
  const fitNonce = useUiStore((s) => s.fitNonce);
  const resetNonce = useViewStore((s) => s.resetNonce);

  const boundsRef = useRef(bounds);
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  // Remember where the camera is, so Plan ↔ Model comes back to the same view.
  const savePose = useCallback(
    (controls: OrbitLike | null = controlsRef.current) => {
      if (!controls || useViewStore.getState().walking) return;
      const { camera } = get();
      // Leaving the model mid-walk: the store already says "not walking", but the walker has not
      // handed the camera back yet (it does so after this). Its eye position is not an orbit pose.
      if ((camera as THREE.PerspectiveCamera).fov === WALK_FOV) return;
      useViewStore.getState().setPose({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
        fitNonce: useUiStore.getState().fitNonce,
      });
    },
    [get],
  );

  useLayoutEffect(() => {
    const controls = controlsRef.current;
    get().camera.position.set(...start.position);
    if (controls) {
      controls.target.set(...start.target);
      controls.update();
    } else {
      get().camera.lookAt(...start.target);
    }
    return () => savePose(controls);
    // Mount and unmount only: the pose is a starting point, not a binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit when the plan is replaced, or when asked to.
  const seen = useRef({ fitNonce, resetNonce });
  useEffect(() => {
    if (seen.current.fitNonce === fitNonce && seen.current.resetNonce === resetNonce) return;
    seen.current = { fitNonce, resetNonce };
    const pose = defaultPose(boundsRef.current, fitNonce);
    const view = useViewStore.getState();
    view.setPose(pose);
    const wasWalking = view.walking;
    if (view.view === 'walk') view.stepOut();
    // A walker restores the orbit camera from the stored pose as it leaves.
    if (wasWalking) return;
    const { camera } = get();
    camera.position.set(...pose.position);
    controlsRef.current?.target.set(...pose.target);
    controlsRef.current?.update();
  }, [fitNonce, resetNonce, get]);

  // A new lens: the same picture of the house, the camera stepping back or in to keep it the same size.
  // Only on an actual change of lens: the canvas already starts with the lens's own field of view, and a
  // restored pose was taken with it, so mounting must not rescale (it used to creep on every Plan ↔ Model).
  const lens = useViewStore((s) => s.lens);
  const shownLens = useRef(lens);
  useEffect(() => {
    if (shownLens.current === lens) return;
    shownLens.current = lens;
    const { camera, invalidate } = get();
    const cam = camera as THREE.PerspectiveCamera;
    // A walker puts the lens on as it hands the camera back.
    if (useViewStore.getState().walking) return;
    const fov = LENS_FOV[lens];
    if (Math.abs(cam.fov - fov) < 1e-6) return;
    const controls = controlsRef.current;
    if (controls) {
      const k = Math.tan(((cam.fov / 2) * Math.PI) / 180) / Math.tan(((fov / 2) * Math.PI) / 180);
      cam.position.sub(controls.target).multiplyScalar(k).add(controls.target);
    }
    cam.fov = fov;
    cam.updateProjectionMatrix();
    controls?.update();
    savePose();
    invalidate();
  }, [lens, get, savePose]);

  // Ready-made shots: aim the camera, then it is the user's to move again.
  const shotNonce = useViewStore((s) => s.shotNonce);
  const seenShot = useRef(shotNonce);
  useEffect(() => {
    if (seenShot.current === shotNonce) return;
    seenShot.current = shotNonce;
    const { shot, front } = useViewStore.getState();
    const b = boundsRef.current;
    const [fx, fz] = front;
    // To the right of someone leaving by the front door.
    const [sx, sz] = [-fz, fx];
    const r = b.radius;
    // Further back with a long lens, closer with a wide one, so each shot frames the house the same.
    const k = lensReach(useViewStore.getState().lens);
    let position: [number, number, number];
    let target: [number, number, number] = [b.x, 1.1, b.z];
    if (shot === 'street') position = [b.x + (fx * 2.6 + sx * 0.5) * r * k, 1.65, b.z + (fz * 2.6 + sz * 0.5) * r * k];
    else if (shot === 'corner') {
      position = [b.x + (fx * 2.5 + sx * 2.2) * r * k, 1.1 + (r * 0.8 + 1.4) * k, b.z + (fz * 2.5 + sz * 2.2) * r * k];
    } else if (shot === 'top') {
      position = [b.x, r * 3.4 * k, b.z + 0.01];
      target = [b.x, 0, b.z];
    } else {
      const pose = defaultPose(b, useUiStore.getState().fitNonce);
      position = pose.position;
      target = pose.target;
    }
    const { camera, invalidate } = get();
    camera.position.set(...position);
    controlsRef.current?.target.set(...target);
    controlsRef.current?.update();
    savePose();
    invalidate();
  }, [shotNonce, get, savePose]);

  // As the camera moves: keep it out of the trees and shrubs, and move the haze with it.
  const plantingCache = useRef<{ mesh: THREE.Object3D | null; searched: number }>({ mesh: null, searched: -Infinity });
  const onChange = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls || useViewStore.getState().walking) return;
    const { camera, scene } = get();
    const cache = plantingCache.current;
    if (!cache.mesh || !inScene(cache.mesh, scene)) {
      cache.mesh = null;
      // A scene without planting (the maquette) is not searched on every frame of a drag.
      const now = performance.now();
      if (now - cache.searched > 1000) {
        cache.searched = now;
        cache.mesh = findPlanting(scene);
      }
    }
    if (cache.mesh && pushOutOfPlanting(camera.position, cache.mesh)) camera.lookAt(controls.target);
    if (scene.fog instanceof THREE.Fog) fitFog(scene.fog, camera, controls.target, boundsRef.current.radius);
  }, [get]);

  // The haze starts where the camera already is, before anything moves it.
  useEffect(() => {
    onChange();
    get().invalidate();
  }, [onChange, get]);

  // Zoom toward whatever is under the pointer, as if grabbing it. Not while verticals are straightened:
  // the picture is shifted for drawing only, so the controls would aim at a different spot than the one shown.
  const view = useViewStore((s) => s.view);
  const straight = useViewStore((s) => s.straight);

  return (
    <OrbitControls
      ref={controlsRef}
      enabled={!walking}
      maxPolarAngle={Math.PI / 2 - 0.04}
      minDistance={1.5}
      maxDistance={bounds.radius * 16}
      onEnd={() => savePose()}
      onChange={onChange}
      zoomToCursor={!(view === 'exterior' && straight)}
      makeDefault
    />
  );
}

// ---------- walking ----------

const MOVE_KEYS: Record<string, [number, number]> = {
  w: [1, 0],
  arrowup: [1, 0],
  s: [-1, 0],
  arrowdown: [-1, 0],
  a: [0, -1],
  arrowleft: [0, -1],
  d: [0, 1],
  arrowright: [0, 1],
};

/** When the pointer lock was last released by the browser (its own Esc handling). */
let lockReleasedAt = -Infinity;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** Ask for the pointer; a refusal is fine (dragging looks around instead). */
function lockPointer(el: HTMLElement): void {
  try {
    void Promise.resolve(el.requestPointerLock?.()).catch(() => {});
  } catch {
    // older browsers throw instead of rejecting
  }
}

function Walker({ world: walkWorld }: { world: WalkWorld }) {
  const get = useThree((s) => s.get);
  const view = useViewStore((s) => s.view);
  const walking = useViewStore((s) => s.walking);

  const me = useRef({ x: 0, z: 0, yaw: 0, pitch: 0, keys: new Set<string>() });
  // Dev-only: where the walker stands and looks, for the demo recorder to steer a smooth walk.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __walker?: unknown }).__walker = me.current;
  }, []);
  const world = useRef(walkWorld);
  useEffect(() => {
    world.current = walkWorld;
  }, [walkWorld]);

  // Choosing where: a click (not a drag) on the ground steps in.
  useEffect(() => {
    if (view !== 'walk') return;
    const el = get().gl.domElement;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onClick = (e: MouseEvent) => {
      const from = down;
      down = null;
      if (!from || Math.hypot(e.clientX - from.x, e.clientY - from.y) > 5) return;
      if (useViewStore.getState().walking) {
        // Already inside: a click takes the pointer back if it was let go.
        if (document.pointerLockElement !== el) lockPointer(el);
        return;
      }
      const { camera, controls } = get();
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (!hit || hit.distanceTo(camera.position) > 400) return;

      // Remember the orbit camera to come back to.
      const orbit = controls as unknown as OrbitLike | null;
      if (orbit) {
        useViewStore.getState().setPose({
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [orbit.target.x, orbit.target.y, orbit.target.z],
          fitNonce: useUiStore.getState().fitNonce,
        });
      }
      const start = settleWalker({ x: hit.x, y: hit.z }, world.current);
      const dir = camera.getWorldDirection(new THREE.Vector3());
      me.current.x = start.x;
      me.current.z = start.y;
      me.current.yaw = Math.atan2(-dir.x, -dir.z);
      me.current.pitch = 0;
      me.current.keys.clear();
      useViewStore.getState().setWalking(true);
      lockPointer(el);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('click', onClick);
    };
  }, [view, get]);

  // Inside: look with the mouse, move with the keys.
  useEffect(() => {
    if (!walking) return;
    const { gl } = get();
    const el = gl.domElement;
    const cam = get().camera as THREE.PerspectiveCamera;
    const state = me.current;
    cam.fov = WALK_FOV;
    cam.updateProjectionMatrix();
    let wasLocked = document.pointerLockElement === el;

    const onLock = () => {
      const locked = document.pointerLockElement === el;
      if (wasLocked && !locked) {
        lockReleasedAt = performance.now();
        useViewStore.getState().stepOut();
      }
      wasLocked = locked;
    };
    const onMove = (e: MouseEvent) => {
      const locked = document.pointerLockElement === el;
      // Without the lock (refused, or unsupported) a drag looks around instead.
      if (!locked && !((e.buttons & 1) === 1 && e.target === el)) return;
      state.yaw -= e.movementX * 0.0023;
      state.pitch = Math.max(-1.35, Math.min(1.35, state.pitch - e.movementY * 0.0023));
    };
    const onKey = (e: KeyboardEvent) => {
      const move = MOVE_KEYS[e.key.toLowerCase()];
      if (!move) return;
      if (e.type === 'keyup') {
        state.keys.delete(e.key.toLowerCase());
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (useUiStore.getState().commandOpen || useUiStore.getState().shortcutsOpen || useKeyStore.getState().asking) return;
      state.keys.add(e.key.toLowerCase());
      e.preventDefault();
      e.stopPropagation();
    };
    const onBlur = () => state.keys.clear();

    document.addEventListener('pointerlockchange', onLock);
    document.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    // The view renders on demand: start the walk's frames (each one asks for the next, below).
    get().invalidate();
    return () => {
      document.removeEventListener('pointerlockchange', onLock);
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      state.keys.clear();
      if (document.pointerLockElement === el) document.exitPointerLock();
      // Back to the orbit camera we left.
      cam.fov = LENS_FOV[useViewStore.getState().lens];
      cam.updateProjectionMatrix();
      const pose = useViewStore.getState().pose;
      const orbit = get().controls as unknown as OrbitLike | null;
      if (pose) {
        cam.position.set(...pose.position);
        if (orbit) {
          orbit.target.set(...pose.target);
          orbit.update();
        } else {
          cam.lookAt(...pose.target);
        }
      }
      get().invalidate();
    };
  }, [walking, get]);

  useFrame((three, dt) => {
    if (!useViewStore.getState().walking) return;
    const state = me.current;
    let forward = 0;
    let strafe = 0;
    for (const k of state.keys) {
      const m = MOVE_KEYS[k];
      if (m) {
        forward += m[0];
        strafe += m[1];
      }
    }
    if (forward !== 0 || strafe !== 0) {
      const step = walkDelta(forward, strafe, state.yaw, WALK_SPEED * Math.min(dt, 0.05));
      const next = stepWalker({ x: state.x, y: state.z }, step, world.current);
      state.x = next.x;
      state.z = next.y;
    }
    three.camera.position.set(state.x, EYE_HEIGHT, state.z);
    three.camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
    // Keys and the mouse steer between frames, so a walk draws every frame until it ends.
    three.invalidate();
  });

  return null;
}

// ---------- snapshot, dev handles ----------

/** Set while a canvas is mounted; the bar and the S key call it. */
let snapshotNow: (() => void) | null = null;

function takeSnapshot(): void {
  if (snapshotNow) snapshotNow();
}

function SceneBridge() {
  const get = useThree((s) => s.get);
  const controls = useThree((s) => s.controls);

  // Photographed materials arrive after the first frame; the view draws on demand, so ask again.
  useEffect(() => onTextureLoad(() => get().invalidate()), [get]);

  useEffect(() => {
    const snap = () => {
      try {
        const { gl, scene, camera } = get();
        const name = `${fileSlug(usePlanStore.getState().name)}.png`;
        downloadBlob(capturePng(gl, scene, camera, 2, livePost.draw ?? undefined), name, 'image/png');
        toast(`Saved ${name}`);
      } catch {
        toastError("Couldn't save the picture.");
      }
    };
    snapshotNow = snap;
    return () => {
      if (snapshotNow === snap) snapshotNow = null;
    };
  }, [get]);

  // Rendering on demand: a graphics context the browser took away and gave back needs its picture redrawn.
  useEffect(() => {
    const { gl, invalidate } = get();
    const redraw = () => invalidate();
    gl.domElement.addEventListener('webglcontextrestored', redraw);
    return () => gl.domElement.removeEventListener('webglcontextrestored', redraw);
  }, [get]);

  // Dev-only: camera, renderer and controls for the demo recorder and tests.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const { camera, gl, scene, invalidate } = get();
    window.__three = {
      camera: camera as THREE.PerspectiveCamera,
      controls: controls as unknown as SceneHandles['controls'],
      gl,
      scene,
      invalidate: () => invalidate(),
    };
  }, [get, controls]);
  return null;
}

if (import.meta.env.DEV) {
  window.__gaudi = {
    ...(window.__gaudi ?? {}),
    scene: {
      view: useViewStore,
      styles: STYLES,
      setStyle: chooseStyle,
      setRoof: chooseRoof,
      snapshot: takeSnapshot,
      /** Names of everything in the live scene graph (walls, floors, roof, furniture…). */
      nodes: (): string[] => {
        const names: string[] = [];
        window.__three?.scene.traverse((o) => {
          if (o.name) names.push(o.name);
        });
        return names;
      },
      /** PNG bytes of the current view at `scale`× — the same path the Snapshot button takes. */
      capture: (scale = 2): Uint8Array | null => {
        const t = window.__three;
        return t ? capturePng(t.gl, t.scene, t.camera, scale, livePost.draw ?? undefined) : null;
      },
    },
    roofs: {
      /**
       * What the roof builder makes of the plan in the store: the footprint it
       * found, which rooms are open to the sky, and the roof for `kind`
       * (default: the one on screen). Plain data — safe to JSON.stringify.
       */
      describe: (kind?: RoofKind) => {
        const s = usePlanStore.getState();
        const { walls, settings } = sanitizeForScene(s.walls, s.settings);
        const rooms = detectRooms(walls);
        const open = openAirRooms(rooms, s.roomNames);
        const view = useViewStore.getState();
        const shown = effectiveRoof(s.look?.roof ?? 'none', styleById(s.look?.style), view.view === 'exterior');
        const roof = buildRoof(kind ?? shown, { rooms, walls, settings, open });
        return {
          look: { ...s.look },
          view: view.view,
          shownRoof: shown,
          rooms: rooms.length,
          openAir: rooms.filter((r) => open.has(r.key)).map((r) => s.roomNames[r.key] ?? '(unnamed)'),
          roof: {
            kind: roof.kind,
            top: roof.top,
            eave: roof.eave,
            slope: roof.slope,
            slabs: roof.slabs.map((slab) => ({ part: slab.part, corners: slab.poly.length, holes: slab.holes?.length ?? 0 })),
            triangles: roof.solids.reduce((n, solid) => n + solid.positions.length / 9, 0),
            ridges: roof.ridges,
            outline: roof.outline,
          },
        };
      },
      /** Lot, entrance, doorstep and path as planned for the current plan. */
      site: () => {
        const s = usePlanStore.getState();
        const { walls, settings } = sanitizeForScene(s.walls, s.settings);
        const rooms = detectRooms(walls);
        const model = buildWallModel(walls, s.openings, settings, rooms);
        return planSite({ rooms, walls, openings: model.openings, wallThickness: settings.wallThickness });
      },
      setView: (view: 'dollhouse' | 'exterior' | 'walk') => useViewStore.getState().setView(view),
      setStyle: chooseStyle,
      setRoof: chooseRoof,
    },
  } as Window['__gaudi'];
}

// ---------- error boundary ----------

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (import.meta.env.DEV) console.error('[scene]', error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="scene-error">
        <span>Couldn’t build the model.</span>
        <div className="row">
          <button className="btn small" onClick={() => this.setState({ failed: false })}>
            Try again
          </button>
          <button className="btn small" onClick={() => useUiStore.getState().setMode('plan')}>
            Back to plan
          </button>
        </div>
      </div>
    );
  }
}

// ---------- the view ----------

/** The plan as the scene needs it, and where the camera starts. */
function useSceneInputs(): { plan: ScenePlan; start: CameraPose; world: WalkWorld } {
  const plan = useScenePlan();
  const openings = usePlanStore((s) => s.openings);
  const furniture = usePlanStore((s) => s.furniture);
  const customItems = usePlanStore((s) => s.customItems);
  // Where it was left, unless the plan has been replaced since.
  const [start] = useState<CameraPose>(() => {
    const fitNonce = useUiStore.getState().fitNonce;
    const saved = useViewStore.getState().pose;
    return saved && saved.fitNonce === fitNonce ? saved : defaultPose(plan.bounds, fitNonce);
  });
  const blockers = useMemo(
    () => wallBlockers(plan.walls, openings, plan.settings),
    [plan.walls, openings, plan.settings],
  );
  // What a walker goes round: anything standing on the floor that is more than a step high.
  const obstacles = useMemo(() => {
    void customItems; // furnitureDef reads a mirror of these
    return furnitureObstacles(Array.isArray(furniture) ? furniture : [], (kind) => {
      const def = furnitureDef(kind);
      if (!def || !Array.isArray(def.parts) || def.parts.length === 0) return null;
      const b = partsBounds(def.parts);
      return { w: def.w, d: def.d, bottom: b.minY, top: b.maxY };
    });
  }, [furniture, customItems]);
  const world = useMemo<WalkWorld>(
    () => ({
      blockers,
      // Kept under a narrow doorway's half width, however thick the walls.
      radius: Math.min(BODY_RADIUS + plan.settings.wallThickness / 2, 0.34),
      obstacles,
    }),
    [blockers, plan.settings.wallThickness, obstacles],
  );
  return { plan, start, world };
}

/** Everything inside the canvas. */
export function SceneContents() {
  const { plan, start, world } = useSceneInputs();
  const rendering = useRenderStore((s) => s.phase !== 'off');
  return (
    <>
      {rendering ? <PathTrace /> : <LivePost />}
      <SceneBridge />
      <Lights bounds={plan.bounds} />
      <Site plan={plan} />
      <House plan={plan} />
      <CameraRig bounds={plan.bounds} start={start} />
      <Walker world={world} />
    </>
  );
}

export function Scene3D() {
  const view = useViewStore((s) => s.view);
  const walking = useViewStore((s) => s.walking);
  const rendering = useRenderStore((s) => s.phase !== 'off');

  // Leaving the model ends a render.
  useEffect(() => () => useRenderStore.getState().stop(), []);

  // Keys for the model view. Capture phase, so Esc can step out of a walk
  // without also dropping back to the plan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const ui = useUiStore.getState();
      if (ui.mode !== 'model' || ui.commandOpen || ui.shortcutsOpen || useKeyStore.getState().asking) return;
      const scene = useViewStore.getState();
      const render = useRenderStore.getState();
      if (render.phase !== 'off') {
        // While rendering the view is frozen: Esc ends it, everything else waits.
        if (e.key === 'Escape') render.stop();
        if (e.key.length === 1 || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (scene.view === 'walk') {
          e.stopPropagation();
          scene.stepOut();
        } else if (performance.now() - lockReleasedAt < 350) {
          // The same press that released the pointer: it has done its job.
          e.stopPropagation();
        }
        return;
      }
      if (scene.walking) {
        // Letters move the walker; keep stray ones from opening panels behind it.
        if (e.key.length === 1 && !'bB?'.includes(e.key)) e.stopPropagation();
        return;
      }
      // A held key repeats: one press is one snapshot, one reset.
      if (e.repeat) return;
      switch (e.key) {
        case '1':
          scene.setView('dollhouse');
          break;
        case '2':
          scene.setView('exterior');
          break;
        case '3':
          scene.setView('walk');
          break;
        case 's':
        case 'S':
          takeSnapshot();
          break;
        case 'r':
        case 'R':
          render.start();
          break;
        case '0':
          scene.resetView();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Leaving the model ends a walk.
  useEffect(() => () => useViewStore.getState().stepOut(), []);

  // The camera starts with the chosen lens, so a restored pose looks as it did. Made once: a new
  // object here would have the canvas re-apply it to the camera on later renders (over a walker's lens).
  const [cameraOptions] = useState(() => ({ fov: LENS_FOV[useViewStore.getState().lens] }));

  return (
    <div className={`scene-3d ${walking ? 'walking' : ''}`}>
      <SceneBoundary>
        {/* Drawn when something changes, not 60 times a second: see the invalidate() calls above. */}
        <Canvas
          frameloop="demand"
          shadows="percentage"
          camera={cameraOptions}
        >
          <SceneContents />
        </Canvas>
      </SceneBoundary>
      {view === 'walk' && (
        <div className="scene-hint" role="status">
          {walking ? (
            <>
              <span className="kbd">W</span>
              <span className="kbd">A</span>
              <span className="kbd">S</span>
              <span className="kbd">D</span> to move · mouse to look · <span className="kbd">Esc</span> to step out
            </>
          ) : (
            <>Click the floor to step in</>
          )}
        </div>
      )}
      {!rendering && <SceneBar onSnapshot={takeSnapshot} />}
      <RenderOverlay />
    </div>
  );
}
