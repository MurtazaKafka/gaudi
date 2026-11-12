/**
 * Text metrics and encodings for the file writers. The sheet is set in
 * Helvetica (one of the fonts every PDF reader has built in), so widths come
 * from its published metrics and nothing needs embedding. Pure.
 */

// Advance widths (1/1000 em) for ASCII 32–126, from the Adobe core-font metrics.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

/** Widths for the few non-ASCII glyphs that turn up in plans; anything else is measured as its base letter. */
const EXTRA: Record<string, number> = {
  '²': 333, '³': 333, '×': 584, '°': 400, '·': 278, '–': 556, '—': 1000, '…': 1000, '′': 191, '″': 355,
  '‘': 222, '’': 222, '“': 333, '”': 333, '•': 350, '€': 556, '£': 556, '½': 834, '¼': 834, '¾': 834, '\u00a0': 278,
};

function charWidth(ch: string, bold: boolean): number {
  const code = ch.charCodeAt(0);
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  if (code >= 32 && code <= 126) return table[code - 32];
  const extra = EXTRA[ch];
  if (extra !== undefined) return extra;
  const base = ch.normalize('NFD').charCodeAt(0);
  if (base >= 32 && base <= 126) return table[base - 32];
  return 556;
}

/** Width of a line of text at `size`, in the same unit as `size`. `tracking` is extra space per character. */
export function textWidth(text: string, size: number, bold = false, tracking = 0): number {
  let w = 0;
  let n = 0;
  for (const ch of text) {
    w += charWidth(ch, bold);
    n++;
  }
  return (w / 1000) * size + tracking * n;
}

/** Shorten with an ellipsis until it fits `max`. */
export function fitText(text: string, max: number, size: number, bold = false, tracking = 0): string {
  if (textWidth(text, size, bold, tracking) <= max) return text;
  const chars = [...text];
  // Drop characters from the end until it fits with its ellipsis — keeping a running width,
  // not measuring the whole string again for each one (the sum is the one textWidth makes).
  let w = charWidth('…', bold);
  for (const ch of chars) w += charWidth(ch, bold);
  let n = chars.length;
  while (n > 1 && (w / 1000) * size + tracking * (n + 1) > max) w -= charWidth(chars[--n], bold);
  return chars.slice(0, n).join('').trimEnd() + '…';
}

// Windows-1252 code points that differ from Latin-1 (what PDF calls WinAnsiEncoding).
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
  // No primes in the core fonts: feet and inches are written with straight quotes.
  '′': 0x27, '″': 0x22, '−': 0x2d, '\u2009': 0x20, '\u202f': 0x20,
};

/** The Windows-1252 byte for a printable character, or null if it has none. */
export function cp1252Byte(ch: string): number | null {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return WIN_ANSI[ch] ?? null;
}

/** Text → WinAnsi byte values (unknown characters become "?"). */
export function winAnsiBytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const byte = cp1252Byte(ch);
    if (byte !== null) out.push(byte);
    else if (ch === '\t' || ch === '\n' || ch === '\r') out.push(0x20);
    else out.push(63);
  }
  return out;
}

/** "11 Nov 2026" */
export function formatDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/** A safe file name stem from a plan name. */
export function fileStem(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'gaudi-plan'
  );
}
