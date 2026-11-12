import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { renameCurrent } from '../projects/projectStore';

/** Plan name (click to rename) + the door into the projects panel. */
export function ProjectSwitcher() {
  const name = usePlanStore((s) => s.name);
  const readOnly = useUiStore((s) => s.readOnly);
  const panel = useUiStore((s) => s.panel);

  return (
    <div className="row" style={{ gap: 2 }}>
      <input
        key={name}
        className="plan-name"
        defaultValue={name}
        disabled={readOnly}
        maxLength={80}
        aria-label="Plan name"
        title="Rename plan"
        size={Math.max(8, Math.min(24, name.length + 1))}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = name;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          // Renames the plan and, with it, its entry in Projects.
          if (e.target.value.trim() && e.target.value.trim() !== name) renameCurrent(e.target.value);
          else e.target.value = name;
        }}
      />
      <button
        className={`icon-btn ${panel === 'projects' ? 'active' : ''}`}
        title="Projects & templates — P"
        aria-label="Projects and templates"
        onClick={() => useUiStore.getState().togglePanel('projects')}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      </button>
    </div>
  );
}
