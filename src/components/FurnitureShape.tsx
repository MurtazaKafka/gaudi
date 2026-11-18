import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Arc, Circle, Ellipse, Group, Line, Rect, Shape, Text } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { customId, furnitureDef, isCustomKind, type FurnitureDef } from '../catalog';
import type { Furniture, Point } from '../types';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { beginGesture, endGesture } from '../history';
import { ptEq } from '../geometry';
import { currentUnits } from '../units';
import { theme } from '../theme';
import { nearestFit } from '../solidity';
import { canEdit, placeFurniture, takeInHand, toggleOnPlan, type InHand } from './plan/actions';
import { fineStep, snapPointTo } from './plan/drafting';
import type { DrawingLook } from './plan/look';
import { clickSwallowed, groupSelected } from './plan/marquee';
import { planShapes, traceShape, traceShapes } from './plan/symbol';

/** Click selects one item; Shift-click adds it to (or takes it out of) whatever is selected. */
function clickFurniture(id: string, additive: boolean): void {
  if (additive) toggleOnPlan('furniture', id);
  else useUiStore.getState().setFurnitureSelection([id]);
}

/** A drag in progress: the pieces in hand, the last pointer spot, the last spot that fitted, and whether it fits now. */
interface Drag extends InHand {
  last: Point;
  free: boolean;
  fit: { dx: number; dy: number };
  blocked: boolean;
}

/**
 * One furniture item on the plan; draggable in select mode. In the Color look
 * it is drawn from above out of its real parts and colours; in the Paper look,
 * and for ghosts (previews, placement), as a line symbol.
 *
 * A dragged item is solid (solidity.ts): it stops flush against walls and
 * other pieces, slides along them, and where nothing near fits it shows red
 * under the pointer and goes back where it came from if let go there. ⌥ lets
 * it pass through, as before. In a selection that moves as one piece the
 * canvas drags it with the rest.
 */
