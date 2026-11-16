/** The controls over the 3D view while a render is running or finished. */
import { RENDER_SIZES, useRenderStore } from './renderStore';
import '../../styles/render.css';

export function RenderOverlay() {
  const phase = useRenderStore((s) => s.phase);
  const samples = useRenderStore((s) => s.samples);
  const target = useRenderStore((s) => s.target);
  const error = useRenderStore((s) => s.error);
  const size = useRenderStore((s) => s.size);
  if (phase === 'off') return null;
  const { stop, requestSave } = useRenderStore.getState();
  const pct = Math.min(100, Math.round((samples / Math.max(1, target)) * 100));

  return (
    <div className="float-bar bottom render-bar" role="status">
      {phase === 'preparing' && (
        <>
          <span className="spinner" />
          <span className="hint">Preparing the render…</span>
        </>
      )}
      {phase === 'rendering' && (
        <>
          <span className="render-label">Rendering</span>
          <span className="render-track" aria-hidden>
            <span className="render-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="mono render-pct">{pct}%</span>
        </>
      )}
      {phase === 'done' && <span className="render-label">Rendered</span>}
      {phase === 'error' && <span className="hint error">{error ?? 'The render failed.'}</span>}

      {phase !== 'error' && (
        <div className="seg" role="group" aria-label="Picture size" title="Picture size — larger takes longer">
          {RENDER_SIZES.map((r) => (
            <button
              key={r.id}
              className={size === r.id ? 'active' : ''}
              onClick={() => useRenderStore.getState().setSize(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      {(phase === 'rendering' || phase === 'done') && (
        <button className={`btn small ${phase === 'done' ? 'primary' : ''}`} onClick={requestSave}>
          Save image
        </button>
      )}
      <button className="btn small quiet" title="Back to the model — Esc" onClick={stop}>
        {phase === 'done' || phase === 'error' ? 'Close' : 'Cancel'}
      </button>
    </div>
  );
}
