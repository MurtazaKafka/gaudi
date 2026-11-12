import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { usePlanStore } from './store';
import { downloadBlob } from './serialize';
import { buildHouse, disposeGroup } from './three/house';
import { fileSlug } from './three/snapshot';
import { effectiveRoof, styleById } from './three/styles';
import { useViewStore } from './three/viewStore';

/**
 * The model as a scene graph, built by the same code that draws it on
 * screen: styled materials, floors, door and window frames with glass,
 * furniture, and the roof — the plan's own, or the one Exterior is showing.
 * The roof comes from the same builder as on screen (src/three/roof.ts). Nodes are
 * named (wall-…, floor-<room>, door-…, window-…, roof, furniture labels).
 */
export function buildExportScene(): THREE.Scene {
  const plan = usePlanStore.getState();
  const style = styleById(plan.look?.style);
  // A roof the plan asks for always goes along; Exterior's stand-in roof only while it is showing.
  const planRoof = plan.look?.roof ?? 'none';
  const exterior = planRoof !== 'none' || useViewStore.getState().view === 'exterior';

  const scene = new THREE.Scene();
  scene.name = fileSlug(plan.name, 'gaudi-house');
  const house = buildHouse(plan, {
    style,
    roof: effectiveRoof(planRoof, style, exterior),
    edges: false,
  });
  // The plan is y-down with z as "south"; glTF is y-up, which is what we already build.
  scene.add(house);
  return scene;
}

/** Download what is on screen as a binary glTF, named after the plan. */
export async function exportGlb(): Promise<void> {
  const scene = buildExportScene();
  try {
    const result = await new GLTFExporter().parseAsync(scene, { binary: true });
    downloadBlob(result as ArrayBuffer, `${scene.name}.glb`, 'model/gltf-binary');
  } finally {
    disposeGroup(scene);
  }
}
