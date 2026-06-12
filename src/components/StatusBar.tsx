import { useMemo } from 'react';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { formatMeters } from '../geometry';
import { detectRooms } from '../rooms';

const hints: Record<string, string> = {
  wall: 'click to place · enter / esc finishes the run · scroll pans · ⌘ scroll zooms',
  select: 'click a wall or opening to select · drag endpoints to adjust · ⌫ deletes',
  door: 'hover a wall · click to place a door · esc for select',
  window: 'hover a wall · click to place a window · esc for select',
};

export function StatusBar() {
  const mode = useUiStore((s) => s.mode);
  const tool = useUiStore((s) => s.tool);
  const cursor = useUiStore((s) => s.cursor);
  const drawingLength = useUiStore((s) => s.drawingLength);
  const walls = usePlanStore((s) => s.walls);
  const wallCount = walls.length;
  const roomCount = useMemo(() => detectRooms(walls).length, [walls]);

  const inPlan = mode === 'plan';
  return (
    <footer className="statusbar">
      <span className="status-tool">{inPlan ? tool : 'model'}</span>
      <span className="status-sep" />
      <span className="status-mono">
        {inPlan && cursor ? `${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)} m` : '—'}
      </span>
      {inPlan && drawingLength !== null && drawingLength > 0 && (
        <>
          <span className="status-sep" />
          <span className="status-mono status-length">{formatMeters(drawingLength)}</span>
        </>
      )}
      <span className="status-spacer" />
      <span className="status-hint">
        {inPlan ? hints[tool] ?? '' : 'drag orbits · scroll zooms · ⇧ drag pans · esc returns to plan'}
      </span>
      <span className="status-sep" />
      <span className="status-mono">
        {wallCount} wall{wallCount === 1 ? '' : 's'} · {roomCount} room{roomCount === 1 ? '' : 's'}
      </span>
    </footer>
  );
}
