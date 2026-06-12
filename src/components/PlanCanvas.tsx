import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Label, Layer, Line, Path, Rect, Stage, Tag, Text } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import {
  clampOffset,
  DEFAULT_OPENING_WIDTH,
  openingFits,
  usePlanStore,
  type EndpointRef,
} from '../store';
import { useUiStore } from '../uiStore';
import {
  dist,
  formatMeters,
  midpoint,
  nearestWallPoint,
  ptEq,
  snapPoint,
  wallAngle,
  type SnapResult,
} from '../geometry';
import { detectRooms, type DetectedRoom } from '../rooms';
import type { Opening, OpeningType, Point, Wall } from '../types';
import { theme } from '../theme';

interface OpeningGhost {
  wallId: string;
  offset: number;
  valid: boolean;
}

declare global {
  interface Window {
    __view?: View;
  }
}

interface View {
  /** px per meter */ scale: number;
  /** px */ tx: number;
  /** px */ ty: number;
}

const MIN_SCALE = 16;
const MAX_SCALE = 320;
const SNAP_RADIUS_PX = 12;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** Where a door/window would land for a pointer position; reads the store directly. */
function computeGhost(raw: Point, type: OpeningType, scale: number): OpeningGhost | null {
  const { walls, openings } = usePlanStore.getState();
  const hit = nearestWallPoint(raw, walls);
  const threshold = Math.max(0.3, 16 / scale);
  if (!hit || hit.dist >= threshold) return null;
  const wall = walls.find((w) => w.id === hit.wallId)!;
  const width = DEFAULT_OPENING_WIDTH[type];
  const offset = clampOffset(wall, hit.offset, width);
  const valid =
    dist(wall.a, wall.b) > width + 0.15 && openingFits(openings, wall, offset, width);
  return { wallId: hit.wallId, offset, valid };
}

