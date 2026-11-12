import { useUiStore } from '../uiStore';
import { redo, undo, useHistoryStore } from '../history';
import type { Tool } from '../types';

const tools: { id: Tool; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    id: 'select',
    label: 'Select',
    hint: 'V',
    icon: (
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
        <path
          d="M4 1.5l8 7-4.4.6 2.4 4.6-1.8 1-2.4-4.7L4 13V1.5z"
          fill="currentColor"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: 'wall',
    label: 'Wall',
    hint: 'W',
    icon: (
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
        <path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="3" cy="13" r="2" fill="currentColor" />
        <circle cx="13" cy="3" r="2" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'door',
    label: 'Door',
    hint: 'D',
    icon: (
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
        <path d="M2 13h12" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4 13V4" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4 4a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 1.6" />
      </svg>
    ),
  },
  {
    id: 'window',
    label: 'Window',
    hint: 'N',
    icon: (
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="5.5" width="12" height="5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M2 8h12" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    ),
  },
  {
    id: 'measure',
    label: 'Measure',
    hint: 'M',
    icon: (
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
        <path d="M2.2 10.6l8.4-8.4 3.2 3.2-8.4 8.4-3.2-3.2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M5 7.8l1.4 1.4M7 5.8l1.4 1.4M9 3.8l1.4 1.4" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    ),
  },
];

export function Toolbar() {
  const canUndo = useHistoryStore((s) => s.canUndo);
  const canRedo = useHistoryStore((s) => s.canRedo);
  const tool = useUiStore((s) => s.tool);
  const setTool = useUiStore((s) => s.setTool);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

  return (
    <nav className="toolbar">
      {tools.map((t) => (
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          title={`${t.label} — ${t.hint}`}
          onClick={() => setTool(t.id)}
        >
          {t.icon}
          <span className="tool-hint">{t.hint}</span>
        </button>
      ))}
      <span className="toolbar-rule" />
      <button
        className={`tool-btn ${tool === 'furniture' || paletteOpen ? 'active' : ''}`}
        title="Furniture — F"
        onClick={() => setPaletteOpen(!paletteOpen)}
      >
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none">
          <path
            d="M2.5 7v5m11-5v5M2.5 10h11M4 10V8.2A1.7 1.7 0 0 1 5.7 6.5h4.6A1.7 1.7 0 0 1 12 8.2V10"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path d="M4 7V4.5A1.5 1.5 0 0 1 5.5 3h5A1.5 1.5 0 0 1 12 4.5V7" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <span className="tool-hint">F</span>
      </button>
      <span style={{ flex: 1 }} />
      <button className="tool-btn" title="Undo — ⌘Z" aria-label="Undo" disabled={!canUndo} onClick={() => undo()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M5.5 3.5L2.5 6.5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 6.5h6.2a3.3 3.3 0 0 1 0 6.6H6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button className="tool-btn" title="Redo — ⇧⌘Z" aria-label="Redo" disabled={!canRedo} onClick={() => redo()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10.5 3.5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13 6.5H6.8a3.3 3.3 0 0 0 0 6.6h2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </nav>
  );
}
