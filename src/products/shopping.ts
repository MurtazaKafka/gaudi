/**
 * Shopping list: the placed items that came from product links, counted.
 * Derived from the plan every time — nothing is stored. Pure.
 */
import { customId, isCustomKind } from '../catalog';
import type { PlanData } from '../types';

export interface ShoppingLine {
  id: string;
  label: string;
  /** the product's own name, when it differs from the short label */ title: string | null;
  brand: string | null;
  url: string;
  /** as shown on the page, e.g. "$144.99" */ price: string | null;
  qty: number;
}

/** One line per linked product that is placed at least once, most-placed first. */
export function shoppingList(plan: Pick<PlanData, 'furniture' | 'customItems'>): ShoppingLine[] {
  const counts = new Map<string, number>();
  for (const f of plan.furniture) {
    if (!isCustomKind(f.kind)) continue;
    const id = customId(f.kind);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const lines: ShoppingLine[] = [];
  for (const [id, qty] of counts) {
    const item = Object.hasOwn(plan.customItems, id) ? plan.customItems[id] : undefined;
    const url = item?.source?.url;
    if (!item || !url || !/^https?:\/\//i.test(url)) continue;
    const title = item.source?.title?.trim() || null;
    lines.push({
      id,
      label: item.label,
      title: title && title.toLowerCase() !== item.label.toLowerCase() ? title : null,
      brand: item.source?.brand?.trim() || null,
      url,
      price: item.source?.price?.trim() || null,
      qty,
    });
  }
  return lines.sort((a, b) => b.qty - a.qty || a.label.localeCompare(b.label));
}

/** How many things to buy in all. */
export const shoppingCount = (lines: ShoppingLine[]): number => lines.reduce((n, l) => n + l.qty, 0);

/** "$144.99" → { amount: 144.99, unit: "$" }. Null when the text is not a single plain price. */
export function parsePrice(price: string | null): { amount: number; unit: string } | null {
  if (!price) return null;
  const m = /^\s*([^\d\s.,-]{0,4})\s?(\d[\d.,]*)\s*([A-Za-z]{3})?\s*$/.exec(price);
  if (!m) return null;
  let n = m[2];
  // "1.249,50" (decimal comma) vs "1,249.50"
  if (/,\d{2}$/.test(n) && !/\.\d{2}$/.test(n)) n = n.replace(/\./g, '').replace(',', '.');
  else n = n.replace(/,/g, '');
  const amount = Number(n);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, unit: (m[1] || m[3] || '').trim() };
}

/** The total, only when every line has a price in the same currency. */
export function shoppingTotal(lines: ShoppingLine[]): string | null {
  if (lines.length === 0) return null;
  let unit: string | null = null;
  let sum = 0;
  for (const l of lines) {
    const p = parsePrice(l.price);
    if (!p) return null;
    if (unit !== null && unit !== p.unit) return null;
    unit = p.unit;
    sum += p.amount * l.qty;
  }
  const shown = sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!unit) return shown;
  return /^[A-Za-z]{3}$/.test(unit) ? `${shown} ${unit}` : `${unit}${shown}`;
}

/** Plain text for the clipboard. */
export function shoppingText(lines: ShoppingLine[], planName = ''): string {
  const head = planName.trim() ? `Shopping list — ${planName.trim()}` : 'Shopping list';
  const body = lines.map((l) => {
    const name = l.title ?? l.label;
    const first = `${l.qty} × ${name}${l.price ? ` — ${l.price}${l.qty > 1 ? ' each' : ''}` : ''}`;
    return `${first}\n  ${l.url}`;
  });
  const total = shoppingTotal(lines);
  return [head, '', ...body, ...(total ? ['', `Total: ${total}`] : [])].join('\n');
}
