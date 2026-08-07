import { useRef } from 'react';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { useShareStore } from '../share/shareStore';
import { downloadBlob, exportPlanJSON, importPlanJSON } from '../serialize';

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function FileActions() {
  const hasWalls = usePlanStore((s) => s.walls.length > 0);
  const readOnly = useUiStore((s) => s.readOnly);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImportFile = async (file: File) => {
    const result = importPlanJSON(await file.text());
    if (!result.ok) alert(`Couldn't import plan: ${result.error}`);
  };

  return (
    <div className="file-actions">
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
          e.target.value = '';
        }}
      />
      <button
        title="Import plan (JSON)"
        disabled={readOnly}
        onClick={() => fileRef.current?.click()}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path d="M8 10V2m0 0L5 5m3-3l3 3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M2 11v3h12v-3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <button
        title="Export plan (JSON)"
        disabled={!hasWalls}
        onClick={() => downloadBlob(exportPlanJSON(), 'gaudi-plan.json', 'application/json')}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path d="M8 2v8m0 0l3-3m-3 3L5 7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M2 11v3h12v-3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <button
        title="Export model (.glb)"
        disabled={!hasWalls}
        onClick={() => void import('../exportGlb').then((m) => m.exportGlb())}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1.5l5.5 3v7l-5.5 3-5.5-3v-7l5.5-3z"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path d="M8 8l5.5-3M8 8L2.5 5M8 8v6.5" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}

function SettingField({
  label,
  value,
  min,
  max,
  step,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(clamp(v, min, max));
        }}
      />
      <span className="field-unit">m</span>
    </label>
  );
}

export function TopBar() {
  const settings = usePlanStore((s) => s.settings);
  const updateSettings = usePlanStore((s) => s.updateSettings);
  const hasWalls = usePlanStore((s) => s.walls.length > 0);
  const mode = useUiStore((s) => s.mode);
  const setMode = useUiStore((s) => s.setMode);
  const readOnly = useUiStore((s) => s.readOnly);
  const drawerOpen = useShareStore((s) => s.drawerOpen);

  return (
    <header className="topbar">
      <div className="brand">
        <h1 className="wordmark">Gaudí</h1>
        <span className="brand-rule" />
        <span className="brand-sub">plan&thinsp;→&thinsp;house</span>
      </div>

      <div className="mode-toggle">
        <button
          className={mode === 'plan' ? 'active' : ''}
          onClick={() => setMode('plan')}
        >
          Plan
        </button>
        <button
          className={mode === 'model' ? 'active' : ''}
          disabled={!hasWalls}
          onClick={() => setMode('model')}
        >
          Model
        </button>
      </div>

      <div className="topbar-right">
        <FileActions />
        <button
          className={`share-btn ${drawerOpen ? 'active' : ''}`}
          title="Share — link, comments, proposals"
          onClick={() =>
            useShareStore.setState((s) => ({ drawerOpen: !s.drawerOpen }))
          }
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle cx="4" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="12" cy="3.6" r="2.1" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="12" cy="12.4" r="2.1" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5.9 7L10.1 4.7M5.9 9l4.2 2.3" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Share
        </button>
        <span className="topbar-rule" />
        <SettingField
          label="wall height"
          value={settings.wallHeight}
          min={2}
          max={6}
          step={0.1}
          disabled={readOnly}
          onChange={(v) => updateSettings({ wallHeight: v })}
        />
        <SettingField
          label="thickness"
          value={settings.wallThickness}
          min={0.05}
          max={0.5}
          step={0.05}
          disabled={readOnly}
          onChange={(v) => updateSettings({ wallThickness: v })}
        />
        <button
          className="build-btn"
          disabled={!hasWalls}
          title={hasWalls ? 'Extrude the plan into 3D' : 'Draw some walls first'}
          onClick={() => setMode('model')}
        >
          Build
        </button>
      </div>
    </header>
  );
}
