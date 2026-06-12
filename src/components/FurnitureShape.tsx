import { Arc, Circle, Ellipse, Group, Line, Rect } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { furnitureDef } from '../catalog';
import type { Furniture } from '../types';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { theme } from '../theme';

const SNAP = 0.05;

/** Top-view plan symbol for one furniture item; draggable in select mode. */
export function FurnitureShape({
  item,
  scale,
  selected,
  interactive,
  ghost = false,
}: {
  item: Furniture;
  scale: number;
  selected: boolean;
  interactive: boolean;
  ghost?: boolean;
}) {
  const def = furnitureDef(item.kind);
  const thin = 1.1 / scale;
  const stroke = ghost || selected ? theme.accent : '#8d8779';
  const fill = ghost ? 'rgba(193, 78, 51, 0.06)' : 'rgba(252, 251, 248, 0.85)';

  return (
    <Group
      x={item.x}
      y={item.y}
      rotation={(item.rotation * 180) / Math.PI}
      opacity={ghost ? 0.65 : 1}
      draggable={interactive}
      listening={interactive}
      onClick={(e: KonvaEventObject<MouseEvent>) => {
        if (e.evt.button !== 0) return;
        e.cancelBubble = true;
        useUiStore.getState().setFurnitureSelection([item.id]);
      }}
      onDragStart={() => useUiStore.getState().setFurnitureSelection([item.id])}
      onDragEnd={(e) => {
        const x = Math.round(e.target.x() / SNAP) * SNAP;
        const y = Math.round(e.target.y() / SNAP) * SNAP;
        e.target.position({ x, y });
        usePlanStore.getState().moveFurniture(item.id, x, y);
      }}
      onMouseEnter={(e) => {
        const stage = e.target.getStage();
        if (stage && interactive) stage.container().style.cursor = 'move';
      }}
      onMouseLeave={(e) => {
        const stage = e.target.getStage();
        if (stage) stage.container().style.cursor = '';
      }}
    >
      <Symbol kind={item.kind} w={def.w} d={def.d} stroke={stroke} fill={fill} thin={thin} />
      {selected && !ghost && (
        <Rect
          x={-def.w / 2 - 3 / scale}
          y={-def.d / 2 - 3 / scale}
          width={def.w + 6 / scale}
          height={def.d + 6 / scale}
          stroke={theme.accent}
          strokeWidth={1 / scale}
          dash={[3 / scale, 2 / scale]}
          listening={false}
        />
      )}
    </Group>
  );
}

/** Kind-specific plan linework; local frame is meters, item center at 0,0, "front" toward +y. */
function Symbol({
  kind,
  w,
  d,
  stroke,
  fill,
  thin,
}: {
  kind: Furniture['kind'];
  w: number;
  d: number;
  stroke: string;
  fill: string;
  thin: number;
}) {
  const hw = w / 2;
  const hd = d / 2;
  const base = (
    <Rect x={-hw} y={-hd} width={w} height={d} stroke={stroke} strokeWidth={thin} fill={fill} />
  );

  switch (kind) {
    case 'bed_double':
    case 'bed_single': {
      const pillowLine = -hd + 0.55;
      return (
        <>
          {base}
          <Line points={[-hw, pillowLine, hw, pillowLine]} stroke={stroke} strokeWidth={thin} />
          <Line
            points={[-hw, pillowLine + 0.25, hw, pillowLine + 0.25]}
            stroke={stroke}
            strokeWidth={thin / 1.5}
          />
        </>
      );
    }
    case 'sofa':
    case 'armchair':
      return (
        <>
          {base}
          <Line points={[-hw, -hd + 0.16, hw, -hd + 0.16]} stroke={stroke} strokeWidth={thin} />
          <Line points={[-hw + 0.14, -hd + 0.16, -hw + 0.14, hd]} stroke={stroke} strokeWidth={thin} />
          <Line points={[hw - 0.14, -hd + 0.16, hw - 0.14, hd]} stroke={stroke} strokeWidth={thin} />
        </>
      );
    case 'chair':
      return (
        <>
          {base}
          <Line points={[-hw, -hd + 0.08, hw, -hd + 0.08]} stroke={stroke} strokeWidth={thin} />
        </>
      );
    case 'dining_table':
    case 'coffee_table':
    case 'desk':
      return base;
    case 'rug':
      return (
        <Circle radius={hw} stroke={stroke} strokeWidth={thin} dash={[0.08, 0.06]} fill={fill} />
      );
    case 'plant':
      return (
        <>
          <Circle radius={hw} stroke={stroke} strokeWidth={thin} fill={fill} />
          <Circle radius={hw * 0.45} stroke={stroke} strokeWidth={thin / 1.5} />
        </>
      );
    case 'toilet':
      return (
        <>
          <Rect x={-hw} y={-hd} width={w} height={0.16} stroke={stroke} strokeWidth={thin} fill={fill} />
          <Ellipse
            x={0}
            y={0.08}
            radiusX={0.19}
            radiusY={0.24}
            stroke={stroke}
            strokeWidth={thin}
            fill={fill}
          />
        </>
      );
    case 'bathroom_sink':
      return (
        <>
          {base}
          <Ellipse x={0} y={0.02} radiusX={hw - 0.08} radiusY={hd - 0.1} stroke={stroke} strokeWidth={thin} />
        </>
      );
    case 'kitchen_sink':
      return (
        <>
          {base}
          <Rect x={-hw + 0.08} y={-hd + 0.1} width={w - 0.16} height={d - 0.2} stroke={stroke} strokeWidth={thin} />
        </>
      );
    case 'bathtub':
      return (
        <>
          {base}
          <Rect
            x={-hw + 0.09}
            y={-hd + 0.09}
            width={w - 0.18}
            height={d - 0.18}
            cornerRadius={0.18}
            stroke={stroke}
            strokeWidth={thin}
          />
        </>
      );
    case 'stove':
      return (
        <>
          {base}
          <Circle x={-0.14} y={-0.14} radius={0.09} stroke={stroke} strokeWidth={thin} />
          <Circle x={0.14} y={-0.14} radius={0.09} stroke={stroke} strokeWidth={thin} />
          <Circle x={-0.14} y={0.14} radius={0.09} stroke={stroke} strokeWidth={thin} />
          <Circle x={0.14} y={0.14} radius={0.09} stroke={stroke} strokeWidth={thin} />
        </>
      );
    case 'wardrobe':
      return (
        <>
          {base}
          <Line points={[0, -hd, 0, hd]} stroke={stroke} strokeWidth={thin} />
          {/* door swing hints */}
          <Arc x={-hw} y={hd} innerRadius={0} outerRadius={0.3} angle={40} rotation={-90} stroke={stroke} strokeWidth={thin / 1.5} />
          <Arc x={hw} y={hd} innerRadius={0} outerRadius={0.3} angle={40} rotation={230} stroke={stroke} strokeWidth={thin / 1.5} />
        </>
      );
    case 'bookshelf':
    case 'tv_stand':
    case 'counter':
    case 'fridge':
    case 'nightstand':
    default:
      return (
        <>
          {base}
          <Line points={[-hw, -hd, hw, hd]} stroke={stroke} strokeWidth={thin / 1.5} />
        </>
      );
  }
}
