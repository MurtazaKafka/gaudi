import { useCallback, useRef, useState } from 'react';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { ensureApiKey, setApiKey, useKeyStore } from '../ai/client';
import { fromMeters, parseLength, unitSuffix } from '../units';
import { useDismiss } from './useDismiss';

function LengthField({
  label,
  meters,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  meters: number;
  /** bounds in meters */
  min: number;
  max: number;
  disabled: boolean;
  onChange: (m: number) => void;
}) {
  const units = usePlanStore((s) => s.settings.units);
  const shown = String(Math.round(fromMeters(meters, units) * 100) / 100);
  // Type freely; the value is read and clamped only on Enter or blur.
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const m = parseLength(draft, units);
    if (m !== null && Number.isFinite(m)) onChange(Math.min(max, Math.max(min, m)));
    setDraft(null);
  };

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="row" style={{ gap: 6 }}>
        <input
          type="text"
          inputMode="decimal"
          value={draft ?? shown}
          disabled={disabled}
          aria-label={label}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="field-unit">{unitSuffix(units)}</span>
      </span>
    </label>
  );
}

/** Gear menu: units, wall dimensions, display toggles, API key. Rarely-touched things live here. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, useCallback(() => setOpen(false), []));

  const settings = usePlanStore((s) => s.settings);
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const readOnly = useUiStore((s) => s.readOnly);
  const showDimensions = useUiStore((s) => s.showDimensions);
  const drawingLook = useUiStore((s) => s.drawingLook);
  const hasKey = useKeyStore((s) => s.hasKey);

  return (
    <div className="pop-anchor" ref={ref}>
      <button
        className={`icon-btn ${open ? 'active' : ''}`}
        title="Settings"
        aria-label="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div className="menu settings-pop">
          <div className="menu-pad">
            <div className="row between">
              <span className="label">Units</span>
              <div className="seg">
                <button
                  className={settings.units === 'm' ? 'active' : ''}
                  disabled={readOnly}
                  onClick={() => updateSettings({ units: 'm' })}
                >
                  Meters
                </button>
                <button
                  className={settings.units === 'ft' ? 'active' : ''}
                  disabled={readOnly}
                  onClick={() => updateSettings({ units: 'ft' })}
                >
                  Feet
                </button>
              </div>
            </div>
            <LengthField
              label="Wall height"
              meters={settings.wallHeight}
              min={2}
              max={6}
              disabled={readOnly}
              onChange={(v) => updateSettings({ wallHeight: v })}
            />
            <LengthField
              label="Wall thickness"
              meters={settings.wallThickness}
              min={0.05}
              max={0.5}
              disabled={readOnly}
              onChange={(v) => updateSettings({ wallThickness: v })}
            />
            <div className="row between">
              <span className="label">Wall dimensions</span>
              <button
                className={`switch ${showDimensions ? 'on' : ''}`}
                aria-label="Show wall dimensions"
                aria-pressed={showDimensions}
                onClick={() => useUiStore.getState().setShowDimensions(!showDimensions)}
              />
            </div>
            <div className="row between">
              <span className="label">Plan look</span>
              <div className="seg">
                <button
                  className={drawingLook === 'color' ? 'active' : ''}
                  title="Colored rooms, solid walls, furniture in its own colors (C)"
                  onClick={() => useUiStore.getState().setDrawingLook('color')}
                >
                  Color
                </button>
                <button
                  className={drawingLook === 'paper' ? 'active' : ''}
                  title="A plain line drawing (C)"
                  onClick={() => useUiStore.getState().setDrawingLook('paper')}
                >
                  Paper
                </button>
              </div>
            </div>
          </div>
          <div className="menu-rule" />
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              void ensureApiKey(true);
            }}
          >
            {hasKey ? 'Replace Anthropic API key' : 'Add Anthropic API key'}
            <span className="menu-meta">{hasKey ? 'saved' : 'for AI'}</span>
          </button>
          {hasKey && (
            <button className="menu-item" onClick={() => setApiKey('')}>
              Forget API key
            </button>
          )}
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              useUiStore.getState().setShortcutsOpen(true);
            }}
          >
            Keyboard shortcuts
            <span className="menu-meta">?</span>
          </button>
        </div>
      )}
    </div>
  );
}
