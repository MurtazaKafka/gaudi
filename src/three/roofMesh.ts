/**
 * Roof model → three.js meshes. Kept apart from house.ts (and free of the
 * catalog, textures and store) so the roof can be built and checked on its
 * own; the live scene and the GLB exporter both come through here.
 */
import * as THREE from 'three';
import type { Point } from '../types';
import type { RoofModel, RoofPart } from './roof';

function loopPath<T extends THREE.Path>(path: T, loop: Point[]): T | null {
  const pts = loop.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return null;
  pts.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
  path.closePath();
  return path;
}

/** One mesh per slab and per solid, named `roof`, `roof-gable` or `roof-soffit`. */
export function buildRoofMeshes(
  model: RoofModel,
  materials: Record<RoofPart, THREE.Material>,
  castShadow = true,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'roof';
  const add = (geo: THREE.BufferGeometry, part: RoofPart) => {
    const mesh = new THREE.Mesh(geo, materials[part]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.name = part === 'roof' ? 'roof' : `roof-${part}`;
    group.add(mesh);
  };

  for (const slab of model.slabs) {
    const shape = loopPath(new THREE.Shape(), slab.poly);
    if (!shape || !(slab.y1 > slab.y0)) continue;
    for (const hole of slab.holes ?? []) {
      const path = loopPath(new THREE.Path(), hole);
      if (path) shape.holes.push(path);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: slab.y1 - slab.y0, bevelEnabled: false });
    // Extruded along +z; lay it down so the depth runs downward from y1.
    geo.rotateX(Math.PI / 2);
    geo.translate(0, slab.y1, 0);
    add(geo, slab.part);
  }

  for (const solid of model.solids) {
    if (solid.positions.length < 9 || !solid.positions.every((v) => Number.isFinite(v))) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(solid.positions, 3));
    // Loose triangles: flat faces, crisp ridges and valleys.
    geo.computeVertexNormals();
    // UVs in meters: across the slope and up it, so tiles and seams run true on every face.
    const pos = solid.positions;
    const uv = new Float32Array((pos.length / 3) * 2);
    const n = new THREE.Vector3();
    const t = new THREE.Vector3();
    const b = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const normal = geo.getAttribute('normal');
    for (let i = 0; i < pos.length / 3; i++) {
      n.fromBufferAttribute(normal, i);
      t.crossVectors(up, n);
      if (t.lengthSq() < 1e-8) t.set(1, 0, 0);
      t.normalize();
      b.crossVectors(n, t);
      p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      uv[i * 2] = p.dot(t);
      uv[i * 2 + 1] = p.dot(b);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    add(geo, solid.part);
  }
  return group;
}
