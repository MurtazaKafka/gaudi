import { acceptPreview, cancelPreview, usePreviewStore } from '../preview';

/** Accept / go back for a plan being previewed on the canvas. */
export function PreviewBar() {
  const active = usePreviewStore((s) => s.active);
  const label = usePreviewStore((s) => s.label);
  const acceptLabel = usePreviewStore((s) => s.acceptLabel);
  if (!active) return null;
  return (
    <div className="preview-bar">
      <span className="preview-label">{label}</span>
      <button className="btn primary small" onClick={acceptPreview}>
        {acceptLabel}
      </button>
      <button className="btn small" onClick={cancelPreview}>
        Back
      </button>
    </div>
  );
}