export function PlanCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 60, tx: 0, ty: 0 });
  const viewInitialized = useRef(false);

  const walls = usePlanStore((s) => s.walls);
  const openings = usePlanStore((s) => s.openings);
  const settings = usePlanStore((s) => s.settings);
  const tool = useUiStore((s) => s.tool);
  const selectedWallIds = useUiStore((s) => s.selectedWallIds);
  const selectedOpeningIds = useUiStore((s) => s.selectedOpeningIds);
  const [ghost, setGhost] = useState<OpeningGhost | null>(null);

  // Drawing state: the pending polyline anchor and the live (snapped) cursor.
  // The anchor lives in a ref (updated synchronously, so rapid clicks in one
  // frame chain correctly) and is mirrored to state for rendering.
  const [anchor, _setAnchor] = useState<Point | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const anchorRef = useRef<Point | null>(null);
  const setAnchor = (p: Point | null) => {
    anchorRef.current = p;
    _setAnchor(p);
    if (!p) useUiStore.getState().setDrawingLength(null);
  };

  const [hoverWallId, setHoverWallId] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ x: number; y: number } | null>(null);

  // --- container resize ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      if (!viewInitialized.current && r.width > 0) {
        viewInitialized.current = true;
        setView((v) => ({ ...v, tx: r.width / 2, ty: r.height / 2 }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- keyboard ---
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const ui = useUiStore.getState();
      if (ui.mode !== 'plan') return;
      const plan = usePlanStore.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      switch (e.key) {
        case 'Escape':
          if (anchorRef.current) setAnchor(null);
          else ui.setTool('select');
          break;
        case 'Enter':
          setAnchor(null);
          break;
        case 'v':
        case 'V':
          ui.setTool('select');
          break;
        case 'w':
        case 'W':
          setAnchor(null);
          ui.setTool('wall');
          break;
        case 'd':
        case 'D':
          ui.setTool('door');
          break;
        case 'n':
        case 'N':
          ui.setTool('window');
          break;
        case 'Delete':
        case 'Backspace':
          if (ui.selectedWallIds.length) plan.deleteWalls(ui.selectedWallIds);
          if (ui.selectedOpeningIds.length) plan.deleteOpenings(ui.selectedOpeningIds);
          if (ui.selectedWallIds.length || ui.selectedOpeningIds.length) ui.setSelection([]);
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Drop the pending anchor when leaving the wall tool.
  useEffect(() => {
    return useUiStore.subscribe((s, prev) => {
      if (s.tool !== prev.tool && s.tool !== 'wall') setAnchor(null);
    });
  }, []);

  const toWorld = (sx: number, sy: number): Point => ({
    x: (sx - view.tx) / view.scale,
    y: (sy - view.ty) / view.scale,
  });

  const snapRadiusM = SNAP_RADIUS_PX / view.scale;

  // --- pointer handlers ---
  const handleMouseMove = () => {
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    if (panRef.current) {
      setView((v) => ({
        ...v,
        tx: v.tx + (pos.x - panRef.current!.x),
        ty: v.ty + (pos.y - panRef.current!.y),
      }));
      panRef.current = { x: pos.x, y: pos.y };
      return;
    }

    const raw = toWorld(pos.x, pos.y);
    const ui = useUiStore.getState();

    if (tool === 'door' || tool === 'window') {
      setGhost(computeGhost(raw, tool, view.scale));
      setSnap(null);
      ui.setCursor(raw);
      ui.setDrawingLength(null);
      return;
    }

    const result = snapPoint(raw, walls, settings.gridSize, snapRadiusM);
    setSnap(result);
    ui.setCursor(result.p);
    ui.setDrawingLength(anchorRef.current ? dist(anchorRef.current, result.p) : null);
  };

  const handleMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    // Middle mouse or space+drag pans regardless of tool.
    if (e.evt.button === 1 || spaceDown) {
      e.evt.preventDefault();
      panRef.current = { x: pos.x, y: pos.y };
      setPanning(true);
      return;
    }
    if (e.evt.button !== 0) return;

    if (tool === 'wall') {
      // Read walls from the store (not the render closure) so rapid clicks
      // snap against walls created moments ago.
      const plan = usePlanStore.getState();
      const raw = toWorld(pos.x, pos.y);
      const { p } = snapPoint(raw, plan.walls, plan.settings.gridSize, snapRadiusM);
      const a = anchorRef.current;
      if (!a) {
        setAnchor(p);
      } else if (!ptEq(a, p)) {
        plan.addWall(a, p);
        setAnchor(p);
      }
      return;
    }

    if (tool === 'door' || tool === 'window') {
      // Recompute from the pointer (not the rendered ghost) so a click in the
      // same frame as a mouse move can't place against stale state.
      const g = computeGhost(toWorld(pos.x, pos.y), tool, view.scale);
      if (g?.valid) {
        usePlanStore.getState().addOpening(g.wallId, tool, g.offset, DEFAULT_OPENING_WIDTH[tool]);
      }
      return;
    }

    // Select tool: clicking bare canvas clears the selection.
    if (tool === 'select' && e.target === stage) {
      useUiStore.getState().setSelection([]);
    }
  };

  const handleMouseUp = () => {
    panRef.current = null;
    setPanning(false);
  };

  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Pinch / cmd+scroll zooms about the cursor.
      const factor = Math.exp(-e.evt.deltaY * 0.0022);
      setView((v) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
        const wx = (pos.x - v.tx) / v.scale;
        const wy = (pos.y - v.ty) / v.scale;
        return { scale, tx: pos.x - wx * scale, ty: pos.y - wy * scale };
      });
    } else {
      setView((v) => ({ ...v, tx: v.tx - e.evt.deltaX, ty: v.ty - e.evt.deltaY }));
    }
  };

  const handleMouseLeave = () => {
    setSnap(null);
    setGhost(null);
    const ui = useUiStore.getState();
    ui.setCursor(null);
    ui.setDrawingLength(null);
  };

  // Finish a wall run on right-click instead of showing a context menu.
  const handleContextMenu = (e: KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
    setAnchor(null);
  };

  const cursorStyle = panning
    ? 'grabbing'
    : spaceDown
      ? 'grab'
      : tool !== 'select'
        ? 'crosshair'
        : 'default';

  const grid = useMemo(
    () => buildGridLines(view, size, settings.gridSize),
    [view, size, settings.gridSize],
  );

  const rooms = useMemo(() => detectRooms(walls), [walls]);
  const [editingRoomKey, setEditingRoomKey] = useState<string | null>(null);

  // Test/debug hook: lets tooling map world coords → screen exactly.
  if (import.meta.env.DEV) window.__view = view;

  const px = (n: number) => n / view.scale; // px → m at current zoom

  return (
    <div ref={containerRef} className="plan-canvas" style={{ cursor: cursorStyle }}>
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        x={view.tx}
        y={view.ty}
        scaleX={view.scale}
        scaleY={view.scale}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      >
        <Layer listening={false}>
          {grid.minor.map((pts, i) => (
            <Line key={`m${i}`} points={pts} stroke={theme.gridMinor} strokeWidth={px(1)} />
          ))}
          {grid.major.map((pts, i) => (
            <Line key={`M${i}`} points={pts} stroke={theme.gridMajor} strokeWidth={px(1)} />
          ))}
          {grid.axes.map((pts, i) => (
            <Line key={`A${i}`} points={pts} stroke={theme.gridAxis} strokeWidth={px(1)} />
          ))}
        </Layer>

        <Layer>
          {rooms.map((room) => (
            <Line
              key={room.key}
              points={room.polygon.flatMap((p) => [p.x, p.y])}
              closed
              fill={theme.roomFill}
              listening={tool === 'select'}
              onDblClick={() => setEditingRoomKey(room.key)}
            />
          ))}

          {walls.map((w) => (
            <WallLine
              key={w.id}
              wall={w}
              thickness={settings.wallThickness}
              scale={view.scale}
              selected={selectedWallIds.includes(w.id)}
              hovered={hoverWallId === w.id}
              interactive={tool === 'select'}
              onHover={(h) => setHoverWallId(h ? w.id : null)}
            />
          ))}

          {openings.map((o) => {
            const wall = walls.find((w) => w.id === o.wallId);
            if (!wall) return null;
            return (
              <OpeningShape
                key={o.id}
                wall={wall}
                opening={o}
                thickness={settings.wallThickness}
                scale={view.scale}
                selected={selectedOpeningIds.includes(o.id)}
                interactive={tool === 'select'}
              />
            );
          })}

          {/* placement ghost */}
          {(tool === 'door' || tool === 'window') && ghost?.valid && (() => {
            const wall = walls.find((w) => w.id === ghost.wallId);
            if (!wall) return null;
            return (
              <OpeningShape
                wall={wall}
                opening={{
                  id: '__ghost',
                  wallId: ghost.wallId,
                  type: tool,
                  offset: ghost.offset,
                  width: DEFAULT_OPENING_WIDTH[tool],
                }}
                thickness={settings.wallThickness}
                scale={view.scale}
                selected={false}
                interactive={false}
                ghost
              />
            );
          })()}

          {tool === 'select' &&
            selectedWallIds.map((id) => {
              const w = walls.find((x) => x.id === id);
              if (!w) return null;
              return <SelectedWallOverlay key={id} wall={w} scale={view.scale} snapRadiusM={snapRadiusM} />;
            })}

          {/* drawing preview */}
          {tool === 'wall' && anchor && snap && (
            <>
              <Line
                points={[anchor.x, anchor.y, snap.p.x, snap.p.y]}
                stroke={theme.accent}
                strokeWidth={Math.max(settings.wallThickness, px(1.5))}
                opacity={0.55}
                lineCap="round"
                dash={[px(6), px(5)]}
                listening={false}
              />
              <LengthTag
                at={midpoint(anchor, snap.p)}
                text={formatMeters(dist(anchor, snap.p))}
                scale={view.scale}
                accent
              />
            </>
          )}
          {tool === 'wall' && anchor && (
            <Circle
              x={anchor.x}
              y={anchor.y}
              radius={px(3.5)}
              fill={theme.accent}
              listening={false}
            />
          )}

          {/* snapped cursor indicator */}
          {tool === 'wall' && snap && (
            <>
              <Circle
                x={snap.p.x}
                y={snap.p.y}
                radius={px(3)}
                fill={snap.kind === 'endpoint' ? theme.accent : theme.ink}
                listening={false}
              />
              {snap.kind === 'endpoint' && (
                <Circle
                  x={snap.p.x}
                  y={snap.p.y}
                  radius={px(8)}
                  stroke={theme.accent}
                  strokeWidth={px(1.5)}
                  listening={false}
                />
              )}
            </>
          )}
        </Layer>
      </Stage>

      {/* Room labels live in HTML so they stay readable at any zoom. */}
      {rooms.map((room) => (
        <RoomLabel
          key={room.key}
          room={room}
          view={view}
          interactive={tool === 'select'}
          editing={editingRoomKey === room.key}
          onStartEdit={() => setEditingRoomKey(room.key)}
          onEndEdit={() => setEditingRoomKey(null)}
        />
      ))}

      {tool === 'select' && selectedOpeningIds.length === 1 && (() => {
        const o = openings.find((x) => x.id === selectedOpeningIds[0]);
        const wall = o && walls.find((w) => w.id === o.wallId);
        if (!o || !wall) return null;
        return <OpeningInspector opening={o} wall={wall} view={view} />;
      })()}
    </div>
  );
}

