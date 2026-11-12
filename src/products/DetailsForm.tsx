/**
 * The always-works path: when a link cannot be read (or looked up), type what
 * is known — a name, a size, maybe a photo and a note — and the same modeller
 * builds from that. Opens by itself, pre-filled with whatever was found.
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { aiErrorMessage } from '../ai/client';
import type { Units } from '../types';
import { formatLengthShort, parseLength } from '../units';
import type { Details } from './facts';
import { addBlockFromDetails, closeDetails, placeItem, submitDetails, type DetailsDraft } from './importProduct';
import { imageFromTransfer } from './photos';

const AXES = ['w', 'd', 'h'] as const;
const AXIS_NAME = { w: 'Width', d: 'Depth', h: 'Height' } as const;

type Sizes = Record<(typeof AXES)[number], string>;

/** The boxes → meters. `null` for a blank box; `false` when a box cannot be read. */
function readSizes(text: Sizes, units: Units): { w: number | null; d: number | null; h: number | null } | false {
  const out = { w: null as number | null, d: null as number | null, h: null as number | null };
  for (const axis of AXES) {
    const t = text[axis].trim();
    if (!t) continue;
    const m = parseLength(t, units);
    if (m === null || !(m > 0)) return false;
    out[axis] = m;
  }
  return out;
}

export function DetailsForm({ draft, units }: { draft: DetailsDraft; units: Units }) {
  const [name, setName] = useState(draft.name);
  const [size, setSize] = useState<Sizes>(() => ({
    w: draft.w ? formatLengthShort(draft.w, units) : '',
    d: draft.d ? formatLengthShort(draft.d, units) : '',
    h: draft.h ? formatLengthShort(draft.h, units) : '',
  }));
  const [note, setNote] = useState(draft.note);
  const [photo, setPhoto] = useState<Blob | null>(draft.photo);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const preview = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  const sizes = readSizes(size, units);
  const allThree = sizes !== false && sizes.w !== null && sizes.d !== null && sizes.h !== null;

  const details = (): Details | null => {
    if (sizes === false) {
      setError(units === 'ft' ? 'Sizes read like 6′ 2″ or 74in.' : 'Sizes read like 1.8 or 180cm.');
      return null;
    }
    if (!name.trim() && !note.trim()) {
      setError('Give it a name first.');
      return null;
    }
    return { name: name.trim().slice(0, 160), ...sizes, note: note.slice(0, 1800), url: draft.url ?? null, asin: draft.asin ?? null };
  };

  const build = (): void => {
    if (busy) return;
    const d = details();
    if (!d) return;
    setError(null);
    setBusy(true);
    void submitDetails(d, photo, draft.seq).then((problem) => {
      if (!alive.current) return;
      setBusy(false);
      setError(problem);
    });
  };

  const block = (): void => {
    const d = details();
    if (!d) return;
    try {
      const item = addBlockFromDetails(d);
      closeDetails();
      placeItem(item.id);
    } catch (e) {
      setError(aiErrorMessage(e));
    }
  };

  const takePhoto = (data: DataTransfer | null): boolean => {
    const img = imageFromTransfer(data);
    if (img) setPhoto(img);
    return !!img;
  };
  const onPaste = (e: ClipboardEvent): void => {
    if (takePhoto(e.clipboardData)) e.preventDefault();
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    takePhoto(e.dataTransfer);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDetails();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement && e.target.type === 'text') {
      e.preventDefault();
      build();
    }
  };

  return (
    <form
      className={`df ${over ? 'over' : ''}`}
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="df-head">
        <span className="hint">{draft.reason ?? 'Add what you know.'}</span>
        <button type="button" className="ps-clear static" title="Close" aria-label="Close" onClick={closeDetails}>
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <input
        className="input"
        type="text"
        autoFocus
        value={name}
        maxLength={160}
        placeholder="Name, e.g. grey three-seat sofa"
        aria-label="Name"
        onChange={(e) => setName(e.target.value)}
      />
      <div className="yi-size">
        {AXES.map((axis) => (
          <label key={axis} className="yi-size-field">
            <span className="label">{axis.toUpperCase()}</span>
            <input
              className="input mono"
              type="text"
              value={size[axis]}
              placeholder={units === 'ft' ? '0′ 0″' : '0.0'}
              aria-label={AXIS_NAME[axis]}
              onChange={(e) => {
                setError(null);
                setSize({ ...size, [axis]: e.target.value });
              }}
            />
          </label>
        ))}
      </div>
      <textarea
        className="textarea df-note"
        rows={2}
        value={note}
        maxLength={1800}
        placeholder="Note: colour, legs, shape (optional)"
        aria-label="Note"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="df-photo">
        {preview ? (
          <>
            <img src={preview} alt="" />
            <span className="hint">Photo added</span>
            <button type="button" className="yi-act" onClick={() => setPhoto(null)}>
              Remove
            </button>
          </>
        ) : (
          <button type="button" className="df-pick" onClick={() => file.current?.click()}>
            Photo: drop, paste or pick (optional)
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && /^image\//i.test(f.type)) setPhoto(f);
            e.target.value = '';
          }}
        />
      </div>
      {error && <div className="hint error">{error}</div>}
      <div className="df-actions">
        <button type="button" className="btn small primary" disabled={busy} onClick={build}>
          {busy ? 'Building' : 'Build'}
        </button>
        <button type="button" className="btn small quiet" disabled={busy || !allThree} title="A plain block at this size, no model" onClick={block}>
          Plain block
        </button>
      </div>
    </form>
  );
}
