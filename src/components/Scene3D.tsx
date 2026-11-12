import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
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
import type { PlanSettings, RoofKind, Wall } from '../types';
import {
  buildCeilings,
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
import { effectiveRoof, STYLES, styleById } from '../three/styles';
import { LAMP_DISTANCE, sunState } from '../three/sun';
import { useViewStore } from '../three/viewStore';
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

const ORBIT_FOV = 42;
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

/** The camera that looks down into the house from the south-east. */
function defaultPose(b: Bounds, fitNonce: number): CameraPose {
  return {
    position: [b.x + b.radius * 1.4, b.radius * 2.3, b.z + b.radius * 1.8],
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
  const openingsGroup = useMemo(() => buildOpenings(model.openings, kit), [model, kit]);
  const floorsGroup = useMemo(() => buildFloors(rooms, roomNames ?? {}, kit, open), [rooms, roomNames, kit, open]);
  const furnitureGroup = useMemo(() => {
    // furnitureDef reads a mirror of customItems, so a changed definition must rebuild.
    void customItems;
    return buildFurniture(Array.isArray(furniture) ? furniture : [], kit);
  }, [furniture, customItems, kit]);

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

  useDisposal(wallsGroup);
  useDisposal(openingsGroup);
  useDisposal(floorsGroup);
  useDisposal(furnitureGroup);
  useDisposal(roofGroup);
  useDisposal(ceilingsGroup);

  return (
    <>
      <primitive object={wallsGroup} />
      <primitive object={openingsGroup} />
      <primitive object={floorsGroup} />
      <primitive object={furnitureGroup} />
      {roofGroup && <primitive object={roofGroup} />}
      {ceilingsGroup && <primitive object={ceilingsGroup} />}
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
  const site = useMemo(() => {
    try {
      return buildSite(planSite({ rooms, walls, openings: model.openings, wallThickness: settings.wallThickness }));
    } catch {
      return buildSite(null);
    }
  }, [rooms, walls, model, settings.wallThickness]);
  useEffect(() => () => site.dispose(), [site]);
  useLayoutEffect(() => {
    site.setGround(ground);
    // Tinted in place, behind React's back: the view renders on demand, so ask for the frame.
    invalidate();
  }, [site, ground, invalidate]);
  return <primitive object={site.group} />;
}

// ---------- light ----------

function Lights({ bounds }: { bounds: Bounds }) {
  const sunHour = useViewStore((s) => s.sunHour);
  const styleId = usePlanStore((s) => s.look?.style);
  const style = styleById(styleId);
  const sun = useMemo(() => sunState(sunHour, style), [sunHour, style]);
  const target = useMemo(() => new THREE.Object3D(), []);
  const { x, z, radius } = bounds;
  const reach = radius * LAMP_DISTANCE;
  const span = radius * 2.2;

  return (
    <>
      <color attach="background" args={[sun.background]} />
      {/* warm key light + soft sky fill: at noon, the maquette under its studio lamp */}
      <hemisphereLight color={sun.hemiSky} groundColor={sun.hemiGround} intensity={sun.hemiIntensity} />
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
      <directionalLight
        position={[x - radius * 1.6, radius * 1.2, z + radius * 1.8]}
        intensity={sun.fillIntensity}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, -0.002, z]} receiveShadow>
        <circleGeometry args={[Math.max(radius * 5, 24), 64]} />
        <meshStandardMaterial color={sun.ground} roughness={1} />
      </mesh>
    </>
  );
}

// ---------- orbit camera ----------

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
      if ((camera as THREE.PerspectiveCamera).fov !== ORBIT_FOV) return;
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

  return (
    <OrbitControls
      ref={controlsRef}
      enabled={!walking}
      maxPolarAngle={Math.PI / 2 - 0.04}
      minDistance={1.5}
      maxDistance={bounds.radius * 10}
      onEnd={() => savePose()}
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
      cam.fov = ORBIT_FOV;
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

  useEffect(() => {
    const snap = () => {
      try {
        const { gl, scene, camera } = get();
        const name = `${fileSlug(usePlanStore.getState().name)}.png`;
        downloadBlob(capturePng(gl, scene, camera, 2), name, 'image/png');
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
        return t ? capturePng(t.gl, t.scene, t.camera, scale) : null;
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
  return (
    <>
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

  // Keys for the model view. Capture phase, so Esc can step out of a walk
  // without also dropping back to the plan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const ui = useUiStore.getState();
      if (ui.mode !== 'model' || ui.commandOpen || ui.shortcutsOpen || useKeyStore.getState().asking) return;
      const scene = useViewStore.getState();
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

  return (
    <div className={`scene-3d ${walking ? 'walking' : ''}`}>
      <SceneBoundary>
        {/* Drawn when something changes, not 60 times a second: see the invalidate() calls above. */}
        <Canvas frameloop="demand" shadows="percentage" camera={{ fov: ORBIT_FOV }}>
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
      <SceneBar onSnapshot={takeSnapshot} />
    </div>
  );
}
