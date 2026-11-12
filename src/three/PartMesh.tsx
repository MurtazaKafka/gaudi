import { useEffect, useMemo } from 'react';
import type { FurnitureDef, Part } from '../catalog';
import { partGeometry, partMaterialProps, partRotation } from './partGeometry';

/** One furniture primitive as an r3f mesh. `color` overrides the part's own (style tints). */
export function PartMesh({ part, color }: { part: Part; color?: string }) {
  const geometry = useMemo(() => partGeometry(part), [part]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const mat = partMaterialProps(part, color);
  return (
    <mesh
      geometry={geometry}
      position={[part.x, part.y, part.z]}
      rotation={partRotation(part)}
      castShadow={mat.opacity > 0.5}
      receiveShadow
    >
      <meshStandardMaterial {...mat} />
    </mesh>
  );
}

/** A whole furniture model in its local frame (origin on the floor, centered on the footprint). */
export function ItemModel({
  def,
  tint,
}: {
  def: FurnitureDef;
  /** Optional per-part color mapping (style palettes). */
  tint?: (color: string) => string;
}) {
  return (
    <>
      {def.parts.map((p, i) => (
        <PartMesh key={i} part={p} color={tint ? tint(p.color) : undefined} />
      ))}
    </>
  );
}
