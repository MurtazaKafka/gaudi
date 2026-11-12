/**
 * Plan → DXF, the lowest common denominator of CAD: ASCII, release 12, so
 * anything that reads DXF at all will open it. Geometry is at real size in
 * model space — meters for metric plans, inches for imperial ones — on named
 * layers, with y flipped (DXF's y points up, ours points down). Pure.
 */
import type { PlanData, Point } from '../types';
import { formatArea, formatLength, formatLengthShort } from '../units';
import { buildModel, doorSwings, drawnExtent, type PlanModel } from './model';
import { cp1252Byte } from './text';

export const DXF_LAYERS = [
  { name: 'A-WALL', color: 7 },
  { name: 'A-DOOR', color: 3 },
  { name: 'A-GLAZ', color: 4 },
  { name: 'A-FURN', color: 8 },
  { name: 'A-ANNO-TEXT', color: 7 },
  { name: 'A-ANNO-DIMS', color: 1 },
] as const;

type LayerName = (typeof DXF_LAYERS)[number]['name'];

const IN_PER_M = 1 / 0.0254;

/** A coordinate: at most four decimals, never an exponent. */
function f(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  const s = v.toFixed(4).replace(/0+$/, '');
  const t = s.endsWith('.') ? s + '0' : s;
  return t === '-0.0' ? '0.0' : t;
}

/**
 * Text for a DXF value line. The file is written in Windows-1252 (declared
 * as $DWGCODEPAGE), so accents, ² and × go through as they are; anything
 * outside that code page becomes \\U+XXXX.
 */
