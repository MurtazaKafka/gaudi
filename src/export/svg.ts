/** Sheet → SVG: one <g> per layer, real text, millimetre units. Pure. */
import type { Prim, Sheet } from './drawing';

const n = (v: number): string => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};

export function xmlEscape(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue; // not allowed in XML 1.0
    else if (code === 0xfffe || code === 0xffff || (code >= 0xd800 && code <= 0xdfff)) continue;
    else out += ch;
  }
  return out;
}

function paint(p: { fill?: string; stroke?: string; sw?: number; dash?: number[] }): string {
  let s = ` fill="${p.fill ?? 'none'}"`;
  if (p.stroke) {
    s += ` stroke="${p.stroke}" stroke-width="${n(p.sw ?? 0.2)}"`;
    if (p.dash?.length) s += ` stroke-dasharray="${p.dash.map(n).join(' ')}"`;
  }
  return s;
}

function primSvg(p: Prim): string {
  switch (p.t) {
    case 'path': {
      let d = '';
      for (const loop of p.loops) {
        for (let i = 0; i + 1 < loop.length; i += 2) d += `${i === 0 ? 'M' : 'L'}${n(loop[i])} ${n(loop[i + 1])}`;
        if (p.closed) d += 'Z';
      }
      return `<path d="${d}"${paint(p)}${p.stroke ? ' stroke-linejoin="round" stroke-linecap="round"' : ''}/>`;
    }
    case 'arc': {
      const x0 = p.cx + Math.cos(p.a0) * p.r;
      const y0 = p.cy + Math.sin(p.a0) * p.r;
      const x1 = p.cx + Math.cos(p.a1) * p.r;
      const y1 = p.cy + Math.sin(p.a1) * p.r;
      const sweep = p.a1 > p.a0 ? 1 : 0;
      const large = Math.abs(p.a1 - p.a0) > Math.PI ? 1 : 0;
      return `<path d="M${n(x0)} ${n(y0)}A${n(p.r)} ${n(p.r)} 0 ${large} ${sweep} ${n(x1)} ${n(y1)}"${paint(p)} stroke-linecap="round"/>`;
    }
    case 'circle':
      return `<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}"${paint(p)}/>`;
    case 'text': {
      let attrs = `x="${n(p.x)}" y="${n(p.y)}" font-size="${n(p.size)}" fill="${p.fill}"`;
      if (p.font === 'bold') attrs += ' font-weight="700"';
      if (p.anchor && p.anchor !== 'start') attrs += ` text-anchor="${p.anchor}"`;
      if (p.tracking) attrs += ` letter-spacing="${n(p.tracking)}"`;
      if (p.rot) attrs += ` transform="rotate(${n(p.rot)} ${n(p.x)} ${n(p.y)})"`;
      const text = `<text ${attrs}>${xmlEscape(p.text)}</text>`;
      return p.href ? `<a href="${xmlEscape(p.href)}">${text}</a>` : text;
    }
  }
}

export function sheetToSvg(sheet: Sheet): string {
  const { w, h } = sheet.page;
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${xmlEscape(sheet.title)}</title>`,
  ];
  for (const layer of sheet.layers) {
    if (layer.prims.length === 0) continue;
    out.push(`<g id="${layer.id}">`);
    out.push(`<title>${xmlEscape(layer.title)}</title>`);
    for (const p of layer.prims) out.push(primSvg(p));
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}
