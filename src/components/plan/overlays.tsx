import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { usePlanStore } from '../../store';
import { useUiStore } from '../../uiStore';
import { customId, furnitureDef, isCustomKind } from '../../catalog';
import { dist } from '../../geometry';
import { formatLength, parseLength, useUnits } from '../../units';
import { toastError } from '../../toast';
import type { DetectedRoom } from '../../rooms';
import type { Furniture, Opening, Wall } from '../../types';
import {
  deleteSelection,
  duplicateSelection,
  resizeWall,
  rotateSelection,
  setFurnitureLabel,
  setOpeningWidth,
} from './actions';
import { footprintRadius, MIN_WALL, wallNormal } from './drafting';
import { fitRoomLabel, labelAnchor } from './labels';
import { roomText } from './roomText';
import { toScreen, type Size, type View } from './view';
import '../../styles/plan.css';
import '../../styles/look.css';

/**
 * A text field that edits a draft and commits once — on Enter, on blur, or
 * when it goes away mid-edit — so typing is never fought by validation.
 * Esc puts the old value back.
 */
export function CommitInput({
  value,
  onCommit,
  onDone,
  ...rest
}: {
  value: string;
  onCommit: (text: string) => void;
  /** called after the edit ends, committed or not */
  onDone?: () => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null);
  const live = useRef<{ draft: string | null; value: string; commit: (t: string) => void }>({
    draft: null,
    value,
    commit: onCommit,
  });
  // Handlers own `draft` (so it is never a render behind); props are mirrored here.
  useEffect(() => {
    live.current.value = value;
    live.current.commit = onCommit;
  });

  const finish = (commit: boolean) => {
    const { draft: d, value: v, commit: run } = live.current;
    live.current.draft = null;
    setDraft(null);
    if (commit && d !== null && d.trim() !== v.trim()) run(d);
  };

  // Removed while still being edited (the selection moved on): keep what was typed.
  useEffect(
    () => () => {
      const { draft: d, value: v, commit: run } = live.current;
      live.current.draft = null;
      if (d !== null && d.trim() !== v.trim()) run(d);
    },
    [],
  );

  return (
    <input
      type="text"
      spellCheck={false}
      autoComplete="off"
      {...rest}
      value={draft ?? value}
      onFocus={(e) => {
        live.current.draft = value;
        setDraft(value);
        e.target.select();
      }}
      onChange={(e) => {
        live.current.draft = e.target.value;
        setDraft(e.target.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation(); // canvas shortcuts stay out of the way while typing
        if (e.key === 'Enter') {
          finish(true);
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          finish(false);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        finish(true);
        onDone?.();
      }}
    />
  );
}

/**
 * A room's label: its name, then its size (width × depth) and area. It sits
 * at the roomiest spot and shows only as much as fits between the walls at
 * this zoom — the area goes first, then the size, then the name shrinks.
 * Click selects the room, double-click renames it.
 */
export function RoomLabel({
  room,
  view,
  interactive,
  thickness,
  editing,
  onStartEdit,
  onEndEdit,
}: {
  room: DetectedRoom;
  view: View;
  interactive: boolean;
  /** wall thickness, m */
  thickness: number;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
}) {
  const name = usePlanStore((s) => s.roomNames[room.key]);
  const units = useUnits();
  const shown = name ?? 'Room';
  const at = labelAnchor(room.polygon, room.centroid);
  const text = useMemo(() => roomText(room, units), [room, units]);
  const fit = useMemo(
    () => fitRoomLabel(room.polygon, at, view.scale, thickness, { name: shown, ...text }),
    [room, at, view.scale, thickness, shown, text],
  );
  const { x, y } = toScreen(view, at);

  if (editing && interactive) {
    return (
      <CommitInput
        className="room-name-input"
        style={{ left: x, top: y }}
        value={name ?? ''}
        placeholder="Room name"
        maxLength={40}
        autoFocus
        onCommit={(text) => {
          if (!useUiStore.getState().readOnly) usePlanStore.getState().setRoomName(room.key, text);
        }}
        onDone={onEndEdit}
      />
    );
  }
  if (fit.tier === 'none') return null; // too small to label here; the floor itself still takes the double-click

  return (
    <div
      className={`room-label ${interactive ? 'interactive' : ''}`}
      style={{ left: x, top: y, maxWidth: fit.maxWidth }}
      onClick={interactive ? () => useUiStore.getState().setRoomSelection(room.key) : undefined}
      onDoubleClick={interactive ? onStartEdit : undefined}
      title={interactive ? `${text.dims} · ${text.area} — double-click to rename` : undefined}
    >
      <span className={`room-name ${name ? '' : 'unnamed'}`} style={{ fontSize: fit.nameSize }}>
        {shown}
      </span>
      {fit.showDims && <span className="room-dims">{text.dims}</span>}
      {fit.showArea && <span className="room-area">{text.area}</span>}
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="icon-btn plan-inspector-btn" title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

const DeleteIcon = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** Width (and delete) for the one selected door or window, floating above it. */
export function OpeningInspector({
  opening,
  wall,
  view,
}: {
  opening: Opening;
  wall: Wall;
  view: View;
}) {
  const units = useUnits();
  const len = dist(wall.a, wall.b);
  const t = len > 1e-6 ? opening.offset / len : 0;
  const { x, y } = toScreen(view, {
    x: wall.a.x + (wall.b.x - wall.a.x) * t,
    y: wall.a.y + (wall.b.y - wall.a.y) * t,
  });

  return (
    <div className="opening-inspector plan-inspector" style={{ left: x, top: y - 34 }}>
      <span className="oi-type">{opening.type}</span>
      <CommitInput
        className="plan-inspector-input mono"
        aria-label="Width"
        title="Width"
        inputMode="decimal"
        value={formatLength(opening.width, units)}
        onCommit={(text) => {
          const m = parseLength(text, units);
          if (m === null || m <= 0) toastError(`Couldn't read “${text.trim()}” as a width.`);
          else if (!setOpeningWidth(opening.id, m)) toastError('No room for that width on this wall.');
        }}
      />
      <IconButton title="Delete (⌫)" onClick={deleteSelection}>
        {DeleteIcon}
      </IconButton>
    </div>
  );
}

/** Note, rotate, duplicate, delete for the one selected furniture item. */
export function FurnitureInspector({
  item,
  view,
  size,
}: {
  item: Furniture;
  view: View;
  size: Size;
}) {
  // Subscribe to the definition so a re-modelled custom item re-labels itself.
  const custom = usePlanStore((s) =>
    isCustomKind(item.kind) ? s.customItems[customId(item.kind)] : undefined,
  );
  const def = custom ?? furnitureDef(item.kind);
  const c = toScreen(view, item);
  const reach = footprintRadius(def.w, def.d) * view.scale + 12;
  // Above the item; below it when there is no room above.
  const above = c.y - reach > 44;
  const top = above ? c.y - reach : Math.min(c.y + reach, size.h - 8);

  return (
    <div
      className={`plan-inspector ${above ? '' : 'below'}`}
      style={{ left: c.x, top }}
    >
      <CommitInput
        className="plan-inspector-input label-input"
        aria-label="Label"
        title="Label shown on the plan"
        placeholder={def.label}
        maxLength={60}
        value={item.label ?? ''}
        onCommit={(text) => setFurnitureLabel(item.id, text)}
      />
      <span className="float-rule" />
      <IconButton title="Rotate (R)" onClick={() => rotateSelection(Math.PI / 2)}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.6-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M13.2 2.2v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </IconButton>
      <IconButton title="Duplicate (⌘D)" onClick={() => duplicateSelection()}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 3.5v-1h-8v8h1" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </IconButton>
      <IconButton title="Delete (⌫)" onClick={deleteSelection}>
        {DeleteIcon}
      </IconButton>
    </div>
  );
}

/**
 * The length of a selected wall, sitting beside it. Click it to type a new
 * length: the wall resizes from its A end and attached walls follow.
 */
export function WallLengthTag({
  wall,
  view,
  side,
  thickness,
}: {
  wall: Wall;
  view: View;
  /** which side of the wall to sit on (see `dimensionSide`) */
  side: 1 | -1;
  /** wall thickness, m */
  thickness: number;
}) {
  const units = useUnits();
  const [editing, setEditing] = useState(false);
  const len = dist(wall.a, wall.b);
  const n = wallNormal(wall);
  const mid = toScreen(view, { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 });
  // Far enough out to clear the stroke at any zoom: the tag is wider than it is tall.
  const off = (thickness / 2) * view.scale + 15 + Math.abs(n.x) * 22;
  const style = { left: mid.x + n.x * side * off, top: mid.y + n.y * side * off };
  const text = formatLength(len, units);

  if (editing) {
    return (
      <CommitInput
        className="wall-length-input mono"
        style={style}
        aria-label="Wall length"
        inputMode="decimal"
        autoFocus
        value={text}
        onCommit={(typed) => {
          const m = parseLength(typed, units);
          if (m === null || m < MIN_WALL) toastError(`Couldn't read “${typed.trim()}” as a length.`);
          else resizeWall(wall.id, m);
        }}
        onDone={() => setEditing(false)}
      />
    );
  }
  return (
    <button
      type="button"
      className="wall-length-tag mono"
      style={style}
      title="Click to set the length"
      onClick={() => setEditing(true)}
    >
      {text}
    </button>
  );
}
