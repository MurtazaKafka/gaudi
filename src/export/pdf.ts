/**
 * A small vector PDF writer: sheets of drawing primitives → one page each.
 * Lines, filled outlines, arcs and text in the built-in Helvetica faces —
 * nothing embedded, nothing compressed, so the file is plain to read and
 * every byte offset is ours to get right. Pure (no DOM).
 */
import type { PlanData } from '../types';
import { buildSheetFromModel, type Prim, type Sheet, type SheetOptions } from './drawing';
import { buildModel } from './model';
import { buildScheduleSheets } from './schedule';
import { textWidth, winAnsiBytes } from './text';

const PT_PER_MM = 72 / 25.4;

/** A number as PDF wants it: plain decimal, no exponent, no trailing zeros. */
export function num(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(digits);
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return t === '-0' ? '0' : t;
}

/** A literal string object: WinAnsi bytes with the delimiters and anything non-printable escaped. */
export function pdfString(text: string): string {
  let out = '(';
  for (const b of winAnsiBytes(text)) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0x28) out += '\\(';
    else if (b === 0x29) out += '\\)';
    else if (b < 0x20 || b > 0x7e) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

/** A text string for document metadata: plain when ASCII, UTF-16BE hex otherwise. */
function pdfTextString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return pdfString(text);
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

function rgb(hex: string): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h, 16);
  if (!Number.isFinite(v) || h.length !== 6) return '0 0 0';
  return `${num(((v >> 16) & 255) / 255)} ${num(((v >> 8) & 255) / 255)} ${num((v & 255) / 255)}`;
}

/** Cubic Bézier segments for a circular arc from a0 to a1 (any direction), as path operators after a moveto. */
function arcSegments(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const da = (a1 - a0) / steps;
  const k = (4 / 3) * Math.tan(da / 4);
  let out = '';
  for (let i = 0; i < steps; i++) {
    const s = a0 + da * i;
    const e = s + da;
    const x0 = cx + Math.cos(s) * r;
    const y0 = cy + Math.sin(s) * r;
    const x3 = cx + Math.cos(e) * r;
    const y3 = cy + Math.sin(e) * r;
    out += `${num(x0 - k * r * Math.sin(s))} ${num(y0 + k * r * Math.cos(s))} ${num(x3 + k * r * Math.sin(e))} ${num(y3 - k * r * Math.cos(e))} ${num(x3)} ${num(y3)} c\n`;
  }
  return out;
}

interface LinkRect {
  /** points, PDF page space (y up) */ rect: [number, number, number, number];
  url: string;
}

function paintOps(p: { fill?: string; stroke?: string; sw?: number; dash?: number[] }): { pre: string; op: string; post: string } {
  let pre = '';
  let post = '';
  if (p.fill) pre += `${rgb(p.fill)} rg\n`;
  if (p.stroke) {
    pre += `${rgb(p.stroke)} RG\n${num(p.sw ?? 0.2)} w\n`;
    if (p.dash?.length) {
      pre += `[${p.dash.map((d) => num(d)).join(' ')}] 0 d\n`;
      post = '[] 0 d\n';
    }
  }
  const op = p.fill && p.stroke ? 'B' : p.fill ? 'f' : p.stroke ? 'S' : 'n';
  return { pre, op, post };
}