function OpeningInspector({
  opening,
  wall,
  view,
}: {
  opening: Opening;
  wall: Wall;
  view: View;
}) {
  const updateOpeningWidth = usePlanStore((s) => s.updateOpeningWidth);
  const deleteOpenings = usePlanStore((s) => s.deleteOpenings);
  const setOpeningSelection = useUiStore((s) => s.setOpeningSelection);

  const len = dist(wall.a, wall.b);
  const t = opening.offset / len;
  const cx = wall.a.x + (wall.b.x - wall.a.x) * t;
  const cy = wall.a.y + (wall.b.y - wall.a.y) * t;
  const sx = cx * view.scale + view.tx;
  const sy = cy * view.scale + view.ty;

  return (
    <div className="opening-inspector" style={{ left: sx, top: sy - 34 }}>
      <span className="oi-type">{opening.type}</span>
      <input
        type="number"
        value={opening.width}
        min={0.4}
        max={Math.max(0.4, len - 0.1)}
        step={0.1}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) updateOpeningWidth(opening.id, v);
        }}
      />
      <span className="oi-unit">m</span>
      <button
        className="oi-delete"
        title="Delete opening"
        onClick={() => {
          deleteOpenings([opening.id]);
          setOpeningSelection([]);
        }}
      >
        ✕
      </button>
    </div>
  );
}

