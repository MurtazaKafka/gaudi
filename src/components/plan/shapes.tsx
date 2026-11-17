import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Circle, Group, Label, Line, Path, Rect, Shape, Tag, Text } from 'react-konva';
import type Konva from 'konva';
import { DOUBLE_DOOR_MIN, usePlanStore } from '../../store';
import { useUiStore } from '../../uiStore';
import { beginGesture, endGesture } from '../../history';
import { dist, midpoint, ptEq, wallAngle } from '../../geometry';
import { currentUnits, formatLength } from '../../units';
import { theme } from '../../theme';
import type { Opening, Point, Units, Wall } from '../../types';
import type { EndpointRef } from '../../store';
import { finishWallEdit, moveJunctions, moveOpening, toggleOnPlan } from './actions';
import {
  dimensionSide,
  fineStep,
  junctionRefs,
  labelPose,
  perpendicularDelta,
  resolveDraftPoint,
  wallMoveGroups,
  type JunctionGroup,
} from './drafting';
import { OPENING_LABEL_SIZE } from './labels';
import type { DrawingLook } from './look';
import { entranceMarkerSize, type Entrance, type Poche } from './poche';
import type { GridLines } from './view';

export const GridLayerLines = memo(function GridLayerLines({
  grid,
  scale,
}: {
  grid: GridLines;
  scale: number;
}) {
  const w = 1 / scale;
  return (
    <>
      {grid.minor.map((pts, i) => (
        <Line key={`m${i}`} points={pts} stroke={theme.gridMinor} strokeWidth={w} />
      ))}
      {grid.major.map((pts, i) => (
        <Line key={`M${i}`} points={pts} stroke={theme.gridMajor} strokeWidth={w} />
      ))}
      {grid.axes.map((pts, i) => (
        <Line key={`A${i}`} points={pts} stroke={theme.gridAxis} strokeWidth={w} />
      ))}
    </>
  );
});

/** Select the wall, or with Shift add it to (or take it out of) whatever is selected. */
function clickWall(id: string, additive: boolean): void {
  if (additive) toggleOnPlan('walls', id);
  else useUiStore.getState().setSelection([id]);
}

/**
 * A wall. Click selects; dragging the body of a selected wall slides it
 * across itself on the grid, taking its corners (and anything attached) along.
 */
