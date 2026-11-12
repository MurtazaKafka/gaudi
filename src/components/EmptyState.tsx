import { useUiStore } from '../uiStore';

/** First-run card on a blank canvas: three ways to start. Disappears with the first wall. */
export function EmptyState({ onDismiss }: { onDismiss: () => void }) {
  const ui = useUiStore.getState();
  return (
    <div className="empty-state">
      <div className="empty-title">Start a plan</div>
      <div className="empty-options">
        <button
          className="empty-option"
          onClick={() => {
            ui.setTool('wall');
            onDismiss();
          }}
        >
          <span>
            <div className="empty-option-title">Draw it</div>
            <div className="empty-option-sub">Click point to point; closed loops become rooms.</div>
          </span>
          <span className="kbd">W</span>
        </button>
        <button className="empty-option" onClick={() => ui.setPanel('generate')}>
          <span>
            <div className="empty-option-title">Generate from a brief</div>
            <div className="empty-option-sub">Pick rooms and a shape; compare a few layouts.</div>
          </span>
          <span className="kbd">G</span>
        </button>
        <button className="empty-option" onClick={() => ui.setPanel('projects')}>
          <span>
            <div className="empty-option-title">Open a template</div>
            <div className="empty-option-sub">Start from a studio, a two-bed, a family house.</div>
          </span>
          <span className="kbd">P</span>
        </button>
      </div>
      <div className="hint">
        Then press <span className="kbd">B</span> to build the 3D model, or{' '}
        <span className="kbd">⌘K</span> to ask for changes in plain words.
      </div>
    </div>
  );
}
