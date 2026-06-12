import { useMemo } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { usePlanStore } from '../store';
import { buildWallBoxes } from '../build';
import { detectRooms } from '../rooms';
import type { Point } from '../types';
import { theme } from '../theme';

const WALL_COLOR = '#efebe1';
const FLOOR_COLOR = '#d9d3c5';
const GROUND_COLOR = '#eae6dc';

export function Scene3D() {
  const walls = usePlanStore((s) => s.walls);
  const openings = usePlanStore((s) => s.openings);
  const settings = usePlanStore((s) => s.settings);

  const boxes = useMemo(
    () => buildWallBoxes(walls, openings, settings),
    [walls, openings, settings],
  );
  const rooms = useMemo(() => detectRooms(walls), [walls]);

  // Plan bounding box → a camera that looks down into the house.
  const { center, radius } = useMemo(() => {
    if (walls.length === 0) return { center: { x: 0, y: 0 }, radius: 6 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const w of walls) {
      for (const p of [w.a, w.b]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    return {
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      radius: Math.max((maxX - minX) / 2, (maxY - minY) / 2, 3),
    };
  }, [walls]);

  const camPos: [number, number, number] = [
    center.x + radius * 1.5,
    radius * 1.7,
    center.y + radius * 1.9,
  ];
  const target: [number, number, number] = [center.x, 0, center.y];

  return (
    <div className="scene-3d">
      <Canvas shadows camera={{ position: camPos, fov: 42 }}>
        <color attach="background" args={[theme.paper]} />

        <ambientLight intensity={0.85} />
        <directionalLight
          position={[center.x + radius * 1.2, radius * 2.6, center.y - radius * 1.4]}
          intensity={2.2}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-radius * 2.2}
          shadow-camera-right={radius * 2.2}
          shadow-camera-top={radius * 2.2}
          shadow-camera-bottom={-radius * 2.2}
          shadow-camera-far={radius * 8}
          shadow-bias={-0.0004}
        />

        {boxes.map((b) => (
          <mesh
            key={b.key}
            position={[b.x, b.y, b.z]}
            rotation={[0, b.rotY, 0]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[b.length, b.height, b.thickness]} />
            <meshStandardMaterial color={WALL_COLOR} roughness={0.92} />
          </mesh>
        ))}

        {rooms.map((room) => (
          <Floor key={room.key} polygon={room.polygon} />
        ))}

        {/* ground */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, -0.002, center.y]} receiveShadow>
          <circleGeometry args={[Math.max(radius * 5, 24), 64]} />
          <meshStandardMaterial color={GROUND_COLOR} roughness={1} />
        </mesh>

        <OrbitControls
          target={target}
          maxPolarAngle={Math.PI / 2 - 0.04}
          minDistance={1.5}
          maxDistance={radius * 10}
          makeDefault
        />
      </Canvas>
    </div>
  );
}

function Floor({ polygon }: { polygon: Point[] }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    polygon.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
    const geo = new THREE.ShapeGeometry(shape);
    // Lay the plan flat: shape (x, y) → world (x, 0, y).
    geo.rotateX(Math.PI / 2);
    return geo;
  }, [polygon]);

  return (
    <mesh geometry={geometry} position={[0, 0.01, 0]} receiveShadow>
      <meshStandardMaterial color={FLOOR_COLOR} roughness={1} side={THREE.DoubleSide} />
    </mesh>
  );
}