/** One sheet's content stream. Works in millimetres, y down — the same space the sheet is drawn in. */
function pageContent(sheet: Sheet, links: LinkRect[]): string {
  const H = sheet.page.h;
  let s = `q\n${num(PT_PER_MM, 6)} 0 0 ${num(-PT_PER_MM, 6)} 0 ${num(H * PT_PER_MM)} cm\n1 j\n1 J\n`;
  const draw = (p: Prim) => {
    switch (p.t) {
      case 'path': {
        const { pre, op, post } = paintOps(p);
        s += pre;
        for (const loop of p.loops) {
          for (let i = 0; i + 1 < loop.length; i += 2) s += `${num(loop[i])} ${num(loop[i + 1])} ${i === 0 ? 'm' : 'l'}\n`;
          if (p.closed) s += 'h\n';
        }
        s += `${op}\n${post}`;
        break;
      }
      case 'arc': {
        const { pre, op } = paintOps(p);
        s += pre;
        s += `${num(p.cx + Math.cos(p.a0) * p.r)} ${num(p.cy + Math.sin(p.a0) * p.r)} m\n`;
        s += arcSegments(p.cx, p.cy, p.r, p.a0, p.a1);
        s += `${op}\n`;
        break;
      }
      case 'circle': {
        const { pre, op, post } = paintOps(p);
        s += pre;
        s += `${num(p.cx + p.r)} ${num(p.cy)} m\n`;
        s += arcSegments(p.cx, p.cy, p.r, 0, Math.PI * 2);
        s += `h\n${op}\n${post}`;
        break;
      }
      case 'text': {
        if (!p.text) break;
        const bold = p.font === 'bold';
        const tracking = p.tracking ?? 0;
        const w = textWidth(p.text, p.size, bold, tracking);
        const shift = p.anchor === 'middle' ? w / 2 : p.anchor === 'end' ? w : 0;
        const a = ((p.rot ?? 0) * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const x = p.x - shift * cos;
        const y = p.y - shift * sin;
        // The page space is flipped (y down), so the text matrix flips glyphs back upright.
        s += `BT\n${rgb(p.fill)} rg\n/${bold ? 'F2' : 'F1'} ${num(p.size)} Tf\n`;
        if (tracking) s += `${num(tracking)} Tc\n`;
        s += `${num(cos, 5)} ${num(sin, 5)} ${num(sin, 5)} ${num(-cos, 5)} ${num(x)} ${num(y)} Tm\n${pdfString(p.text)} Tj\n`;
        if (tracking) s += '0 Tc\n';
        s += 'ET\n';
        if (p.href && !p.rot) {
          links.push({
            rect: [x * PT_PER_MM, (H - (p.y + p.size * 0.28)) * PT_PER_MM, (x + w) * PT_PER_MM, (H - (p.y - p.size * 0.85)) * PT_PER_MM],
            url: p.href,
          });
        }
        break;
      }
    }
  };
  for (const layer of sheet.layers) for (const p of layer.prims) draw(p);
  return s + 'Q\n';
}

function pdfDate(d: Date): string {
  const p = (v: number, n = 2) => String(v).padStart(n, '0');
  return `D:${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A URI for a link action: 7-bit ASCII, with anything else percent-encoded. */
function asciiUri(url: string): string {
  return url.replace(/[^\x21-\x7e]/g, (c) => {
    try {
      return encodeURIComponent(c);
    } catch {
      return '';
    }
  });
}

/** Sheets → a complete PDF file, one page per sheet. */
export function sheetsToPdf(sheets: Sheet[], meta: { title: string; date?: Date }): Uint8Array {
  // Object numbers: 1 catalog, 2 page tree, 3–4 fonts, 5 info, then per page: page, content, link annotations.
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  add(''); // 1: catalog (filled in below)
  add(''); // 2: pages
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  add(
    `<< /Title ${pdfTextString(meta.title)} /Creator ${pdfTextString('Gaudí')} /Producer ${pdfTextString('Gaudí')} /CreationDate (${pdfDate(meta.date ?? new Date())}) >>`,
  );

  const pageIds: number[] = [];
  for (const sheet of sheets) {
    const links: LinkRect[] = [];
    const content = pageContent(sheet, links);
    const pageId = add('');
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    const annotIds = links.map((l) =>
      add(
        `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map((v) => num(v, 2)).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(asciiUri(l.url))} >> >>`,
      ),
    );
    const w = num(sheet.page.w * PT_PER_MM, 2);
    const h = num(sheet.page.h * PT_PER_MM, 2);
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R` +
      (annotIds.length ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(' ')}]` : '') +
      ' >>';
    pageIds.push(pageId);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // Every character below is one byte (content streams are ASCII; the header comment is Latin-1).
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** The plan as a PDF: the plan sheet, then the room schedule (and product list, if any). */
export function planToPdf(plan: PlanData, opts: SheetOptions = {}): Uint8Array {
  const model = buildModel(plan);
  const sheet = buildSheetFromModel(model, opts);
  return sheetsToPdf([sheet, ...buildScheduleSheets(model, sheet.page, opts)], { title: model.name, date: opts.date });
}
