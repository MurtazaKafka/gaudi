import { lazy, Suspense, useEffect, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { PlanCanvas } from './components/PlanCanvas';
import { FurniturePalette } from './components/FurniturePalette';
import { ShareDrawer } from './components/ShareDrawer';
import { GeneratePanel } from './components/GeneratePanel';
import { ProjectsPanel } from './components/ProjectsPanel';
import { CommandBar } from './components/CommandBar';
import { KeyDialog } from './components/KeyDialog';
import { Toasts } from './components/Toasts';
import { PreviewBar } from './components/PreviewBar';
import { EmptyState } from './components/EmptyState';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { usePlanStore } from './store';
import { useUiStore } from './uiStore';
import { usePreviewStore } from './preview';
import { redo, undo } from './history';
import { useKeyStore } from './ai/client';
import { enterSharedView, exitSharedView, useShareStore } from './share/shareStore';

// three.js only loads when the user first builds the model.
const Scene3D = lazy(() =>
  import('./components/Scene3D').then((m) => ({ default: m.Scene3D })),
);

const SHARE_HASH = /^#\/p\/([A-Za-z0-9]{6,20})/;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

export default function App() {
  const mode = useUiStore((s) => s.mode);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const readOnly = useUiStore((s) => s.readOnly);
  const panel = useUiStore((s) => s.panel);
  const tool = useUiStore((s) => s.tool);
  const drawerOpen = useShareStore((s) => s.drawerOpen);
  const viewId = useShareStore((s) => s.viewId);
  const proposing = useShareStore((s) => s.proposing);
  const shareStatus = useShareStore((s) => s.status);
  const previewing = usePreviewStore((s) => s.active);
  const isEmpty = usePlanStore((s) => s.walls.length === 0 && s.furniture.length === 0);
  const [emptyDismissed, setEmptyDismissed] = useState(false);

  // App-wide keys. Tool keys live in PlanCanvas; these work in every view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();
      const mod = e.metaKey || e.ctrlKey;

      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (ui.commandOpen) ui.closeCommand();
        else if (!ui.readOnly) ui.openCommand();
        return;
      }
      if (isTypingTarget(e.target)) return;

      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (ui.readOnly) return;
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        if (!ui.readOnly) redo();
        return;
      }
      if (mod || e.altKey || e.repeat) return;
      // Nothing behind a dialog or the command bar reacts to plain keys ('?' still closes its own sheet).
      if (ui.commandOpen || useKeyStore.getState().asking) return;
      if (ui.shortcutsOpen && e.key !== '?') return;

      switch (e.key) {
        case 'Escape':
          if (ui.mode === 'model') ui.setMode('plan');
          break;
        case 'b':
        case 'B':
          if (ui.mode === 'model') ui.setMode('plan');
          else if (usePlanStore.getState().walls.length > 0) ui.setMode('model');
          break;
        case 'a':
        case 'A':
          if (!ui.readOnly && ui.mode === 'plan') {
            e.preventDefault();
            ui.openProducts();
          }
          break;
        case 'g':
        case 'G':
          if (!ui.readOnly) {
            useShareStore.setState({ drawerOpen: false });
            ui.togglePanel('generate');
          }
          break;
        case 'p':
        case 'P':
          if (!ui.readOnly) {
            useShareStore.setState({ drawerOpen: false });
            ui.togglePanel('projects');
          }
          break;
        case '?':
          ui.setShortcutsOpen(!ui.shortcutsOpen);
          break;
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

  const showEmpty =
    mode === 'plan' && isEmpty && !readOnly && !panel && !emptyDismissed && tool !== 'furniture';

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        {mode === 'plan' && !readOnly && <Toolbar />}
        {mode === 'plan' && !readOnly && paletteOpen && <FurniturePalette />}
        <main className="canvas-wrap">
          {viewId && shareStatus !== 'error' && !previewing && (
            <div className={`share-banner ${proposing ? 'drafting' : ''}`}>
              {proposing ? 'Draft — your proposed changes' : 'Shared plan · view only'}
            </div>
          )}
          {shareStatus === 'error' && (
            <div className="share-banner error">This shared link could not be loaded.</div>
          )}
          <PreviewBar />
          {/* The plan canvas stays mounted so the editor view survives toggling. */}
          <div className="view-plan" style={{ display: mode === 'plan' ? undefined : 'none' }}>
            <PlanCanvas />
          </div>
          {showEmpty && <EmptyState onDismiss={() => setEmptyDismissed(true)} />}
          {mode === 'model' && (
            <Suspense fallback={<div className="scene-loading">building…</div>}>
              <Scene3D />
            </Suspense>
          )}
        </main>
        {panel === 'generate' && <GeneratePanel />}
        {panel === 'projects' && <ProjectsPanel />}
        {drawerOpen && !panel && <ShareDrawer />}
      </div>
      <StatusBar />
      <CommandBar />
      <KeyDialog />
      <ShortcutsDialog />
      <Toasts />
    </div>
  );
}
