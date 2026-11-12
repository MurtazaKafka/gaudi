/**
 * "Your items": the plan's own furniture (built from products, links or
 * descriptions), each with its turning model, and the few things one can do
 * to it — place, refine, resize, open its page, delete.
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { customKind } from '../catalog';
import { toast } from '../toast';
import type { CustomItem, Units } from '../types';
import { useUiStore } from '../uiStore';
import { formatFootprint, formatLengthShort, parseLength } from '../units';
import {
  cancelImport,
  deleteItem,
  ImportError,
  placeItem,
  refineItem,
  reportImportError,
  resizeItem,
  STEP_TEXT,
  useImportStore,
  type ImportJob,
} from './importProduct';
import { ShoppingList } from './ShoppingList';

type Editing = { id: string; what: 'refine' | 'resize' } | null;

const stopOnEscape = (close: () => void) => (e: KeyboardEvent<HTMLElement>): void => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
};

function RefineForm({ item, close }: { item: CustomItem; close: () => void }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const note = text.trim();
    if (!note) return;
    close(); // the row shows the progress from here
    refineItem(item.id, note).catch((err: unknown) => {
      // needing a key is worth one line here; everything else is reported the usual quiet way
      if (err instanceof ImportError && err.kind === 'no-key') toast(err.message);
      else reportImportError(err);
    });
  };
  return (
    <form className="yi-form" onSubmit={submit} onKeyDown={stopOnEscape(close)}>
      <input
        className="input"
        autoFocus
        value={text}
        maxLength={400}
        placeholder="thinner legs, darker fabric"
        aria-label={`What to change about ${item.label}`}
        onChange={(e) => setText(e.target.value)}
      />
    </form>
  );
}

const AXES = ['w', 'd', 'h'] as const;
const AXIS_NAME = { w: 'Width', d: 'Depth', h: 'Height' } as const;

function ResizeForm({ item, units, close }: { item: CustomItem; units: Units; close: () => void }) {
  // What the boxes showed when the form opened. A box left alone keeps the exact stored size,
  // so display rounding never nudges an axis nobody touched.
  const [shown] = useState(() => ({
    w: formatLengthShort(item.w, units),
    d: formatLengthShort(item.d, units),
    h: formatLengthShort(item.h, units),
  }));
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);

  const apply = (): void => {
    const size = { w: item.w, d: item.d, h: item.h };
    for (const axis of AXES) {
      if (text[axis].trim() === shown[axis]) continue;
      const m = parseLength(text[axis], units);
      if (m === null || !(m > 0)) return setBad(true);
      size[axis] = m;
    }
    if (size.w !== item.w || size.d !== item.d || size.h !== item.h) resizeItem(item.id, size);
    close();
  };

  return (
    <form
      className="yi-form"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      onKeyDown={stopOnEscape(close)}
    >
      <div className="yi-size">
        {AXES.map((axis, i) => (
          <label key={axis} className="yi-size-field">
            <span className="label">{axis.toUpperCase()}</span>
            <input
              className="input mono"
              autoFocus={i === 0}
              value={text[axis]}
              aria-label={AXIS_NAME[axis]}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                // Enter in any box applies (a form with several boxes and no button does not submit by itself)
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  apply();
                }
              }}
              onChange={(e) => {
                setBad(false);
                setText({ ...text, [axis]: e.target.value });
              }}
            />
          </label>
        ))}
      </div>
      {bad && <div className="hint error">{units === 'ft' ? 'Use a length like 6′ 2″ or 74in.' : 'Use a length like 1.8 or 180cm.'}</div>}
    </form>
  );
}

function ItemRow({
  item,
  units,
  active,
  job,
  editing,
  setEditing,
}: {
  item: CustomItem;
  units: Units;
  active: boolean;
  job: ImportJob | undefined;
  editing: 'refine' | 'resize' | null;
  setEditing: (e: Editing) => void;
}) {
  const toggle = (what: 'refine' | 'resize'): void => setEditing(editing === what ? null : { id: item.id, what });
  const link = item.source?.url && /^https?:\/\//i.test(item.source.url) ? item.source.url : null;
  return (
    <li className={`yi-row ${active ? 'active' : ''} ${editing ? 'open' : ''}`}>
      <div className="yi-head">
        <button className="yi-thumb" title={`Place ${item.label}`} aria-label={`Place ${item.label}`} onClick={() => placeItem(item.id)}>
          <span className="yi-view" data-tt={item.id} />
        </button>
        <div className="yi-body">
          <button className="yi-name" title={item.source?.title ?? item.label} onClick={() => placeItem(item.id)}>
            {item.label}
          </button>
          {job ? (
            <div className="yi-line yi-step">
              <span className="spinner" />
              {STEP_TEXT[job.step]}
              <button className="yi-act" onClick={() => cancelImport(job.id)}>
                Stop
              </button>
            </div>
          ) : (
            <div className="yi-line">
              <span className="yi-dims">{formatFootprint(item.w, item.d, units)}</span>
              <span className="yi-actions">
                <button className="yi-act" onClick={() => placeItem(item.id)}>
                  Place
                </button>
                <button className={`yi-act ${editing === 'refine' ? 'on' : ''}`} title="Change how it looks" onClick={() => toggle('refine')}>
                  Refine
                </button>
                <button className={`yi-act ${editing === 'resize' ? 'on' : ''}`} title="Set its size" onClick={() => toggle('resize')}>
                  Resize
                </button>
                {link && (
                  <a className="yi-act" href={link} target="_blank" rel="noopener noreferrer" title="Open the product page" aria-label="Open the product page">
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <path d="M3.5 1.5h5v5M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </a>
                )}
                <button className="yi-act" title="Delete it and every placed copy" onClick={() => deleteItem(item.id)}>
                  Delete
                </button>
              </span>
            </div>
          )}
        </div>
      </div>
      {editing === 'refine' && !job && <RefineForm item={item} close={() => setEditing(null)} />}
      {editing === 'resize' && !job && <ResizeForm item={item} units={units} close={() => setEditing(null)} />}
    </li>
  );
}

export function YourItems({ items, units }: { items: CustomItem[]; units: Units }) {
  const placingKind = useUiStore((s) => s.placingKind);
  const tool = useUiStore((s) => s.tool);
  const jobs = useImportStore((s) => s.jobs);
  const [editing, setEditing] = useState<Editing>(null);
  if (items.length === 0) return null;
  return (
    <div className="palette-group">
      <div className="palette-group-title">Your items</div>
      <ul className="yi-list">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            units={units}
            active={tool === 'furniture' && placingKind === customKind(item.id)}
            job={jobs.find((j) => j.refines === item.id)}
            editing={editing?.id === item.id ? editing.what : null}
            setEditing={setEditing}
          />
        ))}
      </ul>
      <ShoppingList />
    </div>
  );
}
