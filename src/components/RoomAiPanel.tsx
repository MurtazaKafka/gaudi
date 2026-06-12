import { useState } from 'react';
import { suggestFurniture } from '../aiFurnish';
import { getApiKey, setApiKey, useAiStore } from '../aiStore';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import type { DetectedRoom } from '../rooms';

/**
 * Floating action panel for a selected room: runs Claude on the room and
 * shows accept / regenerate / discard once a suggestion is previewing.
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
  const ai = useAiStore();
  const [needsKey, setNeedsKey] = useState(!getApiKey());
  const [keyDraft, setKeyDraft] = useState('');

  const mine = ai.roomKey === room.key;

  const run = async () => {
    if (!getApiKey()) {
      setNeedsKey(true);
      return;
    }
    useAiStore.getState().start(room.key);
    try {
      const result = await suggestFurniture(room, roomName);
      if (useAiStore.getState().roomKey !== room.key) return; // superseded
      if (result.items.length === 0) {
        useAiStore.getState().fail(
          result.dropped > 0
            ? 'Every suggestion failed validation — try again.'
            : 'The model returned no placements.',
        );
      } else {
        useAiStore.getState().succeed(result.items, result.dropped);
      }
    } catch (e) {
      if (useAiStore.getState().roomKey !== room.key) return;
      useAiStore.getState().fail(e instanceof Error ? e.message : 'Request failed.');
    }
  };

  const accept = () => {
    usePlanStore.getState().addFurnitureBatch(ai.items);
    useAiStore.getState().clear();
    useUiStore.getState().setRoomSelection(null);
  };

  if (needsKey) {
    return (
      <div className="room-ai-panel" style={{ left: screenX, top: screenY }}>
        <div className="rap-title">Anthropic API key</div>
        <div className="rap-hint">
          Stored only in this browser's localStorage. Used directly from the
          browser to suggest layouts.
        </div>
        <input
          type="password"
          placeholder="sk-ant-…"
          value={keyDraft}
          autoFocus
          onChange={(e) => setKeyDraft(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="rap-row">
          <button
            className="rap-primary"
            disabled={!keyDraft.trim().startsWith('sk-ant-')}
            onClick={() => {
              setApiKey(keyDraft);
              setNeedsKey(false);
              setKeyDraft('');
            }}
          >
            Save key
          </button>
          <button className="rap-ghost" onClick={() => useUiStore.getState().setRoomSelection(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mine && ai.status === 'loading') {
    return (
      <div className="room-ai-panel" style={{ left: screenX, top: screenY }}>
        <div className="rap-title rap-loading">Furnishing {roomName ?? 'room'}…</div>
        <div className="rap-hint">Claude is laying out the room.</div>
        <div className="rap-row">
          <button className="rap-ghost" onClick={() => useAiStore.getState().clear()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mine && ai.status === 'preview') {
    return (
      <div className="room-ai-panel" style={{ left: screenX, top: screenY }}>
        <div className="rap-title">
          {ai.items.length} piece{ai.items.length === 1 ? '' : 's'} proposed
          {ai.dropped > 0 ? ` · ${ai.dropped} dropped` : ''}
        </div>
        <div className="rap-row">
          <button className="rap-primary" onClick={accept}>
            Accept
          </button>
          <button className="rap-ghost" onClick={() => void run()}>
            Retry
          </button>
          <button className="rap-ghost" onClick={() => useAiStore.getState().clear()}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  if (mine && ai.status === 'error') {
    return (
      <div className="room-ai-panel" style={{ left: screenX, top: screenY }}>
        <div className="rap-title rap-error">Couldn't furnish</div>
        <div className="rap-hint">{ai.error}</div>
        <div className="rap-row">
          <button className="rap-primary" onClick={() => void run()}>
            Try again
          </button>
          <button className="rap-ghost" onClick={() => useAiStore.getState().clear()}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="room-ai-panel" style={{ left: screenX, top: screenY }}>
      <div className="rap-title">{roomName ?? 'Room'} · {room.area.toFixed(1)} m²</div>
      <div className="rap-row">
        <button className="rap-primary" onClick={() => void run()}>
          ✦ Furnish with AI
        </button>
        <button
          className="rap-ghost"
          title="Replace stored API key"
          onClick={() => setNeedsKey(true)}
        >
          Key
        </button>
      </div>
    </div>
  );
}