export const WallLine = memo(function WallLine({
  wall,
  thickness,
  scale,
  selected,
  interactive,
  poche = false,
  onHover,
}: {
  wall: Wall;
  thickness: number;
  scale: number;
  selected: boolean;
  interactive: boolean;
  /** The wall body is drawn elsewhere (<WallPoche>): this is only the line to click and drag. */
  poche?: boolean;
  /** Told which wall the pointer is on (null when it leaves). */
  onHover?: (id: string | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const drag = useRef<{ groups: JunctionGroup[]; wall: Wall; last: Point } | null>(null);

  // A wall that disappears mid-drag (undo, plan swap) must not leave a gesture open.
  useEffect(
    () => () => {
      if (drag.current) {
        drag.current = null;
        endGesture();
      }
    },
    [],
  );

  const stroke = poche
    ? UNSEEN
    : selected
      ? theme.accent
      : hovered && interactive
        ? theme.inkHover
        : theme.ink;
  return (
    <Line
      points={[wall.a.x, wall.a.y, wall.b.x, wall.b.y]}
      stroke={stroke}
      strokeWidth={Math.max(thickness, 2 / scale)}
      lineCap="square"
      hitStrokeWidth={Math.max(thickness, 14 / scale)}
      listening={interactive}
      cursor={selected ? 'move' : 'pointer'}
      draggable={interactive && selected}
      onClick={(e) => {
        if (e.evt.button !== 0) return;
        e.cancelBubble = true;
        clickWall(wall.id, e.evt.shiftKey);
      }}
      onMouseEnter={() => {
        setHovered(true);
        onHover?.(wall.id);
      }}
      onMouseLeave={() => {
        setHovered(false);
        onHover?.(null);
      }}
      onDragStart={() => {
        const { walls } = usePlanStore.getState();
        const selectedIds = useUiStore.getState().selectedWallIds;
        const ids = selectedIds.includes(wall.id) ? selectedIds : [wall.id];
        drag.current = {
          groups: wallMoveGroups(walls, ids),
          wall: { id: wall.id, a: { ...wall.a }, b: { ...wall.b } },
          last: { x: 0, y: 0 },
        };
        beginGesture();
      }}
      onDragMove={(e) => {
        const d = drag.current;
        const raw = e.target.position();
        // The line is drawn from the store; the node itself never moves.
        e.target.position({ x: 0, y: 0 });
        if (!d) return;
        const delta = perpendicularDelta(d.wall, raw, usePlanStore.getState().settings.gridSize);
        if (ptEq(delta, d.last)) return;
        d.last = delta;
        moveJunctions(d.groups, delta);
      }}
      onDragEnd={(e) => {
        e.target.position({ x: 0, y: 0 });
        if (!drag.current) return;
        drag.current = null;
        finishWallEdit();
        endGesture();
      }}
    />
  );
});

/** A draggable corner handle of a selected wall. The whole junction moves as one. */
export function EndpointHandle({
  wall,
  end,
  scale,
  snapRadiusM,
}: {
  wall: Wall;
  end: 'a' | 'b';
  scale: number;
  snapRadiusM: number;
}) {
  const pt = wall[end];
  // The junction (every end coincident at drag start) is frozen here so the
  // corner moves as one and never welds onto walls merely passed over.
  const drag = useRef<{ refs: EndpointRef[]; last: Point } | null>(null);

  useEffect(
    () => () => {
      if (drag.current) {
        drag.current = null;
        endGesture();
      }
    },
    [],
  );

  return (
    <Circle
      x={pt.x}
      y={pt.y}
      radius={5.5 / scale}
      fill={theme.surface}
      stroke={theme.accent}
      strokeWidth={1.5 / scale}
      hitStrokeWidth={10 / scale}
      cursor="move"
      draggable
      onDragStart={() => {
        drag.current = { refs: junctionRefs(usePlanStore.getState().walls, pt), last: { ...pt } };
        beginGesture();
      }}
      onDragMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const plan = usePlanStore.getState();
        const isOwn = (wallId: string, e2: 'a' | 'b') =>
          d.refs.some((r) => r.wallId === wallId && r.end === e2);
        const self = plan.walls.find((w) => w.id === wall.id);
        // Shift locks this wall to 15° steps about its other end.
        const { p } = resolveDraftPoint(e.target.position(), {
          walls: plan.walls.map((w) =>
            // ends being dragged can't be snap targets
            isOwn(w.id, 'a') || isOwn(w.id, 'b')
              ? { ...w, a: isOwn(w.id, 'a') ? NOWHERE : w.a, b: isOwn(w.id, 'b') ? NOWHERE : w.b }
              : w,
          ),
          grid: plan.settings.gridSize,
          radius: snapRadiusM,
          anchor: self ? self[end === 'a' ? 'b' : 'a'] : null,
          constrain: e.evt.shiftKey,
        });
        e.target.position(p);
        if (ptEq(p, d.last)) return;
        d.last = p;
        if (!useUiStore.getState().readOnly) plan.moveEndpoints(d.refs, p);
      }}
      onDragEnd={() => {
        if (!drag.current) return;
        drag.current = null;
        finishWallEdit();
        endGesture();
      }}
    />
  );
}

/** Far enough away that nothing snaps to it. */
const NOWHERE: Point = { x: 1e9, y: 1e9 };

/** A stroke that is there to be hit, not seen. */
const UNSEEN = 'rgba(0, 0, 0, 0)';