export function dxfText(text: string): string {
  let out = '';
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '^') out += '^ ';
    else if (code < 0x20 || code === 0x7f) continue;
    else if (cp1252Byte(ch) !== null) out += ch;
    else if (code <= 0xffff) out += `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += '?';
  }
  return out.replace(/%%/g, '% %').trim();
}

/** The DXF file, as bytes ready to save. */
export function planToDxf(plan: PlanData): Uint8Array {
  const text = modelToDxf(buildModel(plan));
  const bytes = new Uint8Array(text.length);
  let n = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    bytes[n++] = code < 0x80 ? code : (cp1252Byte(ch) ?? 63);
  }
  return bytes.subarray(0, n);
}

/** The DXF file as text (characters, before encoding). */
export function modelToDxf(model: PlanModel): string {
  const units = model.units;
  const U = units === 'ft' ? IN_PER_M : 1;
  const half = model.body.thickness / 2;
  const X = (x: number): number => x * U;
  const Y = (y: number): number => -y * U;

  const out: string[] = [];
  const g = (code: number, value: string | number) => {
    out.push(String(code), typeof value === 'number' ? String(value) : value);
  };

  // Track what is drawn, for the header's extents.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const ents: string[] = [];
  const e = (code: number, value: string | number) => {
    ents.push(String(code), typeof value === 'number' ? String(value) : value);
  };
  const lineEnt = (layer: LayerName, a: Point, b: Point) => {
    e(0, 'LINE');
    e(8, layer);
    e(10, f(X(a.x)));
    e(20, f(Y(a.y)));
    e(30, '0.0');
    e(11, f(X(b.x)));
    e(21, f(Y(b.y)));
    e(31, '0.0');
    see(X(a.x), Y(a.y));
    see(X(b.x), Y(b.y));
  };
  const polyEnt = (layer: LayerName, pts: Point[], closed: boolean) => {
    if (pts.length < 2) return;
    if (pts.length === 2) {
      lineEnt(layer, pts[0], pts[1]);
      return;
    }
    e(0, 'POLYLINE');
    e(8, layer);
    e(66, 1);
    e(10, '0.0');
    e(20, '0.0');
    e(30, '0.0');
    e(70, closed ? 1 : 0);
    for (const p of pts) {
      e(0, 'VERTEX');
      e(8, layer);
      e(10, f(X(p.x)));
      e(20, f(Y(p.y)));
      e(30, '0.0');
      see(X(p.x), Y(p.y));
    }
    e(0, 'SEQEND');
    e(8, layer);
  };
  const circleEnt = (layer: LayerName, c: Point, r: number) => {
    e(0, 'CIRCLE');
    e(8, layer);
    e(10, f(X(c.x)));
    e(20, f(Y(c.y)));
    e(30, '0.0');
    e(40, f(r * U));
    see(X(c.x) - r * U, Y(c.y) - r * U);
    see(X(c.x) + r * U, Y(c.y) + r * U);
  };
  /** Centered text. `height` in meters; `rot` in degrees counter-clockwise. */
  const textEnt = (layer: LayerName, at: Point, height: number, text: string, rot = 0) => {
    const value = dxfText(text);
    if (!value) return;
    e(0, 'TEXT');
    e(8, layer);
    e(10, f(X(at.x)));
    e(20, f(Y(at.y)));
    e(30, '0.0');
    e(40, f(height * U));
    e(1, value);
    if (rot) e(50, f(rot));
    e(7, 'STANDARD');
    e(72, 1); // centered…
    e(73, 2); // …on its middle
    e(11, f(X(at.x)));
    e(21, f(Y(at.y)));
    e(31, '0.0');
    see(X(at.x), Y(at.y));
  };

  // Walls: the outline of the body, one closed polyline per loop.
  for (const loop of model.body.loops) polyEnt('A-WALL', loop, true);

  // Doors: the open leaf and its swing.
  for (const d of doorSwings(model)) {
    lineEnt('A-DOOR', d.hinge, d.tip);
    // On screen the swing runs clockwise from the leaf to the wall; flipped, that is
    // counter-clockwise from the wall direction to the leaf.
    const along = (Math.atan2(-d.gap.dir.y, d.gap.dir.x) * 180) / Math.PI;
    const start = ((along % 360) + 360) % 360;
    e(0, 'ARC');
    e(8, 'A-DOOR');
    e(10, f(X(d.hinge.x)));
    e(20, f(Y(d.hinge.y)));
    e(30, '0.0');
    e(40, f(d.gap.width * U));
    e(50, f(start));
    e(51, f((start + 90) % 360));
    see(X(d.end.x), Y(d.end.y));
  }

  // Windows: both faces and the glass between them.
  for (const w of model.openings) {
    if (w.type !== 'window') continue;
    const hw = w.width / 2;
    const at = (along: number, across: number): Point => ({
      x: w.center.x + w.dir.x * along + w.normal.x * across,
      y: w.center.y + w.dir.y * along + w.normal.y * across,
    });
    for (const across of [half, 0, -half]) lineEnt('A-GLAZ', at(-hw, across), at(hw, across));
  }

  // Furniture symbols.
  for (const item of model.furniture) {
    for (const s of item.symbol) {
      if (s.k === 'circle') circleEnt('A-FURN', s.c, s.r);
      else polyEnt('A-FURN', s.pts, s.closed);
    }
  }

  // Names: rooms (with their areas), labelled openings, tagged furniture.
  for (const room of model.rooms) {
    if (room.named) {
      textEnt('A-ANNO-TEXT', { x: room.labelAt.x, y: room.labelAt.y - 0.14 }, 0.2, room.name);
      textEnt('A-ANNO-TEXT', { x: room.labelAt.x, y: room.labelAt.y + 0.16 }, 0.13, formatArea(room.area, units));
    } else {
      textEnt('A-ANNO-TEXT', room.labelAt, 0.13, formatArea(room.area, units));
    }
  }
  for (const o of model.openings) {
    if (o.label) textEnt('A-ANNO-TEXT', { x: o.center.x - o.normal.x * 0.55, y: o.center.y - o.normal.y * 0.55 }, 0.12, o.label);
  }
  for (const item of model.furniture) {
    if (item.tag) textEnt('A-ANNO-TEXT', { x: item.x, y: item.y }, 0.1, item.tag);
  }

  // Dimensions, drawn out as lines and text so nothing depends on the reader's dimension styles.
  if (model.body.graph.edges.length > 0) {
    const ext = drawnExtent(model);
    const TIER = 0.5;
    const has = (side: string) => model.chains.some((c) => c.side === side);
    const chain = (side: 'N' | 'S' | 'W' | 'E', stops: number[], tier: number, long: boolean) => {
      const horizontal = side === 'N' || side === 'S';
      const out1 = side === 'N' || side === 'W' ? -1 : 1;
      const edge = side === 'N' ? ext.minY : side === 'S' ? ext.maxY : side === 'W' ? ext.minX : ext.maxX;
      const pos = edge + out1 * tier * TIER;
      const pt = (along: number, across: number): Point => (horizontal ? { x: along, y: across } : { x: across, y: along });
      lineEnt('A-ANNO-DIMS', pt(stops[0], pos), pt(stops[stops.length - 1], pos));
      for (const s of stops) {
        lineEnt('A-ANNO-DIMS', pt(s, edge + out1 * 0.1), pt(s, pos + out1 * 0.1));
        lineEnt('A-ANNO-DIMS', { x: pt(s, pos).x - 0.06, y: pt(s, pos).y + 0.06 }, { x: pt(s, pos).x + 0.06, y: pt(s, pos).y - 0.06 });
      }
      for (let i = 0; i + 1 < stops.length; i++) {
        const meters = stops[i + 1] - stops[i];
        const text = long ? formatLength(meters, units) : formatLengthShort(meters, units);
        textEnt('A-ANNO-DIMS', pt((stops[i] + stops[i + 1]) / 2, pos + out1 * 0.13), 0.12, text, horizontal ? 0 : 90);
      }
    };
    for (const c of model.chains) chain(c.side, c.stops, 1, false);
    chain('N', [model.axes.minX, model.axes.maxX], has('N') ? 2 : 1, true);
    chain('W', [model.axes.minY, model.axes.maxY], has('W') ? 2 : 1, true);
  }

  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;

  // ----- HEADER -----
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$DWGCODEPAGE');
  g(3, 'ANSI_1252');
  g(9, '$INSBASE');
  g(10, '0.0');
  g(20, '0.0');
  g(30, '0.0');
  g(9, '$EXTMIN');
  g(10, f(minX));
  g(20, f(minY));
  g(30, '0.0');
  g(9, '$EXTMAX');
  g(10, f(maxX));
  g(20, f(maxY));
  g(30, '0.0');
  g(9, '$LIMMIN');
  g(10, f(minX));
  g(20, f(minY));
  g(9, '$LIMMAX');
  g(10, f(maxX));
  g(20, f(maxY));
  // Linear units: decimal for meters, feet-and-inches for imperial plans (drawn in inches).
  g(9, '$LUNITS');
  g(70, units === 'ft' ? 4 : 2);
  g(9, '$LUPREC');
  g(70, units === 'ft' ? 4 : 3);
  g(9, '$INSUNITS');
  g(70, units === 'ft' ? 1 : 6);
  g(9, '$MEASUREMENT');
  g(70, units === 'ft' ? 0 : 1);
  g(0, 'ENDSEC');

  // ----- TABLES -----
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, 1);
  g(0, 'LTYPE');
  g(2, 'CONTINUOUS');
  g(70, 0);
  g(3, 'Solid line');
  g(72, 65);
  g(73, 0);
  g(40, '0.0');
  g(0, 'ENDTAB');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, DXF_LAYERS.length + 1);
  for (const layer of [{ name: '0', color: 7 }, ...DXF_LAYERS]) {
    g(0, 'LAYER');
    g(2, layer.name);
    g(70, 0);
    g(62, layer.color);
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE');
  g(2, 'STYLE');
  g(70, 1);
  g(0, 'STYLE');
  g(2, 'STANDARD');
  g(70, 0);
  g(40, '0.0');
  g(41, '1.0');
  g(50, '0.0');
  g(71, 0);
  g(42, f(0.2 * U));
  g(3, 'txt');
  g(4, '');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // ----- BLOCKS (none) -----
  g(0, 'SECTION');
  g(2, 'BLOCKS');
  g(0, 'ENDSEC');

  // ----- ENTITIES -----
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const v of ents) out.push(v);
  g(0, 'ENDSEC');
  g(0, 'EOF');

  return out.join('\r\n') + '\r\n';
}
