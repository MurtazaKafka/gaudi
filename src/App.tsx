import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { PlanCanvas } from './components/PlanCanvas';

export default function App() {
  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <Toolbar />
        <main className="canvas-wrap">
          <PlanCanvas />
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