/** Trace flat outlines into one path; every loop is closed. */
function traceLoops(ctx: CanvasRenderingContext2D, loops: number[][]): void {
  ctx.beginPath();
  for (const l of loops) {
    if (l.length < 6) continue;
    ctx.moveTo(l[0], l[1]);
    for (let i = 2; i + 1 < l.length; i += 2) ctx.lineTo(l[i], l[i + 1]);
    ctx.closePath();
  }
}

/** px of canvas per plan meter for a node being drawn (zoom × device pixel ratio). */
function devicePx(context: Konva.Context, shape: Konva.Shape): number {
  return Math.abs(shape.getAbsoluteScale().x) * context.canvas.getPixelRatio();
}

/**
 * The house as an object on the paper: its footprint in the paper's own tone
 * (so only the soft shadow around it shows). Sits under the grid.
 */
export const HouseShadow = memo(function HouseShadow({ loops }: { loops: number[][] }) {
  const sceneFunc = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      if (loops.length === 0) return;
      const ctx = context._context;
      const k = devicePx(context, shape);
      ctx.save();
      traceLoops(ctx, loops);
      // Grows with the zoom like the rest of the drawing, up to a point.
      ctx.shadowColor = theme.houseShadow;
      ctx.shadowBlur = Math.min(0.42 * k, 30 * context.canvas.getPixelRatio());
      ctx.shadowOffsetX = Math.min(0.04 * k, 3 * context.canvas.getPixelRatio());
      ctx.shadowOffsetY = Math.min(0.1 * k, 7 * context.canvas.getPixelRatio());
      ctx.fillStyle = theme.paper;
      ctx.fill();
      ctx.restore();
    },
    [loops],
  );
  return <Shape sceneFunc={sceneFunc} listening={false} perfectDrawEnabled={false} />;
});

/**
 * The walls as poché: the whole body at true thickness in one ink fill, so
 * corners and tees join cleanly, with the hovered and selected walls' own
 * pieces drawn over it. Purely a drawing — <WallLine> is what gets clicked.
 */
export const WallPoche = memo(function WallPoche({
  poche,
  thickness,
  scale,
  selectedIds,
  hoverId,
}: {
  poche: Poche;
  thickness: number;
  scale: number;
  selectedIds: string[];
  hoverId: string | null;
}) {
  const sceneFunc = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      traceLoops(context._context, poche.loops);
      context.fillStrokeShape(shape);
    },
    [poche],
  );
  // A hairline in the same ink seals the seams and keeps thin walls visible when zoomed out.
  const seal = Math.max(0.6 / scale, 2 / scale - thickness);
  const over = (id: string, fill: string) =>
    (poche.tilesOf.get(id) ?? []).map((pts, i) => (
      <Line
        key={`${id}-${i}`}
        points={pts}
        closed
        fill={fill}
        stroke={fill}
        strokeWidth={seal}
        lineJoin="round"
        listening={false}
        perfectDrawEnabled={false}
      />
    ));
  return (
    <>
      <Shape
        sceneFunc={sceneFunc}
        fill={theme.ink}
        stroke={theme.ink}
        strokeWidth={seal}
        lineJoin="miter"
        listening={false}
        perfectDrawEnabled={false}
      />
      {hoverId && !selectedIds.includes(hoverId) && over(hoverId, theme.inkHover)}
      {selectedIds.map((id) => over(id, theme.accent))}
    </>
  );
});

