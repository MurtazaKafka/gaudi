import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildWallBoxes } from './build';
import { detectRooms } from './rooms';
import { usePlanStore } from './store';
import { downloadBlob } from './serialize';

/**
 * Build a fresh scene from the plan (independent of the live viewer)
 * and download it as a binary glTF.
 */
export async function exportGlb(): Promise<void> {
  const { walls, openings, roomNames, settings } = usePlanStore.getState();
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

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true });
  downloadBlob(result as ArrayBuffer, 'gaudi-house.glb', 'model/gltf-binary');
}
