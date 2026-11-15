/**
 * What an empty canvas shows: every way to get a house, on one sheet.
 * The brief here is the Generate panel's brief (same store), so whatever is
 * picked carries over when "More options" opens the panel.
 */
import { useMemo, useState } from 'react';
import { PlanThumb } from './PlanThumb';
import { ShapeIcon } from './GeneratePanel';
import { useUiStore } from '../uiStore';
import { formatArea, useUnits } from '../units';
import { MAX_BATHROOMS, MAX_BEDROOMS, SHAPES, SPACES } from '../generate/brief';
import { applyBriefText, drawOutline, generate, setBrief, useGenerateStore } from '../generate/run';
import { createFromTemplate } from '../projects/projectStore';
import { startDemo } from '../demo/tour';
import { buildTemplate, TEMPLATES, type Template } from '../projects/templates';
import { measurePlan } from '../projects/library';
import type { PlanData } from '../types';
import '../styles/start.css';

const tileCache = new Map<string, { plan: PlanData; area: number }>();
function tileFor(t: Template): { plan: PlanData; area: number } {
  let tile = tileCache.get(t.id);
  if (!tile) {
    const { plan } = buildTemplate(t);
    tile = { plan, area: measurePlan(plan).area };
    tileCache.set(t.id, tile);
  }
  return tile;
}

function Count({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="st-count">
      <span className="label">{label}</span>
      <div className="stepper">
        <button aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= (label === 'Bedrooms' ? 0 : 1)} onClick={() => onChange(value - 1)}>
          −
        </button>
        <span>{value}</span>
        <button aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </div>
  );
}

export function StartScreen({ onDismiss }: { onDismiss: () => void }) {
  const brief = useGenerateStore((s) => s.brief);
  const units = useUnits();
  const [words, setWords] = useState('');
  const tiles = useMemo(() => TEMPLATES.map((t) => ({ t, ...tileFor(t) })), []);

  const run = () => {
    const ui = useUiStore.getState();
    ui.setPanel('generate');
    generate();
  };

  const runFromWords = () => {
    if (!words.trim()) return;
    applyBriefText(words.trim());
    run();
  };

  return (
    <div className="start" role="dialog" aria-label="Start a house">
      <div className="st-head">
        <div>
          <div className="st-title">Design a house</div>
          <div className="hint">Pick what you need — Gaudí draws five layouts to compare, then builds the one you choose in 3D.</div>
          <button className="st-demo" onClick={startDemo}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 1l7 4-7 4z" fill="currentColor" />
            </svg>
            Watch the one-minute demo
          </button>
        </div>
        <button className="icon-btn" title="Start from a blank canvas" aria-label="Close" onClick={onDismiss}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <section className="st-section">
        <div className="st-row">
          <Count label="Bedrooms" value={brief.bedrooms} max={MAX_BEDROOMS} onChange={(v) => setBrief({ bedrooms: v })} />
          <Count label="Bathrooms" value={brief.bathrooms} max={MAX_BATHROOMS} onChange={(v) => setBrief({ bathrooms: v })} />
        </div>

        <div className="st-block">
          <span className="label">Shape</span>
          <div className="st-shapes">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                className={`st-shape ${brief.shape === s.id ? 'active' : ''}`}
                title={s.id === 'any' ? 'Let Gaudí try different shapes' : s.label}
                aria-pressed={brief.shape === s.id}
                onClick={() => setBrief({ shape: s.id })}
              >
                <ShapeIcon id={s.id} />
                <span>{s.id === 'any' ? 'Any' : s.label.replace(/ shape$/, '').replace(/ \(.\)$/, '')}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="st-block">
          <span className="label">Rooms</span>
          <div className="st-chips">
            {SPACES.map((sp) => (
              <button
                key={sp.id}
                className={`chip ${brief.spaces[sp.id] ? 'active' : ''}`}
                title={sp.hint}
                aria-pressed={brief.spaces[sp.id]}
                onClick={() => setBrief({ spaces: { ...brief.spaces, [sp.id]: !brief.spaces[sp.id] } })}
              >
                {sp.label}
              </button>
            ))}
          </div>
        </div>

        <div className="st-actions">
          <button className="btn primary" onClick={run}>
            Generate 5 layouts
          </button>
          <button className="btn quiet" onClick={() => useUiStore.getState().setPanel('generate')}>
            More options — size, lot, wishes
          </button>
        </div>

        <div className="st-words">
          <input
            className="input"
            placeholder="Or describe it — “3 bed L-shaped bungalow with an office and a garage”"
            value={words}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') runFromWords();
            }}
          />
          <button className="btn" disabled={!words.trim()} onClick={runFromWords}>
            Generate
          </button>
        </div>
      </section>

      <section className="st-section">
        <span className="label">Or start from a template</span>
        <div className="st-templates">
          {tiles.map(({ t, plan, area }) => (
            <button key={t.id} className="st-template" title={`${t.name} — ${t.note}`} onClick={() => createFromTemplate(t.id)}>
              <PlanThumb plan={plan} width={80} height={54} />
              <span className="st-template-name">{t.name}</span>
              <span className="st-template-sub mono">{formatArea(area, units)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="st-section st-draw">
        <span className="label">Or draw it yourself</span>
        <div className="st-row">
          <button
            className="btn"
            onClick={() => {
              useUiStore.getState().setTool('wall');
              onDismiss();
            }}
          >
            Draw walls <span className="kbd">W</span>
          </button>
          <button
            className="btn"
            title="Puts the chosen shape on the canvas as walls — drag them into proportion, then fill it with rooms"
            onClick={() => {
              drawOutline(brief.shape === 'any' ? 'L' : brief.shape);
              onDismiss();
            }}
          >
            Draw {brief.shape === 'any' ? 'an L shape' : 'this shape'} as walls
          </button>
        </div>
      </section>
    </div>
  );
}

/** A bare outline on the canvas (walls, one room, nothing inside): offer to fill it. */
export function FillOutlineBar({ area }: { area: number }) {
  const units = useUnits();
  return (
    <div className="float-bar bottom st-fill">
      <span className="hint">
        Your outline · <span className="mono">{formatArea(area, units)}</span>
      </span>
      <button
        className="btn primary small"
        onClick={() => {
          useUiStore.getState().setPanel('generate');
          generate();
        }}
      >
        Fill it with rooms
      </button>
      <button className="btn small quiet" onClick={() => useUiStore.getState().setPanel('generate')}>
        Choose rooms first
      </button>
    </div>
  );
}
