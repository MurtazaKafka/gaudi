import { useEffect } from 'react';
import { useUiStore } from '../uiStore';

const ROWS: [string, string[]][] = [
  ['Select', ['V']],
  ['Draw walls', ['W']],
  ['Door / window', ['D', 'N']],
  ['Furniture palette', ['F']],
  ['Add an Amazon product', ['A']],
  ['Measure', ['M']],
  ['Rotate furniture', ['R']],
  ['Duplicate furniture', ['⌘D']],
  ['Nudge selection', ['← ↑ ↓ →']],
  ['Exact wall length', ['type it', 'Enter']],
  ['Lock angle to 15°', ['⇧']],
  ['Delete selection', ['⌫']],
  ['Undo / redo', ['⌘Z', '⇧⌘Z']],
  ['Ask Gaudí', ['⌘K']],
  ['Generate from a brief', ['G']],
  ['Projects & templates', ['P']],
  ['Build / back to plan', ['B', 'Esc']],
  ['Model: dollhouse / exterior / walk', ['1', '2', '3']],
  ['Model: walk', ['W', 'A', 'S', 'D']],
  ['Model: save a picture', ['S']],
  ['Zoom to fit', ['0']],
  ['Wall dimensions', ['L']],
  ['Color / paper look', ['C']],
  ['Pan', ['Space', 'drag']],
  ['Zoom', ['⌘', 'scroll']],
  ['This sheet', ['?']],
];

export function ShortcutsDialog() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const close = () => useUiStore.getState().setShortcutsOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-label="Keyboard shortcuts">
        <div className="dialog-title">Shortcuts</div>
        <dl className="shortcuts">
          {ROWS.map(([label, keys]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>
                {keys.map((k) => (
                  <span key={k} className="kbd">
                    {k}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
