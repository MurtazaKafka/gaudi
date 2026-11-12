import { useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react';
import { PanelShell } from './PanelShell';
import { PlanThumb } from './PlanThumb';
import { aiReady, ensureApiKey, useKeyStore } from '../ai/client';
import { cancelPreview, usePreviewStore } from '../preview';
import { usePlanStore } from '../store';
import { toast } from '../toast';
import { useUiStore } from '../uiStore';
import { formatArea, formatLengthShort, parseLength, SQFT_PER_M2, useUnits } from '../units';
import type { Point, Units } from '../types';
import {
  areaNeed,
  FIT_LABEL,
  fitOf,
  MAX_BATHROOMS,
  MAX_BEDROOMS,
  mentionsMultiStorey,
  SHAPES,
  SPACES,
  type Brief,
  type ShapeId,
} from '../generate/brief';
import { programFit } from '../generate/fill';
import type { Outline } from '../generate/outline';
import {
  applyBriefText,
  cancelRun,
  drawOutline,
  forgetStaleOptions,
  generate,
  outlineOf,
  previewOption,
  roomsOf,
  setBrief,
  setUseOutline,
  squareOffOutline,
  toggleKeep,
  useGenerateStore,
  type GenOption,
} from '../generate/run';
import type { PlanRoom } from '../generate/keep';
import { scoreClean, scoreLine } from '../generate/score';
import type { PresetShape } from '../generate/shapes';
// Loaded for its side effect in dev: registers window.__gaudi.generate at startup.
import '../generate/api';
import '../styles/generate.css';
import '../styles/shapes.css';

/** "104 m²" · "1,120 ft²" — whole numbers, in the plan's units. */
function areaText(m2: number, units: Units): string {
  return formatArea(Math.round(m2), units).replace(/\.0(?=\s)/, '');
}

const areaUnit = (units: Units): string => formatArea(0, units).replace(/^[\d.,]+\s*/, '');

function Stepper({
  label,
  title,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="gen-count" title={title}>
      <span className="label">{label}</span>
      <div className="stepper">
        <button aria-label={`Fewer ${title.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
          −
        </button>
        <span>{value}</span>
        <button aria-label={`More ${title.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </div>
  );
}

const SHAPE_PATH: Record<Exclude<ShapeId, 'any'>, string> = {
  rect: 'M3.5 5.5h15v11h-15z',
  L: 'M3.5 3.5h7v8h8v7h-15z',
  U: 'M3.5 3.5h5.5v8h4v-8h5.5v15h-15z',
  T: 'M3.5 3.5h15v6h-4.75v9h-5.5v-9H3.5z',
  C: 'M3.5 3.5h15v5.5h-8.5v4h8.5v5.5h-15z',
  bar: 'M2.5 8.5h17v5h-17z',
  Z: 'M8.5 4.5h10v6.5h-5v6.5h-10v-6.5h5z',
  H: 'M3.5 3.5h5v5.5h5v-5.5h5v15h-5v-5.5h-5v5.5h-5z',
  plus: 'M8 3.5h6v4.5h4.5v6h-4.5v4.5h-6v-4.5H3.5v-6H8z',
  step: 'M3.5 12.5h5v-4.5h5v-4.5h5v15h-15z',
};

export function ShapeIcon({ id }: { id: ShapeId }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      {id === 'any' ? (
        <path d="M4.5 4.5h13v13h-13z" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 2.2" />
      ) : (
        <path d={SHAPE_PATH[id]} fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** The outline on the canvas, drawn to scale as its own pictogram. */
function OutlineIcon({ polygon }: { polygon: readonly Point[] }) {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0 || 1;
  const h = Math.max(...ys) - y0 || 1;
  const k = 15 / Math.max(w, h);
  const ox = 11 - (w * k) / 2;
  const oy = 11 - (h * k) / 2;
  const d = `${polygon.map((p, i) => `${i ? 'L' : 'M'}${(ox + (p.x - x0) * k).toFixed(2)} ${(oy + (p.y - y0) * k).toFixed(2)}`).join('')}z`;
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d={d} fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="17.5" cy="4.5" r="2" fill="currentColor" />
    </svg>
  );
}

/** "14.0 × 9.5 m" · "45′11″ × 31′2″" */
function dimsText(w: number, h: number, units: Units): string {
  return units === 'm'
    ? `${w.toFixed(1)} × ${h.toFixed(1)} m`
    : `${formatLengthShort(w, units)} × ${formatLengthShort(h, units)}`;
}

const list = (names: string[]) => names.map((n) => n.toLowerCase()).join(', ');

/** In place of the size stepper when an outline decides the size: what it measures and how the rooms sit in it. */
function OutlineSize({ brief, outline, units }: { brief: Brief; outline: Outline; units: Units }) {
  const fit = programFit(brief, outline.area);
  const tone = fit.dropped.length > 0 || fit.ratio < 0.85 ? 'tight' : 'good';
  const word =
    fit.dropped.length > 0 ? 'too small' : fit.ratio < 0.85 ? 'tight' : fit.ratio <= 1.3 ? 'good fit' : fit.ratio <= 1.7 ? 'roomy' : 'very roomy';
  return (
    <div className="panel-section">
      <div className="row between">
        <span className="label">Your outline</span>
        <span className="shape-dims mono">
          {dimsText(outline.box.w, outline.box.h, units)} · {areaText(outline.area, units)}
        </span>
      </div>
      <div className="hint">
        Rooms need about <span className="mono">{areaText(fit.ideal, units)}</span>
        {' · '}
        <span className={`gen-fit ${tone}`}>{word}</span>
      </div>
      {fit.dropped.length > 0 ? (
        <div className="hint error">Not everything fits — options will leave out {list(fit.dropped)}.</div>
      ) : fit.ratio > 1.7 ? (
        <div className="hint">Far more room than these rooms need — they will run large.</div>
      ) : null}
    </div>
  );
}

/** In place of size and shape while rooms are being kept: how much is re-planned, and whether the rest of the brief fits there. */
function KeepSize({ brief, rooms, keep, units }: { brief: Brief; rooms: PlanRoom[]; keep: string[]; units: Units }) {
  const kept = rooms.filter((r) => keep.includes(r.key));
  const rest = rooms.filter((r) => !keep.includes(r.key));
  const area = rest.reduce((s, r) => s + r.area, 0);
  const fit = programFit(brief, area, [], kept.flatMap((r) => r.types));
  const angled = rooms.some((r) => r.rects.length === 0);
  return (
    <div className="panel-section">
      <div className="row between">
        <span className="label">Re-plan</span>
        <span className="shape-dims mono">
          {areaText(area, units)} of {areaText(area + kept.reduce((s, r) => s + r.area, 0), units)}
        </span>
      </div>
      {angled ? (
        <div className="hint error">This plan has angled walls, which can’t be re-planned around yet.</div>
      ) : rest.length === 0 ? (
        <div className="hint error">Every room is kept — nothing left to re-plan.</div>
      ) : (
        <div className="hint">
          {kept.length === 1 ? `${kept[0].name} stays` : `${kept.length} rooms stay`} where {kept.length === 1 ? 'it is' : 'they are'}; the rest of the brief is fitted around {kept.length === 1 ? 'it' : 'them'}.
          {fit.dropped.length > 0 && <span className="gen-fit tight"> Too small for {list(fit.dropped)}.</span>}
        </div>
      )}
    </div>
  );
}

/** Commit on blur or Enter; the field re-reads the brief whenever it changes (via `key`). */
function commitOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') e.currentTarget.blur();
}

function SizeSection({ brief, units }: { brief: Brief; units: Units }) {
  const need = areaNeed(brief);
  const fit = fitOf(brief);
  const step = units === 'm' ? 10 : 100;
  const toDisplay = (m2: number) => (units === 'm' ? Math.round(m2) : Math.round((m2 * SQFT_PER_M2) / 10) * 10);
  const fromDisplay = (v: number) => (units === 'm' ? v : v / SQFT_PER_M2);
  const shown = brief.area === null ? null : toDisplay(brief.area);
  const bump = (dir: 1 | -1) => {
    const from = shown ?? Math.round(toDisplay(need.ideal) / step) * step - (dir === 1 ? step : 0);
    setBrief({ area: fromDisplay(Math.max(step, from + dir * step)) });
  };
  const lotArea = brief.lot ? brief.lot.w * brief.lot.d : null;
  // A house never fills its lot to the last corner.
  const lotShort = lotArea !== null && lotArea * 0.95 < (brief.area ?? need.min);
  // Where the target sits between "half what the rooms need" and "1.6×".
  const marker = brief.area === null ? null : Math.min(1, Math.max(0, (brief.area / need.ideal - 0.5) / 1.1));

  return (
    <div className="panel-section">
      <div className="row between">
        <span className="label">Size</span>
        <div className="gen-size">
          <div className="stepper">
            <button aria-label="Smaller" onClick={() => bump(-1)}>
              −
            </button>
            <input
              key={`${units}:${brief.area}`}
              className="gen-size-input"
              aria-label={`Target floor area in ${areaUnit(units)}`}
              inputMode="numeric"
              placeholder="Any"
              defaultValue={shown === null ? '' : shown.toLocaleString('en-US')}
              onKeyDown={commitOnEnter}
              onBlur={(e) => {
                const el = e.currentTarget;
                const text = el.value.replace(/[,\s]/g, '');
                const v = parseFloat(text);
                if (text === '') setBrief({ area: null });
                else if (Number.isFinite(v) && v > 0 && v !== shown) setBrief({ area: fromDisplay(v) });
                // Unreadable, unchanged or clamped: show what the brief actually holds.
                const now = useGenerateStore.getState().brief.area;
                el.value = now === null ? '' : toDisplay(now).toLocaleString('en-US');
              }}
            />
            <button aria-label="Larger" onClick={() => bump(1)}>
              +
            </button>
          </div>
          <span className="gen-unit">{areaUnit(units)}</span>
        </div>
      </div>
      {marker !== null && (
        <div className="gen-meter" aria-hidden="true">
          <span className="gen-meter-good" />
          <span className="gen-meter-mark" style={{ left: `${marker * 100}%` }} />
        </div>
      )}
      <div className="hint">
        {brief.area === null ? 'These rooms need about ' : 'Rooms need about '}
        <span className="mono">{areaText(need.ideal, units)}</span>
        {fit && (
          <>
            {' · '}
            <span className={`gen-fit ${fit}`}>{FIT_LABEL[fit]}</span>
          </>
        )}
      </div>
      {lotShort && lotArea !== null && (
        <div className="hint error">
          The lot holds {areaText(lotArea, units)} at most — options will be sized down.
        </div>
      )}
    </div>
  );
}

function LotRow({ brief, units }: { brief: Brief; units: Units }) {
  const wRef = useRef<HTMLInputElement>(null);
  const dRef = useRef<HTMLInputElement>(null);
  const commit = () => {
    const wt = wRef.current?.value.trim() ?? '';
    const dt = dRef.current?.value.trim() ?? '';
    if (!wt && !dt) {
      if (brief.lot) setBrief({ lot: null });
      return;
    }
    const w = parseLength(wt, units);
    const d = parseLength(dt, units);
    // Half-filled or unreadable: wait for the other number.
    if (w === null || d === null || w < 3 || d < 3) return;
    if (!brief.lot || Math.abs(brief.lot.w - w) > 0.005 || Math.abs(brief.lot.d - d) > 0.005) setBrief({ lot: { w, d } });
  };
  // A field is made afresh when its own value changes, to show it as understood. Each on its own:
  // committing the width must not take the depth field out from under the Tab that is moving to it.
  const wKey = `w${units}:${brief.lot?.w}`;
  const dKey = `d${units}:${brief.lot?.d}`;
  // When both change at once (the lot is first set, or cleared) the field that focus is moving
  // to is one of the fresh ones: hand the focus on to it.
  const moving = useRef<{ to: 'w' | 'd'; from: EventTarget } | null>(null);
  const onBlur = (e: FocusEvent<HTMLInputElement>) => {
    const to = e.relatedTarget;
    moving.current = to && to === wRef.current ? { to: 'w', from: to } : to && to === dRef.current ? { to: 'd', from: to } : null;
    commit();
  };
  useLayoutEffect(() => {
    const move = moving.current;
    moving.current = null;
    const el = move ? (move.to === 'w' ? wRef : dRef).current : null;
    if (move && el && el !== move.from) {
      el.focus();
      el.select();
    }
  }, [wKey, dKey]);
  return (
    <div className="row between">
      <span className="label" title="The house will fit inside this box">
        Lot
      </span>
      <div className="gen-lot">
        <input
          key={wKey}
          ref={wRef}
          className="input mono"
          aria-label="Lot width"
          placeholder="width"
          defaultValue={brief.lot ? formatLengthShort(brief.lot.w, units) : ''}
          onBlur={onBlur}
          onKeyDown={commitOnEnter}
        />
        <span className="gen-unit">×</span>
        <input
          key={dKey}
          ref={dRef}
          className="input mono"
          aria-label="Lot depth"
          placeholder="depth"
          defaultValue={brief.lot ? formatLengthShort(brief.lot.d, units) : ''}
          onBlur={onBlur}
          onKeyDown={commitOnEnter}
        />
      </div>
    </div>
  );
}

function OptionCard({ option, active, units, mixed }: { option: GenOption; active: boolean; units: Units; mixed: boolean }) {
  if (option.status !== 'ready' || !option.plan || !option.score) {
    return (
      <div className={`gen-card ${option.status}`}>
        <span className="gen-letter">{option.letter}</span>
        <div className="gen-thumb">{option.status === 'pending' && <span className="spinner" />}</div>
        <div className="gen-meta">
          <div className="gen-title">{option.title}</div>
          <div className="hint">{option.status === 'pending' ? 'Drafting…' : option.error ?? 'Didn’t work out.'}</div>
        </div>
      </div>
    );
  }
  const s = option.score;
  const toggle = () => (active ? cancelPreview() : previewOption(option.id));
  return (
    <div
      className={`gen-card ready ${active ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      title={option.summary}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <span className="gen-letter">{option.letter}</span>
      <div className="gen-thumb">
        <PlanThumb plan={option.plan} width={92} height={72} showFurniture={false} />
      </div>
      <div className="gen-meta">
        <div className="gen-title">{option.title}</div>
        <div className="gen-facts">
          {s.bedrooms.got === 0 ? 'Studio' : `${s.bedrooms.got} bed`} · {s.bathrooms.got} bath · {areaText(s.area, units)}
        </div>
        <div className={`gen-score ${scoreClean(s) ? '' : 'off'}`}>{scoreLine(s)}</div>
        <div className="gen-card-foot">
          <button
            className="gen-link gen-more"
            onClick={(e) => {
              e.stopPropagation();
              generate(option.id);
            }}
          >
            More like this
          </button>
          {mixed && option.engine === 'builtin' && <span className="gen-tag">built-in</span>}
        </div>
      </div>
    </div>
  );
}

/** Brief in, a handful of layouts out. */
export function GeneratePanel() {
  const units = useUnits();
  const brief = useGenerateStore((s) => s.brief);
  const options = useGenerateStore((s) => s.options);
  const running = useGenerateStore((s) => s.running);
  const engine = useGenerateStore((s) => s.engine);
  const note = useGenerateStore((s) => s.note);
  const activeId = useGenerateStore((s) => s.activeId);
  const seedText = useUiStore((s) => s.generateSeed);
  const readOnly = useUiStore((s) => s.readOnly);
  const previewing = usePreviewStore((s) => s.active);
  // Re-render when a key is added or removed; aiReady() also counts a dev mock.
  useKeyStore((s) => s.hasKey);
  const claude = aiReady();
  const blocked = readOnly && !previewing;
  const resultsRef = useRef<HTMLDivElement>(null);
  // The person's own plan (under a preview the store holds the candidate): is it a bare outline?
  const liveWalls = usePlanStore((s) => s.walls);
  const stash = usePreviewStore((s) => s.stash);
  const outlineOff = useGenerateStore((s) => s.outlineOff);
  const outline = outlineOf(previewing && stash ? stash.walls : liveWalls);
  const filling = outline !== null && !outline.issue && outlineOff !== outline.key;
  const outlineKey = outline?.key ?? null;
  // Rooms of the person's plan that a run can leave alone.
  const liveNames = usePlanStore((s) => s.roomNames);
  const keepAll = useGenerateStore((s) => s.keep);
  const rooms = roomsOf(previewing && stash ? stash.walls : liveWalls, previewing && stash ? stash.roomNames : liveNames);
  const keep = rooms.length >= 2 ? keepAll.filter((k) => rooms.some((r) => r.key === k)) : [];
  const keeping = keep.length > 0;
  const shapeLabel = filling ? 'Your outline' : SHAPES.find((s) => s.id === brief.shape)?.label ?? '';

  // Options fitted to an outline that has since been reshaped no longer fit it.
  useEffect(() => {
    forgetStaleOptions(outlineKey);
  }, [outlineKey]);

  // Text handed over by the command bar or the empty state becomes the wish line.
  useEffect(() => {
    if (!seedText) return;
    applyBriefText(seedText);
    useUiStore.setState({ generateSeed: '' });
  }, [seedText]);

  const run = () => {
    if (blocked) return;
    generate();
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };

  const done = options.filter((o) => o.status !== 'pending').length;
  const mixed = engine === 'claude' && options.some((o) => o.engine === 'builtin');

  return (
    <PanelShell
      title="Generate"
      foot={
        running ? (
          <>
            <span className="gen-progress">
              <span className="spinner" /> Drafting {Math.min(done + 1, options.length)} of {options.length}
            </span>
            <button className="btn" onClick={cancelRun}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn primary block" disabled={blocked} onClick={run}>
            {keeping ? 'Regenerate the rest' : options.length ? 'Generate again' : 'Generate'}
          </button>
        )
      }
    >
      <div className="panel-section">
        <div className="gen-counts">
          <Stepper label="Beds" title="Bedrooms" value={brief.bedrooms} min={0} max={MAX_BEDROOMS} onChange={(bedrooms) => setBrief({ bedrooms })} />
          <Stepper label="Baths" title="Bathrooms" value={brief.bathrooms} min={1} max={MAX_BATHROOMS} onChange={(bathrooms) => setBrief({ bathrooms })} />
        </div>
        <div className="gen-chips">
          {SPACES.map((s) => (
            <button
              key={s.id}
              className={`chip ${brief.spaces[s.id] ? 'active' : ''}`}
              aria-pressed={brief.spaces[s.id]}
              title={s.hint}
              onClick={() => setBrief({ spaces: { ...brief.spaces, [s.id]: !brief.spaces[s.id] } })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {keeping ? (
        <KeepSize brief={brief} rooms={rooms} keep={keep} units={units} />
      ) : filling && outline ? (
        <OutlineSize brief={brief} outline={outline} units={units} />
      ) : (
        <SizeSection brief={brief} units={units} />
      )}

      {rooms.length >= 2 && (
        <div className="panel-section">
          <div className="row between">
            <span className="label">Keep</span>
            <span className="shape-picked">{keeping ? 'The rest is re-planned' : 'Rooms to leave as they are'}</span>
          </div>
          <div className="shape-keep">
            {rooms.map((r) => (
              <button
                key={r.key}
                className={`chip ${keep.includes(r.key) ? 'active' : ''}`}
                aria-pressed={keep.includes(r.key)}
                title={`${r.name} · ${areaText(r.area, units)}`}
                onClick={() => {
                  toggleKeep(r.key);
                  // Show which room that is.
                  if (!readOnly) useUiStore.getState().setRoomSelection(r.key);
                }}
              >
                {r.name === 'Room' ? `Room · ${areaText(r.area, units)}` : r.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {!keeping && (
        <div className="panel-section">
          <div className="row between">
            <span className="label">Shape</span>
            <span className="shape-picked">
              {shapeLabel}
              {!filling && brief.shape !== 'any' && (
                <>
                  {' · '}
                  <button
                    className="gen-link"
                    disabled={readOnly}
                    title="Put this footprint on the canvas as walls you can drag, sized for these rooms"
                    onClick={() => drawOutline(brief.shape as PresetShape)}
                  >
                    Draw outline
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="shape-grid" role="radiogroup" aria-label="House shape">
            {outline && (
              <button
                role="radio"
                aria-checked={filling}
                className={`icon-btn ${filling ? 'active' : ''}`}
                disabled={outline.issue !== null}
                title={outline.issue ? 'Your outline — can’t be filled as it is' : 'Your outline — fit the rooms inside what you drew'}
                aria-label="Your outline"
                onClick={() => setUseOutline(true)}
              >
                <OutlineIcon polygon={outline.polygon} />
              </button>
            )}
            {SHAPES.map((s) => {
              const on = !filling && brief.shape === s.id;
              return (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={on}
                  className={`icon-btn ${on ? 'active' : ''}`}
                  title={s.label}
                  aria-label={s.label}
                  onClick={() => {
                    setBrief({ shape: s.id });
                    setUseOutline(false);
                  }}
                >
                  <ShapeIcon id={s.id} />
                </button>
              );
            })}
          </div>
          {outline?.issue && (
            <div className="hint error">
              {outline.issue === 'angled'
                ? 'Your outline has angled walls. Rooms can only be fitted into square corners for now. '
                : 'Your outline has a step too narrow for a room. '}
              <button className="gen-link" disabled={readOnly} onClick={squareOffOutline}>
                Square it off
              </button>
            </div>
          )}
          {!filling && <LotRow brief={brief} units={units} />}
        </div>
      )}

      <div className="panel-section">
        <textarea
          className="textarea gen-wishes"
          aria-label="Wishes"
          rows={2}
          placeholder="Wishes — open kitchen, bedrooms away from the street…"
          maxLength={300}
          value={brief.wishes}
          onChange={(e) => setBrief({ wishes: e.target.value.replace(/\n/g, ' ') })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!running) run();
          }}
        />
        {mentionsMultiStorey(brief.wishes) && (
          <div className="hint">Single-storey only for now — this will be drawn on one floor.</div>
        )}
        {!claude && (
          <div className="hint">
            {brief.wishes.trim() ? 'Wishes need Claude; the built-in drafter reads the rest. ' : 'No key needed — a built-in drafter draws these. '}
            <button
              className="gen-link"
              onClick={() => void ensureApiKey().then((ok) => ok && toast('Claude is connected.'))}
            >
              Connect Claude for smarter layouts
            </button>
          </div>
        )}
        {blocked && <div className="hint">This plan is view-only, so nothing can be generated into it.</div>}
      </div>

      {options.length > 0 && (
        <div className="panel-section" ref={resultsRef}>
          <div className="row between">
            <span className="label">Options</span>
            <span className="hint">{engine === 'claude' ? 'Drawn by Claude' : 'Drawn by the built-in drafter'}</span>
          </div>
          {note && <div className="hint">{note}</div>}
          <div className="gen-cards">
            {options.map((o) => (
              <OptionCard key={o.id} option={o} active={previewing && o.id === activeId} units={units} mixed={mixed} />
            ))}
          </div>
          <div className="hint">
            {previewing && activeId ? (
              <>
                On the canvas now. <span className="kbd">B</span> shows it in 3D; the banner keeps it.
              </>
            ) : (
              'Click one to try it on the canvas.'
            )}
          </div>
        </div>
      )}
      {options.length === 0 && note && <div className="hint error">{note}</div>}
    </PanelShell>
  );
}