/** A quiet mark at the front door: a small ink arrowhead outside it, pointing in. */
export const EntranceMarker = memo(function EntranceMarker({
  entrance,
  scale,
}: {
  entrance: Entrance;
  scale: number;
}) {
  const size = entranceMarkerSize(scale);
  const { at, inward } = entrance;
  const back = { x: at.x - inward.x * size, y: at.y - inward.y * size };
  const side = { x: -inward.y * size * 0.55, y: inward.x * size * 0.55 };
  return (
    <Line
      points={[at.x, at.y, back.x + side.x, back.y + side.y, back.x - side.x, back.y - side.y]}
      closed
      fill={theme.ink}
      opacity={0.78}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
});

/** Plan symbol for a door (swing arc) or window (glazing lines), drawn in the wall's local frame. */
export const OpeningShape = memo(function OpeningShape({
  wall,
  opening,
  thickness,
  scale,
  selected,
  interactive,
  ghost = false,
  invalid = false,
  look = 'paper',
  labelAt = null,
}: {
  wall: Wall;
  opening: Opening;
  thickness: number;
  scale: number;
  selected: boolean;
  interactive: boolean;
  ghost?: boolean;
  /** A ghost where the opening can't go. */
  invalid?: boolean;
  look?: DrawingLook;
  /** Where the opening's own label is centered (see `openingLabelSpot`); null when there is no good place for it. */
  labelAt?: Point | null;
}) {
  const dragging = useRef(false);
  useEffect(
    () => () => {
      if (dragging.current) {
        dragging.current = false;
        endGesture();
      }
    },
    [],
  );

  const len = dist(wall.a, wall.b);
  if (len < 1e-6) return null;
  const ux = (wall.b.x - wall.a.x) / len;
  const uy = (wall.b.y - wall.a.y) / len;
  const at = (offset: number): Point => ({ x: wall.a.x + ux * offset, y: wall.a.y + uy * offset });
  const c = at(opening.offset);
  const deg = (wallAngle(wall) * 180) / Math.PI;

  const w = opening.width;
  const half = w / 2;
  const ht = thickness / 2;
  const thin = 1.2 / scale;
  const tint = invalid ? theme.invalid : theme.accent;
  const ink = ghost || selected ? tint : theme.ink;
  const soft = ghost || selected ? tint : theme.inkSoft;

  if (invalid) {
    // Just the outline of where it would have gone — no gap is cut.
    return (
      <Group x={c.x} y={c.y} rotation={deg} opacity={0.5} listening={false}>
        <Rect
          x={-half}
          y={-ht - 3 / scale}
          width={w}
          height={thickness + 6 / scale}
          fill={theme.invalidSoft}
          stroke={theme.invalid}
          strokeWidth={thin}
          dash={[4 / scale, 3 / scale]}
        />
      </Group>
    );
  }

  const canDrag = interactive && selected && !ghost;
  const color = look === 'color';
  // Color: the floor shows through a doorway, glass fills a window. Paper: the gap is bare paper.
  const gapFill = !color ? theme.paper : opening.type === 'door' ? theme.threshold : theme.glass;
  return (
    <>
      {opening.label && labelAt && !ghost && (
        <Text
          x={labelAt.x}
          y={labelAt.y}
          text={opening.label}
          fontSize={OPENING_LABEL_SIZE / scale}
          fontFamily={theme.mono}
          fill={theme.ink}
          width={6}
          offsetX={3}
          offsetY={OPENING_LABEL_SIZE / 2 / scale}
          align="center"
          listening={false}
        />
      )}
      <Group
        x={c.x}
        y={c.y}
        rotation={deg}
        opacity={ghost ? 0.55 : 1}
        listening={interactive}
        cursor={canDrag ? 'move' : 'pointer'}
        draggable={canDrag}
        onDragStart={() => {
          dragging.current = true;
          beginGesture();
        }}
        onDragMove={(e) => {
          const p = e.target.position();
          const desired = (p.x - wall.a.x) * ux + (p.y - wall.a.y) * uy;
          const offset = moveOpening(opening.id, desired, fineStep(currentUnits())) ?? opening.offset;
          e.target.position(at(offset)); // stays on the wall whatever the pointer does
        }}
        onDragEnd={(e) => {
          const now = usePlanStore.getState().openings.find((o) => o.id === opening.id);
          e.target.position(at(now ? now.offset : opening.offset));
          if (!dragging.current) return;
          dragging.current = false;
          endGesture();
        }}
      >
        {/* the gap: paint over the wall stroke */}
        <Rect
          x={-half}
          y={-ht - 0.5 / scale}
          width={w}
          height={thickness + 1 / scale}
          fill={gapFill}
          listening={false}
        />
        {/* jambs */}
        <Line points={[-half, -ht, -half, ht]} stroke={ink} strokeWidth={thin} listening={false} />
        <Line points={[half, -ht, half, ht]} stroke={ink} strokeWidth={thin} listening={false} />

        {opening.type === 'door' ? (
          <>
            {/* leaf + quarter-circle swing; a wide doorway is a pair of leaves meeting in the middle */}
            {(w >= DOUBLE_DOOR_MIN
              ? [
                  { hinge: -half, r: half, dir: 1 },
                  { hinge: half, r: half, dir: -1 },
                ]
              : [{ hinge: -half, r: w, dir: 1 }]
            ).map(({ hinge, r, dir }) => {
              const sweep = dir === 1 ? 1 : 0;
              const arc = `M ${hinge} ${-ht - r} A ${r} ${r} 0 0 ${sweep} ${hinge + dir * r} ${-ht}`;
              return (
                <Group key={hinge} listening={false}>
                  {color && (
                    <Path
                      data={`M ${hinge} ${-ht} L ${arc.slice(2)} Z`}
                      fill={ghost || selected ? theme.accentSoft : theme.swingFill}
                      listening={false}
                    />
                  )}
                  <Line
                    points={[hinge, -ht, hinge, -ht - r]}
                    stroke={color ? ink : soft}
                    strokeWidth={color ? 1.7 / scale : thin}
                    listening={false}
                  />
                  <Path data={arc} stroke={soft} strokeWidth={thin} listening={false} />
                </Group>
              );
            })}
          </>
        ) : color ? (
          <>
            {/* the wall faces carry on across the glass, with one glazing line between */}
            <Line points={[-half, -ht, half, -ht]} stroke={ink} strokeWidth={thin} listening={false} />
            <Line points={[-half, ht, half, ht]} stroke={ink} strokeWidth={thin} listening={false} />
            <Line points={[-half, 0, half, 0]} stroke={soft} strokeWidth={thin / 1.4} listening={false} />
          </>
        ) : (
          <>
            {/* glazing lines */}
            <Line
              points={[-half, -thickness / 6, half, -thickness / 6]}
              stroke={ink}
              strokeWidth={thin}
              listening={false}
            />
            <Line
              points={[-half, thickness / 6, half, thickness / 6]}
              stroke={ink}
              strokeWidth={thin}
              listening={false}
            />
          </>
        )}

        {/* hit + selection area */}
        <Rect
          x={-half}
          y={-ht - 6 / scale}
          width={w}
          height={thickness + 12 / scale}
          fill="transparent"
          onClick={(e) => {
            if (e.evt.button !== 0) return;
            e.cancelBubble = true;
            if (e.evt.shiftKey) toggleOnPlan('openings', opening.id);
            else useUiStore.getState().setOpeningSelection([opening.id]);
          }}
        />
        {selected && (
          <Rect
            x={-half - 2 / scale}
            y={-ht - 4 / scale}
            width={w + 4 / scale}
            height={thickness + 8 / scale}
            stroke={theme.accent}
            strokeWidth={1 / scale}
            dash={[3 / scale, 2 / scale]}
            listening={false}
          />
        )}
      </Group>
    </>
  );
});

/** A small boxed length, centered on `at` and lifted clear of it. */
export function LengthTag({
  at,
  text,
  scale,
  accent = false,
  clear = 0,
}: {
  at: Point;
  text: string;
  scale: number;
  accent?: boolean;
  /** extra lift in meters (half the stroke it sits above) */
  clear?: number;
}) {
  // Approximate the mono text width so the tag can be centered without measuring.
  const width = (text.length * 6.7 + 8) / scale;
  return (
    <Label x={at.x} y={at.y} offsetX={width / 2} offsetY={24 / scale + clear} listening={false}>
      <Tag
        fill={theme.surface}
        stroke={accent ? theme.accent : theme.line}
        strokeWidth={1 / scale}
        cornerRadius={2.5 / scale}
      />
      <Text
        text={text}
        fontFamily={theme.mono}
        fontSize={11 / scale}
        fill={accent ? theme.accent : theme.ink}
        padding={4 / scale}
        width={width}
        align="center"
      />
    </Label>
  );
}

const DIM_FONT_PX = 10;
const DIM_CHAR_PX = 6.1;

/** Quiet length labels beside every wall (key L). */
export const WallDimensions = memo(function WallDimensions({
  walls,
  rooms,
  thickness,
  scale,
  units,
  hiddenIds,
}: {
  walls: Wall[];
  /** room outlines, to put labels outside the building */
  rooms: Point[][];
  thickness: number;
  scale: number;
  units: Units;
  /** walls that already show an editable length tag */
  hiddenIds: string[];
}) {
  return (
    <>
      {walls.map((w) => {
        if (hiddenIds.includes(w.id)) return null;
        const len = dist(w.a, w.b);
        const text = formatLength(len, units);
        const textPx = text.length * DIM_CHAR_PX;
        // A label longer than its wall would run into the neighbours.
        if (len * scale < textPx + 6) return null;
        const side = dimensionSide(w, rooms);
        // Clear of the stroke at any zoom: half the wall (or its 2px minimum) plus a fixed gap.
        const offset = Math.max(thickness / 2, 1 / scale) + (DIM_FONT_PX / 2 + 5) / scale;
        const pose = labelPose(w, side, offset);
        const box = (textPx + 12) / scale;
        return (
          <Text
            key={w.id}
            x={pose.x}
            y={pose.y}
            rotation={pose.rotation}
            text={text}
            fontFamily={theme.mono}
            fontSize={DIM_FONT_PX / scale}
            fill={theme.inkSoft}
            width={box}
            height={DIM_FONT_PX / scale}
            offsetX={box / 2}
            offsetY={DIM_FONT_PX / 2 / scale}
            align="center"
            verticalAlign="middle"
            listening={false}
          />
        );
      })}
    </>
  );
});

/** A dropped measurement: a thin dimension line with end ticks and its length. */
export function MeasureLine({
  a,
  b,
  scale,
  units,
  live = false,
}: {
  a: Point;
  b: Point;
  scale: number;
  units: Units;
  live?: boolean;
}) {
  const len = dist(a, b);
  const thin = 1.2 / scale;
  const tick = 5 / scale;
  const ux = len > 1e-9 ? (b.x - a.x) / len : 1;
  const uy = len > 1e-9 ? (b.y - a.y) / len : 0;
  const ticks = [a, b].map((p) => [p.x - uy * tick, p.y + ux * tick, p.x + uy * tick, p.y - ux * tick]);
  return (
    <>
      <Line
        points={[a.x, a.y, b.x, b.y]}
        stroke={theme.accent}
        strokeWidth={thin}
        dash={live ? [5 / scale, 4 / scale] : undefined}
        opacity={live ? 0.7 : 1}
        listening={false}
      />
      {ticks.map((pts, i) => (
        <Line key={i} points={pts} stroke={theme.accent} strokeWidth={thin} listening={false} />
      ))}
      {len > 1e-6 && <LengthTag at={midpoint(a, b)} text={formatLength(len, units)} scale={scale} accent />}
    </>
  );
}

/** Where the next click will land, ringed when it's an existing corner. */
export function SnapMarker({
  p,
  endpoint,
  scale,
}: {
  p: Point;
  endpoint: boolean;
  scale: number;
}) {
  return (
    <>
      <Circle
        x={p.x}
        y={p.y}
        radius={3 / scale}
        fill={endpoint ? theme.accent : theme.ink}
        listening={false}
      />
      {endpoint && (
        <Circle
          x={p.x}
          y={p.y}
          radius={8 / scale}
          stroke={theme.accent}
          strokeWidth={1.5 / scale}
          listening={false}
        />
      )}
    </>
  );
}
