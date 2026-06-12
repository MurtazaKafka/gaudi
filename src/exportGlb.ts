import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildWallBoxes } from './build';
import { detectRooms } from './rooms';
import { furnitureDef } from './catalog';
import { usePlanStore } from './store';
import { downloadBlob } from './serialize';

/**
 * Build a fresh scene from the plan (independent of the live viewer)
 * and download it as a binary glTF.
 */
export async function exportGlb(): Promise<void> {
  const { walls, openings, furniture, roomNames, settings } = usePlanStore.getState();
  const scene = new THREE.Scene();
  scene.name = 'gaudi-house';

  const wallMat = new THREE.MeshStandardMaterial({ color: '#efebe1', roughness: 0.92 });
  const floorMat = new THREE.MeshStandardMaterial({
    color: '#d9d3c5',
    roughness: 1,
    side: THREE.DoubleSide,
  });

  for (const b of buildWallBoxes(walls, openings, settings)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.length, b.height, b.thickness), wallMat);
    mesh.position.set(b.x, b.y, b.z);
    mesh.rotation.y = b.rotY;
    mesh.name = `wall-${b.key}`;
    scene.add(mesh);
  }

  for (const room of detectRooms(walls)) {
    const shape = new THREE.Shape();
    room.polygon.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, floorMat);
    mesh.position.y = 0.005;
    mesh.name = `floor-${roomNames[room.key] ?? 'room'}`;
    scene.add(mesh);
  }

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const materialFor = (color: string) => {
    let m = materials.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
      materials.set(color, m);
    }
    return m;
  };

  for (const f of furniture) {
    const def = furnitureDef(f.kind);
    const group = new THREE.Group();
    group.position.set(f.x, 0, f.y);
    group.rotation.y = -f.rotation;
    group.name = f.kind;
    for (const p of def.parts) {
      const geo =
        p.shape === 'box'
          ? new THREE.BoxGeometry(p.w!, p.h!, p.d!)
          : p.shape === 'cylinder'
            ? new THREE.CylinderGeometry(p.r!, p.r!, p.h!, 24)
            : new THREE.SphereGeometry(p.r!, 18, 14);
      const mesh = new THREE.Mesh(geo, materialFor(p.color));
      mesh.position.set(p.x, p.y, p.z);
      group.add(mesh);
    }
    scene.add(group);
  }

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true });
  downloadBlob(result as ArrayBuffer, 'gaudi-house.glb', 'model/gltf-binary');
}
