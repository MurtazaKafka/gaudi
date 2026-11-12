/**
 * Small live turntables for the palette's own items. One WebGL canvas lies
 * over the palette's list; every row marks where its model goes with an
 * element carrying `data-tt="{item id}"`, and each frame the one scene is drawn
 * once per visible mark, scissored to it. Any number of rows costs a single
 * context. Loaded lazily, so three.js stays out of the first paint.
 *
 * Frames are drawn on demand: while a model is in view (and motion is welcome)
 * each frame asks for the next, so it turns; with none in view, or with motion
 * reduced, the canvas does nothing until something could have moved a row.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { Group, PerspectiveCamera } from 'three';
import type { FurnitureDef } from '../catalog';
import { partsBounds } from '../customItems';
import { ItemModel } from '../three/PartMesh';

const FOV = 26;
const ELEVATION = 0.42; // radians above the horizon
const SPEED = 0.45; // radians per second

export interface TurntableItem {
  id: string;
  def: FurnitureDef;
}

interface Framing {
  centerY: number;
  dist: number;
}

/** Where the camera stands so the whole model fits, whatever its proportions. */
function framingOf(def: FurnitureDef): Framing {
  const b = partsBounds(def.parts);
  const w = Math.max(b.maxX - b.minX, def.w);
  const d = Math.max(b.maxZ - b.minZ, def.d);
  const h = Math.max(b.maxY - b.minY, 0.01);
  const radius = Math.max(0.05, Math.hypot(w, d, h) / 2);
  return { centerY: (b.minY + b.maxY) / 2, dist: (radius / Math.sin((FOV * Math.PI) / 360)) * 1.04 };
}

function Rig({ container, items }: { container: RefObject<HTMLElement | null>; items: TurntableItem[] }) {
  const groups = useRef(new Map<string, Group>());
  const angle = useRef(0.7);
  const still = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  const framings = useMemo(() => new Map(items.map((i) => [i.id, framingOf(i.def)])), [items]);
  const invalidate = useThree((s) => s.invalidate);

  // What can move a row, or bring one into view, without this scene changing: the list scrolling,
  // the window resizing, anything in the palette being added, removed or restyled, a transition
  // or animation finishing, a picture above loading. Each asks for one frame; the frame itself
  // decides whether to keep going. (Item and canvas-size changes ask for theirs through r3f.)
  useEffect(() => {
    const host = container.current;
    const wake = () => invalidate();
    window.addEventListener('scroll', wake, true); // capture: scroll does not bubble
    window.addEventListener('resize', wake);
    host?.addEventListener('transitionend', wake);
    host?.addEventListener('animationend', wake);
    host?.addEventListener('load', wake, true);
    const observer = host && typeof MutationObserver !== 'undefined' ? new MutationObserver(wake) : null;
    if (host) observer?.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });
    return () => {
      window.removeEventListener('scroll', wake, true);
      window.removeEventListener('resize', wake);
      host?.removeEventListener('transitionend', wake);
      host?.removeEventListener('animationend', wake);
      host?.removeEventListener('load', wake, true);
      observer?.disconnect();
    };
  }, [container, invalidate]);

  // Priority 1: this loop does all the drawing, in place of the default full-canvas render.
  useFrame((state, dt) => {
    const renderer = state.gl;
    const camera = state.camera as PerspectiveCamera;
    renderer.setScissorTest(false);
    renderer.clear();
    for (const g of groups.current.values()) g.visible = false;
    const host = container.current;
    if (!host) return;
    if (!still) angle.current = (angle.current + Math.min(dt, 0.1) * SPEED) % (Math.PI * 2);

    const canvas = renderer.domElement.getBoundingClientRect();
    if (canvas.width < 1 || canvas.height < 1) return;
    let drew = false;
    renderer.setScissorTest(true);
    for (const el of host.querySelectorAll<HTMLElement>('[data-tt]')) {
      const id = el.dataset.tt ?? '';
      const group = groups.current.get(id);
      const framing = framings.get(id);
      if (!group || !framing) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom <= canvas.top || r.top >= canvas.bottom || r.right <= canvas.left || r.left >= canvas.right) continue;
      const left = r.left - canvas.left;
      const bottom = canvas.bottom - r.bottom;
      renderer.setViewport(left, bottom, r.width, r.height);
      renderer.setScissor(left, bottom, r.width, r.height);
      camera.aspect = r.width / r.height;
      camera.near = framing.dist / 40;
      camera.far = framing.dist * 4;
      camera.position.set(0, Math.sin(ELEVATION) * framing.dist, Math.cos(ELEVATION) * framing.dist);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      group.rotation.y = angle.current;
      group.visible = true;
      renderer.render(state.scene, camera);
      group.visible = false;
      drew = true;
    }
    renderer.setScissorTest(false);
    // Something is on show and may turn: carry on. Otherwise this was the last frame until woken.
    if (drew && !still) state.invalidate();
  }, 1);

  return (
    <>
      <hemisphereLight color="#ffffff" groundColor="#cfc8b8" intensity={1.5} />
      <directionalLight position={[2.5, 4, 3]} intensity={2.1} />
      {items.map((item) => (
        <group
          key={item.id}
          visible={false}
          ref={(g) => {
            if (g) groups.current.set(item.id, g);
            else groups.current.delete(item.id);
          }}
        >
          <group position={[0, -(framings.get(item.id)?.centerY ?? 0), 0]}>
            <ItemModel def={item.def} />
          </group>
        </group>
      ))}
    </>
  );
}

/** The one canvas. Lay it over `container`, the element that holds every `data-tt` mark. */
export default function TurntableCanvas({ container, items }: { container: RefObject<HTMLElement | null>; items: TurntableItem[] }) {
  return (
    <Canvas
      className="pt-canvas"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      camera={{ fov: FOV, position: [0, 1, 3] }}
      dpr={[1, 2]}
      frameloop="demand"
      gl={{ antialias: true, alpha: true }}
      onCreated={({ gl }) => {
        // each view draws into its own rectangle; the frame is cleared once, at the top of the loop
        gl.autoClear = false;
      }}
    >
      <Rig container={container} items={items} />
    </Canvas>
  );
}
