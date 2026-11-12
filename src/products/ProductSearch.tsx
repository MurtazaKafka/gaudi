/**
 * The palette's one field: a few words search for real products, a link is
 * imported, and any search can fall through to "build it from the words".
 * Results sit right under the field and stay there while items are added.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useDismiss } from '../components/useDismiss';
import '../styles/products.css';
import { useUiStore } from '../uiStore';
import { usePlanStore } from '../store';
import { formatLengthShort, useUnits } from '../units';
import type { Units } from '../types';
import type { DimensionCandidate } from './extract';
import { classifyInput } from './facts';
import {
  addSearchResult,
  cancelImport,
  clearSearch,
  runSearch,
  startImport,
  STEP_TEXT,
  useImportStore,
  useSearchStore,
  type ImportJob,
} from './importProduct';
import { sameProduct, type SearchResult } from './search';

const PLACEHOLDER = 'Search Amazon or paste a link';

/** "1.8×0.9×0.8" · "5′11″×2′11″×2′7″" — width × depth × height when the axes are known. */
function sizeText(dims: DimensionCandidate | null, units: Units): string | null {
  if (!dims) return null;
  const { w, d, h } = dims.meters;
  const known = w != null && d != null ? [w, d, ...(h != null ? [h] : [])] : dims.sortedMeters;
  if (known.length < 2) return null;
  return known.map((v) => formatLengthShort(v, units)).join('×');
}

function Cross() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ResultRow({ result, job, added, units }: { result: SearchResult; job: ImportJob | undefined; added: boolean; units: Units }) {
  const meta = [result.retailer, result.price, sizeText(result.dims, units)].filter(Boolean).join(' · ');
  return (
    <li className="ps-result">
      <div className="ps-result-text">
        <div className="ps-title" title={result.title}>
          {result.title}
        </div>
        {job ? (
          <div className="ps-meta ps-step">
            <span className="spinner" />
            {STEP_TEXT[job.step]}
          </div>
        ) : (
          <div className="ps-meta" title={result.looks ?? undefined}>
            {meta}
          </div>
        )}
      </div>
      {job ? (
        <button className="btn small quiet" onClick={() => cancelImport(job.id)}>
          Stop
        </button>
      ) : (
        <button
          className={`btn small ${added ? '' : 'accent'}`}
          title={added ? 'Click the plan to place it' : 'Build a 3D model of this and place it'}
          onClick={() => void addSearchResult(result)}
        >
          {added ? 'Place' : 'Add'}
        </button>
      )}
    </li>
  );
}

function SearchIcon() {
  return (
    <svg className="ps-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.4 10.4L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The Amazon search field. It lives in the top bar; what it finds, and any
 * import it is running, drop down beneath it.
 */
export function ProductSearch() {
  const query = useSearchStore((s) => s.query);
  const status = useSearchStore((s) => s.status);
  const results = useSearchStore((s) => s.results);
  const message = useSearchStore((s) => s.message);
  const jobs = useImportStore((s) => s.jobs);
  const customItems = usePlanStore((s) => s.customItems);
  const units = useUnits();
  const [text, setText] = useState(query);
  const [open, setOpen] = useState(false);
  const readOnly = useUiStore((s) => s.readOnly);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root, open, useCallback(() => setOpen(false), []));

  const sources = useMemo(() => Object.values(customItems).map((i) => i.source), [customItems]);
  // imports started from the field itself (a link, a description); result rows and item rows show their own
  const loose = jobs.filter((j) => !j.key && !j.refines);

  const submit = (): void => {
    const req = classifyInput(text);
    if (req.kind === 'empty') return;
    setOpen(true);
    if (req.kind === 'link') {
      clearSearch();
      setText('');
      void startImport(req.url);
    } else {
      void runSearch(req.text);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open) setOpen(false);
      else e.currentTarget.blur();
    }
  };

  const clear = (): void => {
    clearSearch();
    setText('');
    input.current?.focus();
  };

  // Once an item is built and waiting to be placed, get out of the way of the plan.
  useEffect(
    () =>
      useUiStore.subscribe((st, prev) => {
        if (st.tool === 'furniture' && st.placingKind !== prev.placingKind && st.placingKind?.startsWith('custom:')) {
          setOpen(false);
        }
      }),
    [],
  );

  // A and ⌘K "Add an Amazon product" land here.
  const focusNonce = useUiStore((s) => s.productFocusNonce);
  useEffect(() => {
    if (focusNonce === 0) return;
    // The palette may have just mounted; wait a frame for the field to exist.
    const id = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    });
    return () => cancelAnimationFrame(id);
  }, [focusNonce]);

  const hasDrop =
    loose.length > 0 || status !== 'idle' || results.length > 0 || !!message;

  return (
    <div className="ps ps-bar" ref={root}>
      <div className="ps-field">
        <SearchIcon />
        <input
          ref={input}
          className="input"
          type="text"
          value={text}
          placeholder={PLACEHOLDER}
          aria-label={PLACEHOLDER}
          spellCheck={false}
          autoComplete="off"
          maxLength={2000}
          disabled={readOnly}
          onFocus={() => setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {!text && status === 'idle' && <span className="kbd ps-kbd">A</span>}
        {(text || status !== 'idle') && (
          <button className="ps-clear" title="Clear" aria-label="Clear" onClick={clear}>
            <Cross />
          </button>
        )}
      </div>

      {open && hasDrop && (
      <div className="ps-drop">
      {loose.map((j) => (
        <div key={j.id} className="ps-job">
          <span className="spinner" />
          <span className="ps-job-text" title={j.label}>
            {STEP_TEXT[j.step]} · {j.label}
          </span>
          <button className="ps-clear static" title="Stop" aria-label="Stop" onClick={() => cancelImport(j.id)}>
            <Cross />
          </button>
        </div>
      ))}

      {status === 'searching' && (
        <div className="ps-job">
          <span className="spinner" />
          <span className="ps-job-text">Searching for {query}</span>
        </div>
      )}

      {results.length > 0 && (
        <ul className="ps-results">
          {results.map((r) => (
            <ResultRow
              key={r.id}
              result={r}
              job={jobs.find((j) => j.key === `search:${r.id}`)}
              added={sources.some((s) => sameProduct(r, s))}
              units={units}
            />
          ))}
        </ul>
      )}

      {message && <div className={`hint ps-note ${status === 'error' ? 'error' : ''}`}>{message}</div>}

      {(status === 'done' || status === 'error') && (
        <button className="ps-describe" title={`Model “${query}” without a real product`} onClick={() => void startImport(query)}>
          Build from this description instead
        </button>
      )}
      </div>
      )}
    </div>
  );
}