function RoomLabel({
  room,
  view,
  interactive,
  editing,
  onStartEdit,
  onEndEdit,
}: {
  room: DetectedRoom;
  view: View;
  interactive: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
}) {
  const name = usePlanStore((s) => s.roomNames[room.key]);
  const setRoomName = usePlanStore((s) => s.setRoomName);

  const sx = room.centroid.x * view.scale + view.tx;
  const sy = room.centroid.y * view.scale + view.ty;

  if (editing) {
    return (
      <input
        className="room-name-input"
        style={{ left: sx, top: sy }}
        defaultValue={name ?? ''}
        placeholder="Room name"
        autoFocus
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            (e.target as HTMLInputElement).value = name ?? '';
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
        onBlur={(e) => {
          setRoomName(room.key, e.target.value);
          onEndEdit();
        }}
      />
    );
  }

  return (
    <div
      className={`room-label ${interactive ? 'interactive' : ''}`}
      style={{ left: sx, top: sy }}
      onDoubleClick={interactive ? onStartEdit : undefined}
      title={interactive ? 'Double-click to rename' : undefined}
    >
      <span className={`room-name ${name ? '' : 'unnamed'}`}>{name ?? 'Room'}</span>
      <span className="room-area">{room.area.toFixed(1)} m²</span>
    </div>
  );
}

