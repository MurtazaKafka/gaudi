/**
 * What the demo puts on screen: a title card while it gets ready, a caption
 * for each step, and a closing card with what to do next. It covers the whole
 * window so nothing underneath can be clicked while Gaudí drives itself.
 */
import { useEffect } from 'react';
import { useDemoStore } from './demoStore';
import { endDemo, startDemo } from './tour';
import '../styles/demo.css';

const ALSO = [
  'Five layouts from one brief',
  'Any outline, not just boxes',
  'Shopping links become 3D furniture',
  'Share links with comments and proposals',
  'PDF · DXF · IFC · GLB export',
];

export function DemoOverlay() {
  const phase = useDemoStore((s) => s.phase);
  const step = useDemoStore((s) => s.step);
  const steps = useDemoStore((s) => s.steps);
  const caption = useDemoStore((s) => s.caption);
  const detail = useDemoStore((s) => s.detail);
  const hadPlan = useDemoStore((s) => s.hadPlan);
  const active = phase !== 'off';

  // While the demo runs the keyboard is its own: Esc leaves, nothing else reaches the editor.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') return; // the cards' own buttons
      e.stopPropagation();
      e.preventDefault();
      if (e.type === 'keydown' && e.key === 'Escape') endDemo('back');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [active]);

  if (!active) return null;

  return (
    <div className={`demo is-${phase}`} role="dialog" aria-label="Gaudí demo">
      {phase === 'title' && (
        <div className="demo-card demo-title">
          <div className="demo-word">Gaudí</div>
          <div className="demo-line">From a sentence to a house you can walk through.</div>
          <div className="demo-foot mono">a one-minute tour · esc to skip</div>
          {/* On a first visit the 3D materials are still arriving: show that something is happening. */}
          <div className="demo-wait" aria-hidden="true">
            <span />
          </div>
        </div>
      )}

      {phase === 'playing' && (
        <div className="demo-caption" key={step}>
          <span className="demo-step mono">
            {step + 1} / {steps}
          </span>
          <button className="btn small quiet" onClick={() => endDemo('back')}>
            Skip <span className="kbd">Esc</span>
          </button>
          <div className="demo-text">
            <div className="demo-head">{caption}</div>
            {detail && <div className="demo-detail">{detail}</div>}
          </div>
          <div className="demo-track" aria-hidden="true">
            <div className="demo-fill" style={{ width: `${((step + 1) / Math.max(1, steps)) * 100}%` }} />
          </div>
        </div>
      )}

      {phase === 'end' && (
        <div className="demo-veil">
          <div className="demo-card demo-end">
            <div className="demo-word small">That’s Gaudí.</div>
            <div className="demo-line">A plan, a model and a render — from one browser tab, in about a minute.</div>
            <ul className="demo-also">
              {ALSO.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="demo-actions">
              <button className="btn primary" autoFocus onClick={() => endDemo('keep')}>
                Keep this house
              </button>
              <button className="btn" onClick={() => endDemo('back')}>
                {hadPlan ? 'Back to my plan' : 'Design my own'}
              </button>
              <button className="btn quiet" onClick={startDemo}>
                Replay
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
