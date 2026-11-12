/**
 * The plan sheet: a plan turned into drawing primitives on a sheet of paper.
 *
 * Everything is in paper millimetres (origin top-left, y down), so the same
 * sheet becomes an SVG, a PNG or a PDF page without redrawing anything. The
 * page and scale are chosen to fit: A4 or A3 for metric plans, Letter or
 * Tabloid for imperial ones, at the largest standard scale that fits.
 *
 * Pure: no store, no DOM — except that, when no look is asked for, the sheet
 * follows the canvas's saved Color / Paper preference.
 */
import { readDrawingLook, roomTone, type DrawingLook } from '../components/plan/look';
import { pointInPolygon } from '../geometry';
import { theme } from '../theme';
import type { PlanData, Point, Units } from '../types';
import { formatArea, formatLength, formatLengthShort } from '../units';
import { buildModel, doorSwings, drawnExtent, type PlanModel } from './model';
import { fitText, formatDate, textWidth } from './text';

export type Font = 'regular' | 'bold';

export type Prim =
  | {
      t: 'path';
      /** One or more outlines, each flat [x0, y0, x1, y1, …]. Filled with the non-zero rule. */
      loops: number[][];
      closed: boolean;
      fill?: string;
      stroke?: string;
      /** stroke width, mm */ sw?: number;
      dash?: number[];
    }
  | {
      t: 'arc';
      cx: number;
      cy: number;
      r: number;
      /** Radians, measured clockwise on the page from +x; drawn from a0 to a1. */
      a0: number;
      a1: number;
      stroke: string;
      sw: number;
    }
  | { t: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; sw?: number; dash?: number[] }
  | {
      t: 'text';
      x: number;
      /** baseline */ y: number;
      text: string;
      /** mm */ size: number;
      font?: Font;
      anchor?: 'start' | 'middle' | 'end';
      /** degrees clockwise about (x, y) */ rot?: number;
      fill: string;
      /** extra space per character, mm */ tracking?: number;
      href?: string;
    };

export interface Layer {
  id: string;
  title: string;
  prims: Prim[];
}

export interface Page {
  name: string;
  /** mm */ w: number;
  h: number;
}

export interface Sheet {
  title: string;
  page: Page;
  layers: Layer[];
  /** "1:100" · "1/4″ = 1′" — empty on sheets that are not to scale. */
  scaleLabel: string;
  /** Real size ÷ drawn size. */
  ratio: number;
}

export interface SheetOptions {
  /** Shown in the title block. Defaults to today. */
  date?: Date;
  /** 'color' tints each room by what it is, as on the canvas; 'paper' leaves the sheet white. Defaults to the saved preference. */
  look?: DrawingLook;
}

export const INK = theme.ink;
export const SOFT = theme.inkSoft;
const FURNITURE_INK = '#8d8779';
const WHITE = '#ffffff';

const PAGES: Record<Units, [Page, Page]> = {
  m: [
    { name: 'A4', w: 297, h: 210 },
    { name: 'A3', w: 420, h: 297 },
  ],
  ft: [
    { name: 'Letter', w: 279.4, h: 215.9 },
    { name: 'Tabloid', w: 431.8, h: 279.4 },
  ],
};

interface Scale {
  ratio: number;
  label: string;
}

const METRIC_SCALES: Scale[] = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 2000, 2500, 5000].map(
  (ratio) => ({ ratio, label: `1:${ratio}` }),
);
const IMPERIAL_SCALES: Scale[] = [
  { ratio: 12, label: '1″ = 1′' },
  { ratio: 16, label: '3/4″ = 1′' },
  { ratio: 24, label: '1/2″ = 1′' },
  { ratio: 32, label: '3/8″ = 1′' },
  { ratio: 48, label: '1/4″ = 1′' },
  { ratio: 64, label: '3/16″ = 1′' },
  { ratio: 96, label: '1/8″ = 1′' },
  { ratio: 128, label: '3/32″ = 1′' },
  { ratio: 192, label: '1/16″ = 1′' },
  { ratio: 240, label: '1″ = 20′' },
  { ratio: 360, label: '1″ = 30′' },
  { ratio: 480, label: '1″ = 40′' },
  { ratio: 600, label: '1″ = 50′' },
  { ratio: 1200, label: '1″ = 100′' },
  { ratio: 2400, label: '1″ = 200′' },
  { ratio: 6000, label: '1″ = 500′' },
];
/** A plan that fits the small page at this scale or larger stays on the small page. */
const COMFORTABLE: Record<Units, number> = { m: 100, ft: 96 };