export const FurnitureShape = memo(function FurnitureShape({
  item,
  scale,
  selected,
  grouped = false,
  interactive,
  ghost = false,
  invalid = false,
  look = 'paper',
}: {
  item: Omit<Furniture, 'id'> & { id: string };
  scale: number;
  selected: boolean;
  /** Selected, in a selection that moves as one piece: the canvas moves it (PlanCanvas `startGroupDrag`). */
  grouped?: boolean;
  interactive: boolean;
  ghost?: boolean;
  /** Nothing near fits: drawn as "does not fit" (the placement ghost, or the selection being moved). */
  invalid?: boolean;
  look?: DrawingLook;
}) {
  // Custom definitions live in the plan: re-render when this one changes.
  const custom = usePlanStore((s) =>
    isCustomKind(item.kind) ? s.customItems[customId(item.kind)] : undefined,
  );
  const def: FurnitureDef = custom ?? furnitureDef(item.kind);
  const thin = 1.1 / scale;
  const stroke = invalid ? theme.invalid : ghost || selected ? theme.accent : theme.furnitureLine;
  const fill = ghost ? 'rgba(193, 78, 51, 0.06)' : 'rgba(252, 251, 248, 0.85)';
  // A custom item whose definition is gone keeps its crossed placeholder in either look.
  const furnished = look === 'color' && !ghost && !(isCustomKind(item.kind) && !custom);

  const drag = useRef<Drag | null>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(
    () => () => {
      if (drag.current) {
        drag.current = null;
        endGesture();
      }
    },
    [],
  );
  const doesNotFit = invalid || blocked;

  return (
    <Group
      x={item.x}
      y={item.y}
      rotation={(item.rotation * 180) / Math.PI}
      opacity={ghost ? 0.65 : 1}
      draggable={interactive && !grouped}
      listening={interactive}
      cursor="move"
      planItem={ghost ? undefined : `furniture:${item.id}`}
      onClick={(e: KonvaEventObject<MouseEvent>) => {
        // The release that ends a move of the whole selection is not a click on this item.
        if (e.evt.button !== 0 || clickSwallowed()) return;
        e.cancelBubble = true;
        clickFurniture(item.id, e.evt.shiftKey);
      }}
      onDragStart={(e) => {
        const ui = useUiStore.getState();
        // Pressed before this redrew as a selected part of a selection that moves as one piece: the canvas has it.
        if (groupSelected(ui) && ui.selectedFurnitureIds.includes(item.id)) {
          e.target.stopDrag();
          return;
        }
        // Dragging one of several selected items moves them together.
        let ids = ui.selectedFurnitureIds;
        if (!ids.includes(item.id)) {
          ids = [item.id];
          ui.setFurnitureSelection(ids);
        }
        // Whatever stands on what is dragged rides along (frozen now: a plate passed over on the way is not picked up).
        drag.current = { ...takeInHand(ids), last: { x: item.x, y: item.y }, free: false, fit: { dx: 0, dy: 0 }, blocked: false };
        beginGesture();
      }}
      onDragMove={(e) => {
        const d = drag.current;
        const from = d?.start.get(item.id);
        if (!d || !from) return;
        // Same snap as placement, so a dragged item lands where a placed one would; then it is kept out of things.
        const p = snapPointTo(e.target.position(), fineStep(currentUnits()));
        const free = e.evt.altKey;
        if (ptEq(p, d.last) && free === d.free) {
          e.target.position(d.blocked ? p : { x: from.x + d.fit.dx, y: from.y + d.fit.dy });
          return;
        }
        d.last = p;
        d.free = free;
        let dx = p.x - from.x;
        let dy = p.y - from.y;
        const spot = free ? { dx, dy, fits: true } : nearestFit(d.world, d.hand, dx, dy, { from: d.fit });
        d.blocked = !spot.fits;
        if (spot.fits) {
          dx = spot.dx;
          dy = spot.dy;
          d.fit = { dx, dy };
        }
        setBlocked(d.blocked);
        e.target.position({ x: from.x + dx, y: from.y + dy });
        placeFurniture(d.start, { x: dx, y: dy });
      }}
      onDragEnd={(e) => {
        const d = drag.current;
        // Let go where nothing fits: everything goes back exactly as it was, and no undo step is left.
        if (d?.blocked && canEdit()) usePlanStore.setState({ furniture: d.furniture });
        setBlocked(false);
        const now = usePlanStore.getState().furniture.find((f) => f.id === item.id);
        if (now) e.target.position({ x: now.x, y: now.y });
        if (!drag.current) return;
        drag.current = null;
        endGesture();
      }}
    >
      {furnished ? (
        <>
          <ItemArt def={def} />
          {/* the whole footprint takes the click, not just the parts */}
          <Rect x={-def.w / 2} y={-def.d / 2} width={def.w} height={def.d} fill="transparent" />
        </>
      ) : isCustomKind(item.kind) ? (
        <CustomSymbol def={def} missing={!custom} stroke={stroke} fill={fill} thin={thin} />
      ) : (
        <PlanSymbol kind={item.kind} w={def.w} d={def.d} stroke={stroke} fill={fill} thin={thin} />
      )}
      {item.label && !ghost && (
        // Counter-rotate so annotations stay horizontal whatever the item's rotation.
        <Group rotation={(-item.rotation * 180) / Math.PI} listening={false}>
          <Text
            text={item.label}
            fontSize={11 / scale}
            fontFamily={theme.mono}
            fill={theme.ink}
            width={4}
            offsetX={2}
            offsetY={5.5 / scale}
            align="center"
          />
        </Group>
      )}
      {doesNotFit && (
        // "Does not fit": the plan's own red for "can't go here", as a door ghost on a wall too short for it.
        <Rect
          x={-def.w / 2}
          y={-def.d / 2}
          width={def.w}
          height={def.d}
          fill={theme.invalidSoft}
          stroke={theme.invalid}
          strokeWidth={1.2 / scale}
          dash={[4 / scale, 3 / scale]}
          listening={false}
        />
      )}
      {selected && !ghost && !doesNotFit && (
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
});

/**
 * An item seen from above in its own colours: every visible part, softened to
 * sit on the plan, with a hairline around it and one soft shadow under the
 * whole piece. One canvas shape per item; the parts are worked out once per
 * definition (`planShapes` caches), never on a mouse move.
 */
const ItemArt = memo(function ItemArt({ def }: { def: FurnitureDef }) {
  const sceneFunc = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      const shapes = planShapes(def);
      if (shapes.length === 0) return;
      const ctx = context._context;
      const zoom = Math.abs(shape.getAbsoluteScale().x) || 1; // px per meter
      const k = zoom * context.canvas.getPixelRatio();
      const alpha = ctx.globalAlpha;

      // Taller pieces stand further off the floor; a rug barely lifts.
      const lift = Math.min(1, Math.max(0.04, def.h / 0.9));
      ctx.save();
      traceShapes(ctx, shapes);
      ctx.shadowColor = theme.itemShadow;
      ctx.shadowBlur = (0.025 + 0.085 * lift) * k;
      ctx.shadowOffsetX = (0.008 + 0.022 * lift) * k;
      ctx.shadowOffsetY = (0.014 + 0.036 * lift) * k;
      ctx.fillStyle = shapes[0].fill;
      ctx.fill();
      ctx.restore();

      ctx.lineJoin = 'round';
      ctx.lineWidth = 0.8 / zoom;
      for (const s of shapes) {
        ctx.beginPath();
        traceShape(ctx, s);
        if (!s.hole) {
          ctx.globalAlpha = alpha * s.opacity;
          ctx.fillStyle = s.fill;
          ctx.fill();
          ctx.globalAlpha = alpha;
        }
        ctx.strokeStyle = s.edge;
        ctx.stroke();
      }
    },
    [def],
  );
  return <Shape sceneFunc={sceneFunc} listening={false} perfectDrawEnabled={false} />;
});

/**
 * Plan symbol for an item defined in the plan itself: its footprint, and the
 * outline of its parts seen from above, in the same linework as the catalog.
 */
function CustomSymbol({
  def,
  missing,
  stroke,
  fill,
  thin,
}: {
  def: FurnitureDef;
  /** the definition is gone — draw the crossed placeholder */
  missing: boolean;
  stroke: string;
  fill: string;
  thin: number;
}) {
  const hw = def.w / 2;
  const hd = def.d / 2;
  const shapes = missing ? [] : planShapes(def);
  return (
    <>
      <Rect
        x={-hw}
        y={-hd}
        width={def.w}
        height={def.d}
        stroke={stroke}
        strokeWidth={thin}
        dash={missing ? [thin * 4, thin * 3] : undefined}
        fill={fill}
      />
      {missing && (
        <>
          <Line points={[-hw, -hd, hw, hd]} stroke={stroke} strokeWidth={thin / 1.5} listening={false} />
          <Line points={[-hw, hd, hw, -hd]} stroke={stroke} strokeWidth={thin / 1.5} listening={false} />
        </>
      )}
      {shapes.map((s, i) =>
        s.kind === 'poly' ? (
          <Line
            key={i}
            points={s.points}
            closed
            stroke={stroke}
            strokeWidth={thin / 1.5}
            lineJoin="round"
            listening={false}
          />
        ) : (
          <Ellipse
            key={i}
            x={s.x}
            y={s.y}
            radiusX={s.rx}
            radiusY={s.ry}
            rotation={s.rotation}
            stroke={stroke}
            strokeWidth={thin / 1.5}
            listening={false}
          />
        ),
      )}
    </>
  );
}

/** Kind-specific plan linework; local frame is meters, item center at 0,0, "front" toward +y. */
function PlanSymbol({
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
    case 'event_table':
      return base;
    case 'stage':
      return (
        <>
          {base}
          <Rect
            x={-hw + 0.15}
            y={-hd + 0.15}
            width={w - 0.3}
            height={d - 0.3}
            stroke={stroke}
            strokeWidth={thin / 1.5}
          />
        </>
      );
    case 'speaker':
      return (
        <>
          {base}
          <Circle x={0} y={0.02} radius={Math.min(hw, hd) * 0.55} stroke={stroke} strokeWidth={thin} />
        </>
      );
    case 'mic':
      return (
        <>
          <Circle radius={hw * 0.8} stroke={stroke} strokeWidth={thin} fill={fill} />
          <Circle radius={hw * 0.28} stroke={stroke} strokeWidth={thin / 1.5} />
        </>
      );
    case 'trash_bin':
      return (
        <>
          <Circle radius={hw} stroke={stroke} strokeWidth={thin} fill={fill} />
          <Line points={[-hw * 0.45, 0, hw * 0.45, 0]} stroke={stroke} strokeWidth={thin / 1.5} />
        </>
      );
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
