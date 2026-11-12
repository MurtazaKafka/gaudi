import { useState } from 'react';
import { setApiKey, settleKeyDialog, useKeyStore } from '../ai/client';

/** Asks for the Anthropic API key the first time an AI feature needs it. */
export function KeyDialog() {
  const asking = useKeyStore((s) => s.asking);
  const [draft, setDraft] = useState('');
  if (!asking) return null;

  const valid = draft.trim().startsWith('sk-ant-');
  const save = () => {
    if (!valid) return;
    setApiKey(draft);
    setDraft('');
    settleKeyDialog(true);
  };
  const cancel = () => {
    setDraft('');
    settleKeyDialog(false);
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dialog" role="dialog" aria-label="Anthropic API key">
        <div className="dialog-title">Connect Claude</div>
        <div className="hint">
          Gaudí's AI features call Claude directly from this browser with your own Anthropic API
          key. It is stored only in this browser's localStorage.
        </div>
        <input
          className="input mono"
          type="password"
          placeholder="sk-ant-…"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
          }}
        />
        <div className="row">
          <button className="btn primary" disabled={!valid} onClick={save}>
            Save key
          </button>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <a
            className="hint"
            style={{ marginLeft: 'auto' }}
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get a key ↗
          </a>
        </div>
      </div>
    </div>
  );
}
