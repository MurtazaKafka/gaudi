import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { formatArea, formatLength, formatLengthShort, useUnits } from '../units';
import type { Point, Tool, Units } from '../types';
import { roomsFor } from './plan/actions';
import '../styles/plan.css';

const hints: Record<Tool, string> = {
  wall: 'click to place · type a length, enter · ⇧ locks the angle · esc ends the run',
  select: 'click to select · drag a box to select several · ⇧ adds · ⌘D duplicates · ⌫ deletes',
  door: 'click a wall to place a door · click a door again to widen it, then pair it · esc for select',
  window: 'click a wall to place a window · click a window again for the next size · esc for select',
  furniture: 'click to place · R rotates · esc for select',
  measure: 'click two points to measure · ⇧ locks the angle · esc clears',
};

const VIEW_ONLY_HINT = 'scroll pans · ⌘ scroll zooms · 0 fits · M measures · L shows dimensions';

/** "3.50, 2.00 m" · "11′6″, 6′7″" */
function formatPoint(p: Point, units: Units): string {
  if (units === 'm') return `${p.x.toFixed(2)}, ${p.y.toFixed(2)} m`;
  return `${formatLengthShort(p.x, units)}, ${formatLengthShort(p.y, units)}`;
}

export function StatusBar() {
  const mode = useUiStore((s) => s.mode);
  const tool = useUiStore((s) => s.tool);
  const readOnly = useUiStore((s) => s.readOnly);
  const cursor = useUiStore((s) => s.cursor);
  const drawingLength = useUiStore((s) => s.drawingLength);
  const walls = usePlanStore((s) => s.walls);
  const units = useUnits();
  const rooms = roomsFor(walls); // cached per walls array, shared with the canvas
  const wallCount = walls.length;
  const roomCount = rooms.length;
  const area = rooms.reduce((sum, r) => sum + r.area, 0);

  const selected = useUiStore(
    (s) => s.selectedWallIds.length + s.selectedOpeningIds.length + s.selectedFurnitureIds.length,
  );

  const inPlan = mode === 'plan';
  const hint = !inPlan
    ? 'drag orbits · scroll zooms toward the pointer · ⇧ drag pans · R renders · esc returns to plan'
    : readOnly && tool !== 'measure'
      ? VIEW_ONLY_HINT
      : tool === 'select' && selected > 1
        ? `${selected} selected · arrows nudge · ⌫ delete · esc clears`
        : hints[tool];
  return (
    <footer className="statusbar">
      <span className="status-tool">{inPlan ? (readOnly && tool !== 'measure' ? 'view' : tool) : 'model'}</span>
      <span className="status-sep" />
      <span className="status-mono">{inPlan && cursor ? formatPoint(cursor, units) : '—'}</span>
      {inPlan && drawingLength !== null && drawingLength > 0 && (
        <>
          <span className="status-sep" />
          <span className="status-mono status-length">{formatLength(drawingLength, units)}</span>
        </>
      )}
      <span className="status-spacer" />
      <span className="status-hint">{hint}</span>
      <span className="status-sep" />
      <span className="status-mono">
        {wallCount} wall{wallCount === 1 ? '' : 's'} · {roomCount} room{roomCount === 1 ? '' : 's'}
        {roomCount > 0 && (
          <>
            {' · '}
            <span className="status-area" title="Total floor area">
              {formatArea(area, units)}
            </span>
          </>
        )}
      </span>
      <span className="status-sep" />
      <a
        className="status-credit"
        href="https://murtazanikzad.com/"
        target="_blank"
        rel="noopener noreferrer"
        title="Built by Murtaza Nikzad — see more work"
      >
        by Murtaza Nikzad ↗
      </a>
    </footer>
  );
}
