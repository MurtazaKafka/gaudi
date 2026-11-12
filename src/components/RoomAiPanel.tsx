import { useEffect } from 'react';
import { useKeyStore } from '../ai/client';
import { acceptFurnish, cancelFurnish, runFurnish } from '../aiFurnish';
import { useAiStore } from '../aiStore';
import { pointInPolygon } from '../geometry';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { formatArea, useUnits } from '../units';
import type { DetectedRoom } from '../rooms';
import '../styles/ask.css';

/**
 * Floating panel under a selected room: furnish it with Claude (ghost preview
 * → accept / retry / discard) or open the command bar with the room as context.
 */
export function RoomAiPanel({
  room,
  screenX,
  screenY,
}: {
  room: DetectedRoom;
  screenX: number;
  screenY: number;
}) {
  const roomName = usePlanStore((s) => s.roomNames[room.key]);
  const furnished = usePlanStore((s) =>
    s.furniture.some((f) => pointInPolygon({ x: f.x, y: f.y }, room.polygon)),
  );
  const readOnly = useUiStore((s) => s.readOnly);
  const units = useUnits();
  const status = useAiStore((s) => s.status);
  const aiRoomKey = useAiStore((s) => s.roomKey);
  const count = useAiStore((s) => s.items.length);
  const dropped = useAiStore((s) => s.dropped);
  const error = useAiStore((s) => s.error);
  const replace = useAiStore((s) => s.replace);
  const note = useAiStore((s) => s.note);

  const mine = aiRoomKey === room.key;
  const previewing = mine && status === 'preview';

  // Enter accepts a previewed suggestion, Esc discards it.
  useEffect(() => {
    if (!previewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Only on the plan, with nothing over it: the canvas stays mounted (hidden) in the model
      // view, where Esc means "back to the plan" and Enter would accept furniture nobody can see.
      const ui = useUiStore.getState();
      if (ui.mode !== 'plan' || ui.commandOpen || ui.shortcutsOpen || useKeyStore.getState().asking) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        acceptFurnish();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelFurnish();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [previewing]);

  if (readOnly) return null;

  const style = { left: screenX, top: screenY };
  const run = (again?: boolean) => void runFurnish(room.key, { replace: again ? replace : furnished });

  if (mine && status === 'loading') {
    return (
      <div className="room-ai-panel" style={style}>
        <div className="rap-title rap-loading">Furnishing {roomName ?? 'room'}</div>
        <div className="rap-row">
          <button className="btn small" onClick={cancelFurnish}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (previewing) {
    return (
      <div className="room-ai-panel" style={style}>
        <div className="rap-title">
          {count} piece{count === 1 ? '' : 's'} proposed
        </div>
        {(replace || dropped > 0) && (
          <div className="hint">
            {replace ? 'Replaces what is in the room.' : ''}
            {replace && dropped > 0 ? ' ' : ''}
            {dropped > 0 ? `${dropped} that didn't fit left out.` : ''}
          </div>
        )}
        <div className="rap-row">
          <button className="btn primary small rap-grow" onClick={acceptFurnish}>
            Accept
          </button>
          <button className="btn small" onClick={() => run(true)}>
            Retry
          </button>
          <button className="btn small" onClick={cancelFurnish}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  if (mine && status === 'error') {
    return (
      <div className="room-ai-panel" style={style}>
        <div className="rap-title rap-error">Couldn't furnish</div>
        <div className="hint">{error}</div>
        <div className="rap-row">
          <button className="btn primary small rap-grow" onClick={() => run(true)}>
            Try again
          </button>
          <button className="btn small" onClick={cancelFurnish}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="room-ai-panel" style={style}>
      <div className="rap-title">
        {roomName ?? 'Room'} <span className="rap-area">{formatArea(room.area, units)}</span>
      </div>
      <div className="rap-row">
        <button
          className="btn primary small rap-grow"
          title={furnished ? 'Replace the furniture in this room' : 'Let Claude furnish this room'}
          onClick={() => run()}
        >
          ✦ {furnished ? 'Refurnish' : 'Furnish'}
        </button>
        <button
          className="btn small"
          title="Ask Gaudí to change this room — ⌘K"
          onClick={() => useUiStore.getState().openCommand()}
        >
          Ask…
        </button>
      </div>
      <input
        className="input rap-note"
        type="text"
        value={note}
        maxLength={120}
        placeholder="Style note, optional"
        aria-label="Style note"
        spellCheck={false}
        onChange={(e) => useAiStore.getState().setNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') run();
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      />
    </div>
  );
}
