import { useMemo } from 'react';
import { FURNITURE, customId, isBuiltinKind, isCustomKind, type FurnitureDef, type FurnitureKind } from '../../catalog';
import { buildWallBody } from '../../export/walls';
import { rectCorners } from '../../geometry';
import { detectRooms } from '../../rooms';
import { theme } from '../../theme';
import type { PlanData } from '../../types';
import { roomTone, type DrawingLook } from './look';
import { planShapes } from './symbol';

/** What a thumbnail needs of a plan. Names, settings and custom items are used when they are there. */
export type ThumbPlan = Pick<PlanData, 'walls' | 'openings' | 'furniture'> &
  Partial<Pick<PlanData, 'roomNames' | 'settings' | 'customItems'>>;

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

const path = (loops: { x: number; y: number }[][]): string =>
  loops.map((l) => `M${l.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}Z`).join('');

/** The definition a placed item refers to — from the plan being drawn, never the open one. */
function defOf(plan: ThumbPlan, kind: FurnitureKind): FurnitureDef | null {
  if (isBuiltinKind(kind)) return FURNITURE[kind];
  if (isCustomKind(kind)) return plan.customItems?.[customId(kind)] ?? null;
  return null;
}

/** The colour an item reads as from above: that of its largest visible part. */
function itemColor(def: FurnitureDef): { fill: string; edge: string } {
  let best: { fill: string; edge: string } | null = null;
  let bestArea = -1;
  for (const s of planShapes(def)) {
    if (s.hole) continue;
    let area = 0;
    if (s.kind === 'ellipse') area = Math.PI * s.rx * s.ry;
    else {
      const p = s.points;
      for (let i = 0; i < p.length; i += 2) {
        const j = (i + 2) % p.length;
        area += p[i] * p[j + 1] - p[j] * p[i + 1];
      }
      area = Math.abs(area) / 2;
    }
    if (area > bestArea) {
      bestArea = area;
      best = { fill: s.fill, edge: s.edge };
    }
  }
  return best ?? { fill: theme.surface, edge: theme.furnitureLine };
}

/**
 * A plan drawn small as inline SVG — rooms coloured by what they are, walls as
 * one solid body with real door gaps, glass in the windows, furniture as
 * tinted footprints. Pure: draws the PlanData it is given and reads no store.
 */
export function ThumbSvg({
  plan,
  width = 120,
  height = 90,
  showFurniture = true,
  look = 'color',
}: {
  plan: ThumbPlan;
  width?: number;
  height?: number;
  showFurniture?: boolean;
  look?: DrawingLook;
}) {
  const drawing = useMemo(() => {
    const walls = plan.walls.filter(
      (w) => Number.isFinite(w.a.x) && Number.isFinite(w.a.y) && Number.isFinite(w.b.x) && Number.isFinite(w.b.y),
    );
    if (walls.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const w of walls) {
      for (const p of [w.a, w.b]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const span = Math.max(maxX - minX, maxY - minY, 1);
    // True thickness, but never so thin that the walls stop reading as solid at this size.
    const thickness = Math.max(plan.settings?.wallThickness ?? 0.15, span / 55);
    const pad = thickness / 2 + span * 0.035;
    const vb = `${n(minX - pad)} ${n(minY - pad)} ${n(maxX - minX + 2 * pad)} ${n(maxY - minY + 2 * pad)}`;
    const color = look === 'color';

    const rooms = detectRooms(walls).map((r) => ({
      d: path([r.polygon]),
      fill: color ? roomTone(plan.roomNames?.[r.key]).fill : 'rgba(33, 31, 27, 0.06)',
    }));

    const body = buildWallBody(walls, plan.openings, thickness);
    const windows = body.gaps
      .filter((g) => g.type === 'window')
      .map((g) => ({
        x1: n(g.center.x - (g.dir.x * g.width) / 2),
        y1: n(g.center.y - (g.dir.y * g.width) / 2),
        x2: n(g.center.x + (g.dir.x * g.width) / 2),
        y2: n(g.center.y + (g.dir.y * g.width) / 2),
      }));

    const items = showFurniture
      ? plan.furniture.flatMap((f) => {
          const def = defOf(plan, f.kind);
          if (!def || !Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.rotation)) return [];
          const tone = color ? itemColor(def) : { fill: theme.surface, edge: theme.furnitureLine };
          return [{ d: path([rectCorners(f.x, f.y, def.w, def.d, f.rotation)]), flat: def.h <= 0.06, ...tone }];
        })
      : [];
    items.sort((a, b) => Number(b.flat) - Number(a.flat)); // rugs under everything else

    return { vb, thickness, rooms, walls: path(body.loops), windows, items, color };
  }, [plan, showFurniture, look]);

  if (!drawing) {
    return <svg width={width} height={height} role="img" aria-label="Empty plan" />;
  }
  const { vb, thickness, rooms, walls, windows, items, color } = drawing;
  return (
    <svg
      width={width}
      height={height}
      viewBox={vb}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Plan preview"
      style={{ display: 'block' }}
    >
      <g data-part="rooms">
        {rooms.map((r, i) => (
          <path key={i} d={r.d} fill={r.fill} />
        ))}
      </g>
      <g data-part="furniture" strokeWidth={thickness * 0.14} strokeLinejoin="round">
        {items.map((f, i) => (
          <path key={i} d={f.d} fill={f.fill} stroke={f.edge} />
        ))}
      </g>
      <path data-part="walls" d={walls} fill={theme.ink} />
      <g data-part="windows">
        {windows.map((g, i) => (
          <g key={i}>
            <line {...g} stroke={color ? theme.glass : theme.surface} strokeWidth={thickness} />
            <line {...g} stroke={theme.ink} strokeWidth={thickness * 0.22} />
          </g>
        ))}
      </g>
    </svg>
  );
}