export const MARGIN = 10;
const STRIP = 15;
const INSET = 5;
const TIER = 7;
const DIM_TEXT = 2.1;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Baseline that centers text of `size` on `yc`. */
const midline = (yc: number, size: number): number => yc + size * 0.36;

export function rectLoop(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

export const line = (x0: number, y0: number, x1: number, y1: number, stroke: string, sw: number): Prim => ({
  t: 'path',
  loops: [[x0, y0, x1, y1]],
  closed: false,
  stroke,
  sw,
});

/** Frame + title strip shared by every sheet. Returns the strip's top edge. */
export function sheetFrame(page: Page, prims: Prim[]): number {
  prims.push({ t: 'path', loops: [rectLoop(0, 0, page.w, page.h)], closed: true, fill: WHITE });
  prims.push({
    t: 'path',
    loops: [rectLoop(MARGIN, MARGIN, page.w - MARGIN, page.h - MARGIN)],
    closed: true,
    stroke: INK,
    sw: 0.35,
  });
  const top = page.h - MARGIN - STRIP;
  prims.push(line(MARGIN, top, page.w - MARGIN, top, INK, 0.35));
  return top;
}

/** One labelled cell of the title strip. */
export function stripCell(
  prims: Prim[],
  x0: number,
  x1: number,
  top: number,
  label: string,
  value: string,
  opts: { size?: number; bold?: boolean; rule?: boolean } = {},
): void {
  const size = opts.size ?? 3.3;
  if (opts.rule !== false) prims.push(line(x0, top, x0, top + STRIP, INK, 0.18));
  prims.push({ t: 'text', x: x0 + 3, y: top + 4.7, text: label.toUpperCase(), size: 1.7, fill: SOFT, tracking: 0.22 });
  prims.push({
    t: 'text',
    x: x0 + 3,
    y: top + 11.2,
    text: fitText(value, x1 - x0 - 6, size, !!opts.bold),
    size,
    ...(opts.bold ? { font: 'bold' as const } : {}),
    fill: INK,
  });
}

function pickScale(units: Units, widthM: number, heightM: number, availW: number, availH: number): Scale {
  const need = Math.max((widthM * 1000) / Math.max(1, availW), (heightM * 1000) / Math.max(1, availH));
  const list = units === 'ft' ? IMPERIAL_SCALES : METRIC_SCALES;
  return list.find((s) => s.ratio >= need - 1e-9) ?? list[list.length - 1];
}

/** A round real-world length whose bar is no longer than `maxMm` on paper. */
function scaleBarLength(units: Units, mmPerM: number, maxMm: number): number {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const unit = units === 'ft' ? 0.3048 : 1;
  let best = steps[0] * unit;
  for (const s of steps) if (s * unit * mmPerM <= maxMm) best = s * unit;
  return best;
}

export function buildSheet(plan: PlanData, opts: SheetOptions = {}): Sheet {
  return buildSheetFromModel(buildModel(plan), opts);
}

export function buildSheetFromModel(model: PlanModel, opts: SheetOptions = {}): Sheet {
  const units = model.units;
  const half = model.body.thickness / 2;

  // What has to fit on the page: walls, door swings, furniture.
  const doors = doorSwings(model);
  const ext = drawnExtent(model, doors);
  const widthM = Math.max(0.5, ext.maxX - ext.minX);
  const heightM = Math.max(0.5, ext.maxY - ext.minY);

  // Room around the plan for the dimension strings.
  const has = (side: string) => model.chains.some((c) => c.side === side);
  const measurable = model.body.graph.edges.length > 0;
  const tierPad = (tiers: number) => (tiers > 0 ? tiers * TIER + 4.5 : 3);
  const pad = {
    n: tierPad((measurable ? 1 : 0) + (has('N') ? 1 : 0)),
    w: tierPad((measurable ? 1 : 0) + (has('W') ? 1 : 0)),
    s: tierPad(has('S') ? 1 : 0),
    e: tierPad(has('E') ? 1 : 0),
  };

  // Page and scale.
  const fit = (page: Page) => {
    const availW = page.w - 2 * (MARGIN + INSET) - pad.w - pad.e;
    const availH = page.h - 2 * (MARGIN + INSET) - STRIP - pad.n - pad.s;
    return { page, availW, availH, scale: pickScale(units, widthM, heightM, availW, availH) };
  };
  const [small, large] = PAGES[units];
  let chosen = fit(small);
  if (chosen.scale.ratio > COMFORTABLE[units]) chosen = fit(large);
  const { page, availW, availH, scale } = chosen;
  const k = 1000 / scale.ratio;

  const ox = MARGIN + INSET + pad.w + (availW - widthM * k) / 2;
  const oy = MARGIN + INSET + pad.n + (availH - heightM * k) / 2;
  const X = (x: number): number => r3(ox + (x - ext.minX) * k);
  const Y = (y: number): number => r3(oy + (y - ext.minY) * k);
  const flat = (pts: Point[]): number[] => pts.flatMap((p) => [X(p.x), Y(p.y)]);

  // ----- sheet -----
  const sheetPrims: Prim[] = [];
  const stripTop = sheetFrame(page, sheetPrims);

  // ----- room fills (Color look) -----
  // To the wall centerlines; the wall body drawn later covers the edges.
  const roomFills: Prim[] = [];
  const tint = new Map<string, string>();
  if ((opts.look ?? readDrawingLook()) === 'color') {
    for (const room of model.rooms) {
      if (room.polygon.length < 3) continue;
      const fill = roomTone(room.named ? room.name : null).fill;
      tint.set(room.key, fill);
      roomFills.push({ t: 'path', loops: [flat(room.polygon)], closed: true, fill });
    }
  }
  /** What is behind a point on the plan: its room's tint, or the white sheet. */
  const groundAt = (p: Point): string => {
    if (tint.size === 0) return WHITE;
    const room = model.rooms.find((r) => pointInPolygon(p, r.polygon));
    return (room && tint.get(room.key)) || WHITE;
  };

  // ----- furniture -----
  const furniture: Prim[] = [];
  for (const f of model.furniture) {
    for (const s of f.symbol) {
      const sw = s.light ? 0.11 : 0.18;
      const dash = s.dash ? { dash: [0.9, 0.7] } : {};
      if (s.k === 'circle') {
        furniture.push({ t: 'circle', cx: X(s.c.x), cy: Y(s.c.y), r: r3(s.r * k), stroke: FURNITURE_INK, sw, ...dash });
      } else {
        furniture.push({ t: 'path', loops: [flat(s.pts)], closed: s.closed, stroke: FURNITURE_INK, sw, ...dash });
      }
    }
  }

  // ----- walls -----
  const walls: Prim[] = [];
  if (model.body.loops.length > 0) {
    walls.push({ t: 'path', loops: model.body.loops.map(flat), closed: true, fill: INK });
  }

  // ----- windows -----
  const windows: Prim[] = [];
  for (const g of model.openings) {
    if (g.type !== 'window') continue;
    const hw = g.width / 2;
    const at = (along: number, across: number): number[] => [
      X(g.center.x + g.dir.x * along + g.normal.x * across),
      Y(g.center.y + g.dir.y * along + g.normal.y * across),
    ];
    for (const across of [half, -half]) {
      windows.push({ t: 'path', loops: [[...at(-hw, across), ...at(hw, across)]], closed: false, stroke: INK, sw: 0.18 });
    }
    windows.push({ t: 'path', loops: [[...at(-hw, 0), ...at(hw, 0)]], closed: false, stroke: INK, sw: 0.11 });
  }

  // ----- doors -----
  const doorPrims: Prim[] = [];
  for (const { gap: g, hinge, tip } of doors) {
    doorPrims.push(line(X(hinge.x), Y(hinge.y), X(tip.x), Y(tip.y), INK, 0.25));
    const a = Math.atan2(g.dir.y, g.dir.x);
    doorPrims.push({ t: 'arc', cx: X(hinge.x), cy: Y(hinge.y), r: r3(g.width * k), a0: a - Math.PI / 2, a1: a, stroke: SOFT, sw: 0.13 });
  }

  // ----- labels -----
  // Text is masked so it reads over furniture linework; the masks sit under the walls.
  const labels: Prim[] = [];
  const mask = (cx: number, cy: number, w: number, h: number, fill: string = WHITE) =>
    furniture.push({ t: 'path', loops: [rectLoop(r3(cx - w / 2), r3(cy - h / 2), r3(cx + w / 2), r3(cy + h / 2))], closed: true, fill });
  for (const f of model.furniture) {
    if (!f.tag) continue;
    const size = 1.8;
    mask(X(f.x), Y(f.y), textWidth(f.tag, size) + 1.2, size + 1, groundAt(f));
    labels.push({ t: 'text', x: X(f.x), y: r3(midline(Y(f.y), size)), text: f.tag, size, anchor: 'middle', fill: SOFT });
  }
  for (const g of model.openings) {
    if (!g.label) continue;
    const off = Math.max(0.55 * k, 4);
    const cx = X(g.center.x) - g.normal.x * off;
    const cy = Y(g.center.y) - g.normal.y * off;
    const size = 1.9;
    mask(cx, cy, textWidth(g.label, size) + 1.2, size + 1, groundAt({
      x: g.center.x - (g.normal.x * off) / k,
      y: g.center.y - (g.normal.y * off) / k,
    }));
    labels.push({ t: 'text', x: r3(cx), y: r3(midline(cy, size)), text: g.label, size, anchor: 'middle', fill: INK });
  }
  for (const room of model.rooms) {
    const cx = X(room.labelAt.x);
    const cy = Y(room.labelAt.y);
    const area = formatArea(room.area, units);
    const areaSize = 2.1;
    const areaW = textWidth(area, areaSize);
    const ground = tint.get(room.key) ?? WHITE;
    if (!room.named) {
      mask(cx, cy, areaW + 1.6, areaSize + 1.4, ground);
      labels.push({ t: 'text', x: cx, y: r3(midline(cy, areaSize)), text: area, size: areaSize, anchor: 'middle', fill: SOFT });
      continue;
    }
    const name = room.name.toUpperCase();
    const avail = Math.max(8, room.width * k * 0.9);
    let size = 2.6;
    const tracking = 0.18;
    while (size > 1.7 && textWidth(name, size, true, tracking) > avail) size -= 0.1;
    const nameW = textWidth(name, size, true, tracking);
    const gap = 1.3;
    const blockH = size + gap + areaSize;
    mask(cx, cy, Math.max(nameW, areaW) + 2, blockH + 1.6, ground);
    const top = cy - blockH / 2;
    labels.push({
      t: 'text',
      x: cx,
      y: r3(top + size * 0.86),
      text: name,
      size: r3(size),
      font: 'bold',
      anchor: 'middle',
      fill: INK,
      tracking,
    });
    labels.push({ t: 'text', x: cx, y: r3(top + size + gap + areaSize * 0.86), text: area, size: areaSize, anchor: 'middle', fill: SOFT });
  }

  // ----- dimensions -----
  const dims: Prim[] = [];
  if (measurable) {
    const edge = { N: Y(ext.minY), S: Y(ext.maxY), W: X(ext.minX), E: X(ext.maxX) };
    /** One string of dimensions. `at` = distance of the line from the plan's edge, mm. */
    const chain = (side: 'N' | 'S' | 'W' | 'E', stops: number[], tier: number, long: boolean) => {
      const horizontal = side === 'N' || side === 'S';
      const out = side === 'N' || side === 'W' ? -1 : 1;
      const linePos = edge[side] + out * tier * TIER;
      const along = stops.map((s) => (horizontal ? X(s) : Y(s)));
      const seg = (a0: number, c0: number, a1: number, c1: number, stroke: string, sw: number) =>
        dims.push(horizontal ? line(a0, c0, a1, c1, stroke, sw) : line(c0, a0, c1, a1, stroke, sw));
      seg(along[0], linePos, along[along.length - 1], linePos, SOFT, 0.13);
      for (const a of along) {
        // extension line from just off the plan to just past the dimension line, and a tick
        seg(a, r3(edge[side] + out * 1.5), a, r3(linePos + out * 1.3), SOFT, 0.11);
        dims.push(
          horizontal
            ? line(r3(a - 0.8), r3(linePos + 0.8), r3(a + 0.8), r3(linePos - 0.8), INK, 0.25)
            : line(r3(linePos - 0.8), r3(a + 0.8), r3(linePos + 0.8), r3(a - 0.8), INK, 0.25),
        );
      }
      for (let i = 0; i + 1 < stops.length; i++) {
        const meters = stops[i + 1] - stops[i];
        const text = long ? formatLength(meters, units) : formatLengthShort(meters, units);
        const space = Math.abs(along[i + 1] - along[i]) - 1.2;
        let size = DIM_TEXT;
        while (size > 1.5 && textWidth(text, size) > space) size -= 0.1;
        if (textWidth(text, size) > space) continue; // no room to write it
        const mid = r3((along[i] + along[i + 1]) / 2);
        // Text sits on the outer side of its line, reading left-to-right or bottom-to-top.
        if (horizontal) {
          const y = out < 0 ? linePos - 0.9 : linePos + 0.9 + size * 0.72;
          dims.push({ t: 'text', x: mid, y: r3(y), text, size: r3(size), anchor: 'middle', fill: INK });
        } else {
          const x = out < 0 ? linePos - 0.9 : linePos + 0.9 + size * 0.72;
          dims.push({ t: 'text', x: r3(x), y: mid, text, size: r3(size), anchor: 'middle', rot: -90, fill: INK });
        }
      }
    };
    for (const c of model.chains) chain(c.side, c.stops, 1, false);
    chain('N', [model.axes.minX, model.axes.maxX], has('N') ? 2 : 1, true);
    chain('W', [model.axes.minY, model.axes.maxY], has('W') ? 2 : 1, true);
  }

  // ----- title block -----
  const title: Prim[] = [];
  const right = page.w - MARGIN;
  const northX0 = right - 15;
  const noteX0 = northX0 - 62;
  const dateX0 = noteX0 - 30;
  const areaX0 = dateX0 - 32;
  const scaleX0 = areaX0 - 70;
  stripCell(title, MARGIN, scaleX0, stripTop, 'Plan', model.name, { size: 4.2, bold: true, rule: false });
  stripCell(title, scaleX0, areaX0, stripTop, 'Scale', scale.label);
  stripCell(title, areaX0, dateX0, stripTop, 'Area', model.rooms.length > 0 ? formatArea(model.totalArea, units) : '—');
  stripCell(title, dateX0, noteX0, stripTop, 'Date', formatDate(opts.date ?? new Date()));
  stripCell(title, noteX0, northX0, stripTop, 'Status', 'Concept design — not for construction', { size: 2.1 });

  // Scale bar, at the right of the scale cell.
  const barMax = 30;
  const barM = scaleBarLength(units, k, barMax);
  const barMm = barM * k;
  const barX1 = areaX0 - 5;
  const barX0 = barX1 - barMm;
  const barY = stripTop + 7.2;
  title.push({ t: 'path', loops: [rectLoop(r3(barX0), barY, r3(barX1), barY + 1.2)], closed: true, stroke: INK, sw: 0.15 });
  title.push({ t: 'path', loops: [rectLoop(r3(barX0), barY, r3(barX0 + barMm / 2), barY + 1.2)], closed: true, fill: INK });
  title.push({ t: 'text', x: r3(barX0), y: barY + 4.2, text: '0', size: 1.7, anchor: 'middle', fill: SOFT });
  title.push({
    t: 'text',
    x: r3(barX1),
    y: barY + 4.2,
    text: formatLength(barM, units, barM < 1 ? 1 : 0),
    size: 1.7,
    anchor: 'middle',
    fill: SOFT,
  });

  // North arrow (+y is south, so north is up the page).
  title.push(line(northX0, stripTop, northX0, stripTop + STRIP, INK, 0.18));
  const ncx = northX0 + 7.5;
  const ncy = stripTop + 9;
  title.push({ t: 'circle', cx: ncx, cy: ncy, r: 3.6, stroke: INK, sw: 0.15 });
  title.push({
    t: 'path',
    loops: [[ncx, ncy - 3.1, ncx + 1.7, ncy + 2.2, ncx, ncy + 1.1, ncx - 1.7, ncy + 2.2]],
    closed: true,
    fill: INK,
  });
  title.push({ t: 'text', x: ncx, y: stripTop + 4.3, text: 'N', size: 1.9, font: 'bold', anchor: 'middle', fill: INK });

  return {
    title: model.name,
    page,
    scaleLabel: scale.label,
    ratio: scale.ratio,
    layers: [
      { id: 'sheet', title: 'Sheet', prims: sheetPrims },
      { id: 'rooms', title: 'Room colors', prims: roomFills },
      { id: 'furniture', title: 'Furniture', prims: furniture },
      { id: 'walls', title: 'Walls', prims: walls },
      { id: 'windows', title: 'Windows', prims: windows },
      { id: 'doors', title: 'Doors', prims: doorPrims },
      { id: 'labels', title: 'Room names', prims: labels },
      { id: 'dimensions', title: 'Dimensions', prims: dims },
      { id: 'title', title: 'Title block', prims: title },
    ],
  };
}