function WallLine({
  wall,
  thickness,
  scale,
  selected,
  hovered,
  interactive,
  onHover,
}: {
  wall: Wall;
  thickness: number;
  scale: number;
  selected: boolean;
  hovered: boolean;
  interactive: boolean;
  onHover: (h: boolean) => void;
}) {
  const stroke = selected ? theme.accent : hovered && interactive ? '#4A463E' : theme.ink;
  return (
    <Line
      points={[wall.a.x, wall.a.y, wall.b.x, wall.b.y]}
      stroke={stroke}
      strokeWidth={Math.max(thickness, 2 / scale)}
      lineCap="square"
      hitStrokeWidth={Math.max(thickness, 14 / scale)}
      listening={interactive}
      onClick={(e) => {
        if (e.evt.button !== 0) return;
        const ui = useUiStore.getState();
        if (e.evt.shiftKey) ui.toggleSelected(wall.id);
        else ui.setSelection([wall.id]);
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    />
  );
}

/** Accent endpoint handles + a length tag for a selected wall. */
function SelectedWallOverlay({
  wall,
  scale,
  snapRadiusM,
}: {
  wall: Wall;
  scale: number;
  snapRadiusM: number;
}) {
  const mid = midpoint(wall.a, wall.b);
  return (
    <>
      <LengthTag at={mid} text={formatMeters(dist(wall.a, wall.b))} scale={scale} />
      <EndpointHandle wall={wall} end="a" scale={scale} snapRadiusM={snapRadiusM} />
      <EndpointHandle wall={wall} end="b" scale={scale} snapRadiusM={snapRadiusM} />
    </>
  );
}

/** Plan symbol for a door (swing arc) or window (glazing lines), drawn in the wall's local frame. */
function OpeningShape({
  wall,
  opening,
  thickness,
  scale,
  selected,
  interactive,
  ghost = false,
}: {
  wall: Wall;
  opening: Opening;
  thickness: number;
  scale: number;
  selected: boolean;
  interactive: boolean;
  ghost?: boolean;
}) {
  const len = dist(wall.a, wall.b);
  if (len < 1e-6) return null;
  const t = opening.offset / len;
  const cx = wall.a.x + (wall.b.x - wall.a.x) * t;
  const cy = wall.a.y + (wall.b.y - wall.a.y) * t;
  const deg = (wallAngle(wall) * 180) / Math.PI;

  const w = opening.width;
  const half = w / 2;
  const ht = thickness / 2;
  const thin = 1.2 / scale;
  const ink = ghost ? theme.accent : selected ? theme.accent : theme.ink;
  const soft = ghost ? theme.accent : selected ? theme.accent : theme.inkSoft;

  return (
    <Group x={cx} y={cy} rotation={deg} opacity={ghost ? 0.55 : 1} listening={interactive}>
      {/* the gap: paint over the wall stroke */}
      <Rect
        x={-half}
        y={-ht - 0.5 / scale}
        width={w}
        height={thickness + 1 / scale}
        fill={theme.paper}
        listening={false}
      />
      {/* jambs */}
      <Line points={[-half, -ht, -half, ht]} stroke={ink} strokeWidth={thin} listening={false} />
      <Line points={[half, -ht, half, ht]} stroke={ink} strokeWidth={thin} listening={false} />

      {opening.type === 'door' ? (
        <>
          {/* leaf + quarter-circle swing */}
          <Line
            points={[-half, -ht, -half, -ht - w]}
            stroke={soft}
            strokeWidth={thin}
            listening={false}
          />
          <Path
            data={`M ${-half} ${-ht - w} A ${w} ${w} 0 0 1 ${half} ${-ht}`}
            stroke={soft}
            strokeWidth={thin}
            listening={false}
          />
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
          useUiStore.getState().setOpeningSelection([opening.id]);
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
  );
}

function EndpointHandle({
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
  // The junction (all endpoints coincident at drag start) is frozen here so the
  // corner moves as one and we never weld onto walls merely passed over.
  const junctionRefs = useRef<EndpointRef[]>([]);

  return (
    <Circle
      x={pt.x}
      y={pt.y}
      radius={5.5 / scale}
      fill={theme.surface}
      stroke={theme.accent}
      strokeWidth={1.5 / scale}
      draggable
      onDragStart={() => {
        const { walls } = usePlanStore.getState();
        const refs: EndpointRef[] = [];
        for (const w of walls) {
          if (ptEq(w.a, pt)) refs.push({ wallId: w.id, end: 'a' });
          if (ptEq(w.b, pt)) refs.push({ wallId: w.id, end: 'b' });
        }
        junctionRefs.current = refs;
      }}
      onDragMove={(e) => {
        const plan = usePlanStore.getState();
        const refs = junctionRefs.current;
        const raw = e.target.position();
        const isOwn = (wallId: string, e2: 'a' | 'b') =>
          refs.some((r) => r.wallId === wallId && r.end === e2);
        const { p } = snapPoint(raw, plan.walls, plan.settings.gridSize, snapRadiusM, isOwn);
        e.target.position(p);
        plan.moveEndpoints(refs, p);
      }}
      onDragEnd={() => {
        const removed = usePlanStore.getState().cleanupWalls();
        if (removed.length) {
          const ui = useUiStore.getState();
          ui.setSelection(ui.selectedWallIds.filter((id) => !removed.includes(id)));
        }
        junctionRefs.current = [];
      }}
      onMouseEnter={(e) => {
        const stage = e.target.getStage();
        if (stage) stage.container().style.cursor = 'move';
      }}
      onMouseLeave={(e) => {
        const stage = e.target.getStage();
        if (stage) stage.container().style.cursor = '';
      }}
    />
  );
}

function LengthTag({
  at,
  text,
  scale,
  accent = false,
}: {
  at: Point;
  text: string;
  scale: number;
  accent?: boolean;
}) {
  return (
    <Label x={at.x} y={at.y} offsetY={20 / scale} listening={false}>
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
      />
    </Label>
  );
}

function buildGridLines(
  view: View,
  size: { w: number; h: number },
  gridSize: number,
): { minor: number[][]; major: number[][]; axes: number[][] } {
  const minor: number[][] = [];
  const major: number[][] = [];
  const axes: number[][] = [];
  if (size.w === 0 || size.h === 0) return { minor, major, axes };

  const x0 = (0 - view.tx) / view.scale;
  const x1 = (size.w - view.tx) / view.scale;
  const y0 = (0 - view.ty) / view.scale;
  const y1 = (size.h - view.ty) / view.scale;

  const showMinor = gridSize * view.scale >= 7;
  const isMajor = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;

  for (let i = Math.floor(x0 / gridSize); i <= Math.ceil(x1 / gridSize); i++) {
    const x = i * gridSize;
    const pts = [x, y0, x, y1];
    if (x === 0) axes.push(pts);
    else if (isMajor(x)) major.push(pts);
    else if (showMinor) minor.push(pts);
  }
  for (let j = Math.floor(y0 / gridSize); j <= Math.ceil(y1 / gridSize); j++) {
    const y = j * gridSize;
    const pts = [x0, y, x1, y];
    if (y === 0) axes.push(pts);
    else if (isMajor(y)) major.push(pts);
    else if (showMinor) minor.push(pts);
  }
  return { minor, major, axes };
}
