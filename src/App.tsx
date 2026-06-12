import { lazy, Suspense, useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { PlanCanvas } from './components/PlanCanvas';
import { FurniturePalette } from './components/FurniturePalette';
import { useUiStore } from './uiStore';

// three.js only loads when the user first builds the model.
const Scene3D = lazy(() =>
  import('./components/Scene3D').then((m) => ({ default: m.Scene3D })),
);

export default function App() {
  const mode = useUiStore((s) => s.mode);
  const paletteOpen = useUiStore((s) => s.paletteOpen);

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

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        {mode === 'plan' && <Toolbar />}
        {mode === 'plan' && paletteOpen && <FurniturePalette />}
        <main className="canvas-wrap">
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
      </div>
      <StatusBar />
    </div>
  );
}
