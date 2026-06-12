import { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { PlanCanvas } from './components/PlanCanvas';
import { Scene3D } from './components/Scene3D';
import { useUiStore } from './uiStore';

export default function App() {
  const mode = useUiStore((s) => s.mode);

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
        <main className="canvas-wrap">
          {/* The plan canvas stays mounted so the editor view survives toggling. */}
          <div className="view-plan" style={{ display: mode === 'plan' ? undefined : 'none' }}>
            <PlanCanvas />
          </div>
          {mode === 'model' && <Scene3D />}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
