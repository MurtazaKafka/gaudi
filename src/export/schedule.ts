/**
 * The room schedule (and the list of products a plan was furnished from):
 * as rows, as a CSV file, and as the second sheet of the PDF. Pure.
 */
import type { PlanData, Units } from '../types';
import { SQFT_PER_M2, formatArea, formatLength, formatLengthShort, fromMeters, unitSuffix } from '../units';
import { INK, MARGIN, SOFT, line, sheetFrame, stripCell, type Page, type Prim, type Sheet, type SheetOptions } from './drawing';
import { buildModel, type PlanModel } from './model';
import { fitText, formatDate } from './text';

export interface ScheduleRow {
  room: string;
  /** m² */ area: number;
  /** bounding box, m */ width: number;
  depth: number;
  doors: number;
  windows: number;
}

export function roomSchedule(model: PlanModel): ScheduleRow[] {
  return model.rooms.map((r) => ({
    room: r.name,
    area: r.area,
    width: r.width,
    depth: r.depth,
    doors: r.doors,
    windows: r.windows,
  }));
}

/** One CSV cell: quoted when needed, and never something a spreadsheet would run as a formula. */
function cell(value: string | number): string {
  if (typeof value === 'number') return String(value);
  let s = value.replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return /[",;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

const areaIn = (m2: number, units: Units): number => (units === 'm' ? m2 : m2 * SQFT_PER_M2);
const round = (v: number, digits: number): number => Number(v.toFixed(digits));

/** Room schedule as CSV: numbers in the plan's units, one row per room and a total. */
export function scheduleCsv(plan: PlanData): string {
  const model = buildModel(plan);
  const units = model.units;
  const u = unitSuffix(units);
  const rows: (string | number)[][] = [['Room', `Area (${u}²)`, `Width (${u})`, `Depth (${u})`, 'Doors', 'Windows']];
  for (const r of roomSchedule(model)) {
    rows.push([
      r.room,
      round(areaIn(r.area, units), units === 'm' ? 2 : 1),
      round(fromMeters(r.width, units), 2),
      round(fromMeters(r.depth, units), 2),
      r.doors,
      r.windows,
    ]);
  }
  rows.push([
    'Total',
    round(areaIn(model.totalArea, units), units === 'm' ? 2 : 1),
    '',
    '',
    model.openings.filter((o) => o.type === 'door').length,
    model.openings.filter((o) => o.type === 'window').length,
  ]);
  // The BOM tells spreadsheets the file is UTF-8 (room names, the ² in the header).
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------- the schedule as a sheet ----------

interface Column {
  title: string;
  /** mm from the table's left edge */ x: number;
  /** mm available for the text */ w: number;
  align?: 'end';
}

interface Cell {
  text: string;
  href?: string;
}

const ROW = 6.2;
const TEXT = 2.5;

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '');
}

/**
 * The schedule pages that follow the plan sheet: rooms, then products when
 * the plan has any. Flows onto further pages if there are many rows.
 */
export function buildScheduleSheets(model: PlanModel, page: Page, opts: SheetOptions = {}): Sheet[] {
  const units = model.units;
  const sheets: Sheet[] = [];
  const left = MARGIN + 10;
  const tableW = Math.min(page.w - 2 * MARGIN - 20, 250);
  const date = formatDate(opts.date ?? new Date());

  let prims: Prim[] = [];
  let y = 0;
  let bottom = 0;
  const newPage = () => {
    prims = [];
    const frame: Prim[] = [];
    const stripTop = sheetFrame(page, frame);
    const right = page.w - MARGIN;
    const noteX0 = right - 62;
    const dateX0 = noteX0 - 30;
    const areaX0 = dateX0 - 32;
    const sheetX0 = areaX0 - 44;
    stripCell(frame, MARGIN, sheetX0, stripTop, 'Plan', model.name, { size: 4.2, bold: true, rule: false });
    stripCell(frame, sheetX0, areaX0, stripTop, 'Sheet', 'Schedule');
    stripCell(frame, areaX0, dateX0, stripTop, 'Area', model.rooms.length > 0 ? formatArea(model.totalArea, units) : '—');
    stripCell(frame, dateX0, noteX0, stripTop, 'Date', date);
    stripCell(frame, noteX0, right, stripTop, 'Status', 'Concept design — not for construction', { size: 2.1 });
    sheets.push({
      title: model.name,
      page,
      scaleLabel: '',
      ratio: 0,
      layers: [
        { id: 'sheet', title: 'Sheet', prims: frame },
        { id: 'schedule', title: 'Schedule', prims },
      ],
    });
    y = MARGIN + 12;
    bottom = stripTop - 6;
  };
  newPage();

  const heading = (text: string) => {
    prims.push({ t: 'text', x: left, y: y + 3, text, size: 4, font: 'bold', fill: INK });
    y += 9;
  };
  const header = (cols: Column[]) => {
    for (const c of cols) {
      prims.push({
        t: 'text',
        x: c.align === 'end' ? left + c.x + c.w : left + c.x,
        y: y + 2.6,
        text: c.title.toUpperCase(),
        size: 1.7,
        fill: SOFT,
        tracking: 0.22,
        ...(c.align ? { anchor: c.align } : {}),
      });
    }
    y += 4.2;
    prims.push(line(left, y, left + tableW, y, INK, 0.25));
  };
  const table = (title: string, cols: Column[], rows: Cell[][], total?: Cell[]) => {
    if (y + 9 + 4.2 + ROW * 2 > bottom) newPage();
    heading(title);
    header(cols);
    const put = (cells: Cell[], bold: boolean) => {
      cells.forEach((cellValue, i) => {
        const c = cols[i];
        if (!c || !cellValue.text) return;
        prims.push({
          t: 'text',
          x: c.align === 'end' ? left + c.x + c.w : left + c.x,
          y: y + ROW / 2 + TEXT * 0.36,
          text: fitText(cellValue.text, c.w, TEXT, bold),
          size: TEXT,
          fill: cellValue.href ? SOFT : INK,
          ...(bold ? { font: 'bold' as const } : {}),
          ...(c.align ? { anchor: c.align } : {}),
          ...(cellValue.href ? { href: cellValue.href } : {}),
        });
      });
      y += ROW;
    };
    for (const row of rows) {
      if (y + ROW > bottom) {
        newPage();
        heading(`${title} (continued)`);
        header(cols);
      }
      put(row, false);
      prims.push(line(left, y, left + tableW, y, SOFT, 0.08));
    }
    if (total) {
      if (y + ROW > bottom) {
        newPage();
        heading(`${title} (continued)`);
        header(cols);
      }
      prims.push(line(left, y, left + tableW, y, INK, 0.25));
      put(total, true);
    }
    y += 10;
  };

  const roomCols: Column[] = [
    { title: 'Room', x: 0, w: tableW - 150 },
    { title: 'Area', x: tableW - 146, w: 30, align: 'end' },
    { title: 'Size', x: tableW - 106, w: 56 },
    { title: 'Doors', x: tableW - 46, w: 18, align: 'end' },
    { title: 'Windows', x: tableW - 22, w: 22, align: 'end' },
  ];
  const rooms = roomSchedule(model);
  table(
    'Room schedule',
    roomCols,
    rooms.map((r) => [
      { text: r.room },
      { text: formatArea(r.area, units) },
      { text: `${formatLength(r.width, units)} × ${formatLength(r.depth, units)}` },
      { text: String(r.doors) },
      { text: String(r.windows) },
    ]),
    [
      { text: rooms.length === 1 ? '1 room' : `${rooms.length} rooms` },
      { text: formatArea(model.totalArea, units) },
      { text: '' },
      { text: String(model.openings.filter((o) => o.type === 'door').length) },
      { text: String(model.openings.filter((o) => o.type === 'window').length) },
    ],
  );

  if (model.products.length > 0) {
    const linkW = Math.max(40, tableW * 0.3);
    const productCols: Column[] = [
      { title: 'Item', x: 0, w: tableW - linkW - 104 },
      { title: 'Size (w × d × h)', x: tableW - linkW - 100, w: 50 },
      { title: 'Qty', x: tableW - linkW - 48, w: 12, align: 'end' },
      { title: 'Price', x: tableW - linkW - 32, w: 26, align: 'end' },
      { title: 'Link', x: tableW - linkW, w: linkW },
    ];
    table(
      'Products',
      productCols,
      model.products.map((p) => [
        { text: p.label },
        { text: `${formatLengthShort(p.w, units)} × ${formatLengthShort(p.d, units)} × ${formatLength(p.h, units)}` },
        { text: String(p.count) },
        { text: p.source.price ?? '—' },
        { text: shortUrl(p.source.url), href: p.source.url },
      ]),
    );
  }

  return sheets;
}
