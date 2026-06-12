import { useUiStore } from '../uiStore';
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
];

export function Toolbar() {
  const tool = useUiStore((s) => s.tool);
  const setTool = useUiStore((s) => s.setTool);

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
    </nav>
  );
}
