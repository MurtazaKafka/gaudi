/**
 * Shopping list: one quiet line under "Your items" once something placed came
 * from a product; it opens a small list with quantities, prices, links and Copy.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDismiss } from '../components/useDismiss';
import { usePlanStore } from '../store';
import { toast, toastError } from '../toast';
import { shoppingCount, shoppingList, shoppingText, shoppingTotal } from './shopping';

const WIDTH = 300;

export function ShoppingList() {
  const furniture = usePlanStore((s) => s.furniture);
  const customItems = usePlanStore((s) => s.customItems);
  const lines = useMemo(() => shoppingList({ furniture, customItems }), [furniture, customItems]);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAt(null), []);
  const open = at !== null && lines.length > 0;
  useDismiss(anchor, open, close);

  // The popover is pinned to the window (the palette clips what it contains), so it closes
  // rather than drift when the list underneath scrolls or the window changes size.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event): void => {
      // scrolling the list inside the popover is not the page moving
      if (e.target instanceof Node && anchor.current?.contains(e.target)) return;
      close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  if (lines.length === 0) return null;
  const count = shoppingCount(lines);
  const total = shoppingTotal(lines);

  const toggle = (): void => {
    if (open) return close();
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    // beside the palette, level with the line, kept inside the window
    const height = Math.min(420, 96 + lines.length * 44);
    setAt({
      left: Math.max(8, Math.min(r.right + 10, window.innerWidth - WIDTH - 8)),
      top: Math.max(8, Math.min(r.top - 8, window.innerHeight - height - 8)),
    });
  };

  const copy = (): void => {
    const text = shoppingText(lines, usePlanStore.getState().name);
    const done = (): void => toast('Shopping list copied.');
    const failed = (): void => toastError("Couldn't copy the list.");
    try {
      navigator.clipboard.writeText(text).then(done, failed);
    } catch {
      failed();
    }
  };

  return (
    <div className="shop" ref={anchor}>
      <button className={`shop-line ${open ? 'on' : ''}`} aria-expanded={open} onClick={toggle}>
        Shopping list · {count} {count === 1 ? 'item' : 'items'}
      </button>
      {open && at && (
        <div className="menu shop-pop" style={{ left: at.left, top: at.top, width: WIDTH }} role="dialog" aria-label="Shopping list">
          <div className="menu-label">Shopping list</div>
          <ul className="shop-rows">
            {lines.map((l) => (
              <li key={l.id} className="shop-row">
                <span className="shop-qty">{l.qty}×</span>
                <a className="shop-name" href={l.url} target="_blank" rel="noopener noreferrer" title={l.title ?? l.label}>
                  {l.title ?? l.label}
                </a>
                <span className="shop-price">{l.price ?? '—'}</span>
              </li>
            ))}
          </ul>
          <div className="menu-rule" />
          <div className="shop-foot">
            <span className="shop-total">{total ? `Total ${total}` : ''}</span>
            <button className="btn small" onClick={copy}>
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
