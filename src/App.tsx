import { lazy, Suspense, useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { PlanCanvas } from './components/PlanCanvas';
import { FurniturePalette } from './components/FurniturePalette';
import { ShareDrawer } from './components/ShareDrawer';
import { useUiStore } from './uiStore';
import { enterSharedView, exitSharedView, useShareStore } from './share/shareStore';

// three.js only loads when the user first builds the model.
const Scene3D = lazy(() =>
  import('./components/Scene3D').then((m) => ({ default: m.Scene3D })),
);

const SHARE_HASH = /^#\/p\/([A-Za-z0-9]{6,20})/;

export default function App() {
  const mode = useUiStore((s) => s.mode);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const readOnly = useUiStore((s) => s.readOnly);
  const drawerOpen = useShareStore((s) => s.drawerOpen);
  const viewId = useShareStore((s) => s.viewId);
  const proposing = useShareStore((s) => s.proposing);
  const shareStatus = useShareStore((s) => s.status);

  // Esc in the model view returns to the plan.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useUiStore.getState().mode === 'model') {
        useUiStore.getState().setMode('plan');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // #/p/{id} links open the shared view; clearing the hash leaves it.
  useEffect(() => {
    const apply = () => {
      const m = location.hash.match(SHARE_HASH);
      if (m) void enterSharedView(m[1]);
      else if (useShareStore.getState().viewId) exitSharedView(false);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        {mode === 'plan' && !readOnly && <Toolbar />}
        {mode === 'plan' && !readOnly && paletteOpen && <FurniturePalette />}
        <main className="canvas-wrap">
          {viewId && shareStatus !== 'error' && (
            <div className={`share-banner ${proposing ? 'drafting' : ''}`}>
              {proposing
                ? 'Draft — your proposed changes'
                : 'Shared plan · view only'}
            </div>
          )}
          {shareStatus === 'error' && (
            <div className="share-banner error">This shared link could not be loaded.</div>
          )}
          {/* The plan canvas stays mounted so the editor view survives toggling. */}
          <div className="view-plan" style={{ display: mode === 'plan' ? undefined : 'none' }}>
            <PlanCanvas />
          </div>
          {mode === 'model' && (
            <Suspense fallback={<div className="scene-loading">building…</div>}>
              <Scene3D />
            </Suspense>
          )}
        </main>
        {drawerOpen && <ShareDrawer />}
      </div>
      <StatusBar />
    </div>
  );
}
