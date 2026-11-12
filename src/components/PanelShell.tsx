import type { ReactNode } from 'react';
import { useUiStore } from '../uiStore';

/** Standard chrome for a right-docked panel: title, close button, scrolling body, optional footer. */
export function PanelShell({
  title,
  children,
  foot,
}: {
  title: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <aside className="panel">
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        <button
          className="icon-btn"
          title="Close"
          aria-label="Close panel"
          onClick={() => useUiStore.getState().setPanel(null)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="panel-body">{children}</div>
      {foot && <div className="panel-foot">{foot}</div>}
    </aside>
  );
}
