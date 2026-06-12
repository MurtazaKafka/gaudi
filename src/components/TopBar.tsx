import { usePlanStore } from '../store';

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function SettingField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
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

  return (
    <header className="topbar">
      <div className="brand">
        <h1 className="wordmark">Gaudí</h1>
        <span className="brand-rule" />
        <span className="brand-sub">plan&thinsp;→&thinsp;house</span>
      </div>
      <div className="topbar-right">
        <SettingField
          label="wall height"
          value={settings.wallHeight}
          min={2}
          max={6}
          step={0.1}
          onChange={(v) => updateSettings({ wallHeight: v })}
        />
        <SettingField
          label="thickness"
          value={settings.wallThickness}
          min={0.05}
          max={0.5}
          step={0.05}
          onChange={(v) => updateSettings({ wallThickness: v })}
        />
        <button className="build-btn" disabled title="3D build arrives in the next slice">
          Build
        </button>
      </div>
    </header>
  );
}
