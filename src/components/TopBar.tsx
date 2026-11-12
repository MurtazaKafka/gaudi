import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { useShareStore } from '../share/shareStore';
import { ExportMenu } from './ExportMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { SettingsMenu } from './SettingsMenu';
import { ProductSearch } from '../products/ProductSearch';

export function TopBar() {
  const hasWalls = usePlanStore((s) => s.walls.length > 0);
  const mode = useUiStore((s) => s.mode);
  const setMode = useUiStore((s) => s.setMode);
  const readOnly = useUiStore((s) => s.readOnly);
  const panel = useUiStore((s) => s.panel);
  const drawerOpen = useShareStore((s) => s.drawerOpen);

  return (
    <header className="topbar">
      <div className="brand">
        <h1 className="wordmark">Gaudí</h1>
        <span className="brand-rule" />
        <ProjectSwitcher />
      </div>

      <div className="mode-toggle">
        <button className={mode === 'plan' ? 'active' : ''} onClick={() => setMode('plan')}>
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
        <button
          className="btn quiet"
          disabled={readOnly}
          title="Ask Gaudí to change the plan in plain words — ⌘K"
          onClick={() => useUiStore.getState().openCommand()}
        >
          ✦ Ask <span className="kbd">⌘K</span>
        </button>
        <ProductSearch />
        <button
          className={`btn accent ${panel === 'generate' ? 'active' : ''}`}
          disabled={readOnly}
          title="Generate layouts from a brief — G"
          onClick={() => {
            useShareStore.setState({ drawerOpen: false });
            useUiStore.getState().togglePanel('generate');
          }}
        >
          Generate
        </button>
        <span className="topbar-rule" />
        <ExportMenu />
        <button
          className={`share-btn ${drawerOpen ? 'active' : ''}`}
          title="Share — link, comments, proposals"
          onClick={() => {
            useUiStore.getState().setPanel(null);
            useShareStore.setState((s) => ({ drawerOpen: !s.drawerOpen }));
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle cx="4" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="12" cy="3.6" r="2.1" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="12" cy="12.4" r="2.1" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5.9 7L10.1 4.7M5.9 9l4.2 2.3" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Share
        </button>
        <SettingsMenu />
        <button
          className="build-btn"
          disabled={!hasWalls}
          title={hasWalls ? 'Extrude the plan into 3D — B' : 'Draw some walls first'}
          onClick={() => setMode('model')}
        >
          Build
        </button>
      </div>
    </header>
  );
}
