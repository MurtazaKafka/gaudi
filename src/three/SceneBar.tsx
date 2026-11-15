import { useCallback, useRef, useState } from 'react';
import { useRenderStore } from './render/renderStore';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { useDismiss } from '../components/useDismiss';
import type { RoofKind } from '../types';
import { chooseRoof, chooseStyle } from './lookActions';
import { effectiveRoof, ROOF_LABELS, STYLES, styleById } from './styles';
import type { HouseStyle } from './styles';
import { formatHour, SUN_MAX, SUN_MIN, useViewStore, SHOTS } from './viewStore';
import type { SceneView } from './viewStore';

const VIEWS: { id: SceneView; label: string; key: string; title: string }[] = [
  { id: 'dollhouse', label: 'Dollhouse', key: '1', title: 'Look in from above, roof off' },
  { id: 'exterior', label: 'Exterior', key: '2', title: 'The house from outside, roof on' },
  { id: 'walk', label: 'Walk', key: '3', title: 'Step inside and walk around' },
];

const ROOFS: RoofKind[] = ['none', 'flat', 'gable', 'hip'];

function Swatch({ style }: { style: HouseStyle }) {
  return (
    <span
      className="scene-swatch"
      aria-hidden
      style={{
        background: `linear-gradient(90deg, ${style.cladding} 0 34%, ${style.floors.living.color} 34% 67%, ${style.door} 67%)`,
      }}
    />
  );
}

const Caret = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
    <path d="M1.5 5.2L4 2.8l2.5 2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

/** The one control strip for the model: view, style, roof, sun, snapshot, reset. */
export function SceneBar({ onSnapshot }: { onSnapshot: () => void }) {
  const view = useViewStore((s) => s.view);
  const walking = useViewStore((s) => s.walking);
  const sunHour = useViewStore((s) => s.sunHour);
  const look = usePlanStore((s) => s.look);
  const readOnly = useUiStore((s) => s.readOnly);
  const style = styleById(look?.style);
  const roof: RoofKind = ROOFS.includes(look?.roof) ? look.roof : 'none';

  const [menu, setMenu] = useState<'style' | 'roof' | 'shot' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), [setMenu]);
  useDismiss(ref, menu !== null, closeMenu);

  // The roof Exterior shows when the plan has none of its own (a view-time choice, never saved).
  const shown = effectiveRoof(roof, style, view === 'exterior');
  const auto = roof === 'none' && shown !== 'none';
  const locked = readOnly ? 'View only' : undefined;

  return (
    <div className="float-bar bottom scene-bar" ref={ref}>
      <div className="seg" role="group" aria-label="View">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={view === v.id ? 'active' : ''}
            title={`${v.title} — ${v.key}`}
            onClick={() => useViewStore.getState().setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <span className="float-rule" />

      <div className="pop-anchor">
        <button
          className={`btn small quiet scene-pick ${menu === 'style' ? 'active' : ''}`}
          disabled={readOnly}
          title={locked ?? 'Style'}
          aria-haspopup="menu"
          aria-expanded={menu === 'style'}
          onClick={() => setMenu(menu === 'style' ? null : 'style')}
        >
          <Swatch style={style} />
          {style.label}
          <Caret />
        </button>
        {menu === 'style' && (
          <div className="menu up left" role="menu">
            <div className="menu-label">Style</div>
            {STYLES.map((s) => (
              <button
                key={s.id}
                role="menuitemradio"
                aria-checked={s.id === style.id}
                className={`menu-item ${s.id === style.id ? 'scene-current' : ''}`}
                onClick={() => {
                  chooseStyle(s.id);
                  setMenu(null);
                }}
              >
                <span className="row">
                  <Swatch style={s} />
                  {s.label}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pop-anchor">
        <button
          className={`btn small quiet scene-pick ${menu === 'roof' ? 'active' : ''}`}
          disabled={readOnly}
          title={locked ?? 'Roof'}
          aria-haspopup="menu"
          aria-expanded={menu === 'roof'}
          onClick={() => setMenu(menu === 'roof' ? null : 'roof')}
        >
          Roof
          <span className="scene-pick-value">{ROOF_LABELS[auto ? shown : roof]}</span>
          <Caret />
        </button>
        {menu === 'roof' && (
          <div className="menu up left scene-roof-menu" role="menu">
            <div className="menu-label">Roof</div>
            {ROOFS.map((r) => {
              const current = auto ? r === shown : r === roof;
              return (
                <button
                  key={r}
                  role="menuitemradio"
                  aria-checked={current}
                  className={`menu-item ${current ? 'scene-current' : ''}`}
                  onClick={() => {
                    chooseRoof(r);
                    setMenu(null);
                  }}
                >
                  {ROOF_LABELS[r]}
                  {auto && r === shown && <span className="menu-meta">auto</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <span className="float-rule" />

      <label className="scene-sun" title="Time of day">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="2.8" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="range"
          aria-label="Time of day"
          min={SUN_MIN}
          max={SUN_MAX}
          step={0.25}
          value={sunHour}
          onChange={(e) => useViewStore.getState().setSunHour(parseFloat(e.target.value))}
          onPointerUp={(e) => e.currentTarget.blur()}
          onDoubleClick={() => useViewStore.getState().setSunHour(12)}
        />
        <span className="scene-sun-time mono">{formatHour(sunHour)}</span>
      </label>

      <span className="float-rule" />

      <button
        className="btn small accent"
        title="Render this view with realistic light and shadows — R"
        disabled={walking}
        onClick={() => useRenderStore.getState().start()}
      >
        Render
      </button>
      <button className="icon-btn" title="Save a picture — S" aria-label="Save a picture" onClick={onSnapshot}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M2.2 5.2h2.3l1-1.6h5l1 1.6h2.3v7.6H2.2z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="8.8" r="2.3" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <div className="pop-anchor">
        <button
          className={`btn small quiet ${menu === 'shot' ? 'active' : ''}`}
          title="Camera positions"
          aria-haspopup="menu"
          aria-expanded={menu === 'shot'}
          disabled={walking}
          onClick={() => setMenu(menu === 'shot' ? null : 'shot')}
        >
          Shot
        </button>
        {menu === 'shot' && (
          <div className="menu up" role="menu">
            <div className="menu-label">Camera</div>
            {SHOTS.map((s) => (
              <button
                key={s.id}
                role="menuitem"
                className="menu-item"
                title={s.hint}
                onClick={() => {
                  useViewStore.getState().takeShot(s.id);
                  setMenu(null);
                }}
              >
                {s.label}
                <span className="menu-meta">{s.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        className="icon-btn"
        title="Reset the view — 0"
        aria-label="Reset the view"
        onClick={() => useViewStore.getState().resetView()}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
