import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { formatMeters } from '../geometry';

const hints: Record<string, string> = {
  wall: 'click to place · enter / esc finishes the run · scroll pans · ⌘ scroll zooms',
  select: 'click a wall to select · drag endpoints to adjust · ⌫ deletes · shift-click adds',
};

export function StatusBar() {
  const tool = useUiStore((s) => s.tool);
  const cursor = useUiStore((s) => s.cursor);
  const drawingLength = useUiStore((s) => s.drawingLength);
  const wallCount = usePlanStore((s) => s.walls.length);

  return (
    <footer className="statusbar">
      <span className="status-tool">{tool}</span>
      <span className="status-sep" />
      <span className="status-mono">
        {cursor ? `${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)} m` : '—'}
      </span>
      {drawingLength !== null && drawingLength > 0 && (
        <>
          <span className="status-sep" />
          <span className="status-mono status-length">{formatMeters(drawingLength)}</span>
        </>
      )}
      <span className="status-spacer" />
      <span className="status-hint">{hints[tool] ?? ''}</span>
      <span className="status-sep" />
      <span className="status-mono">{wallCount} wall{wallCount === 1 ? '' : 's'}</span>
    </footer>
  );
}
