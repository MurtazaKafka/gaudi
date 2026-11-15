import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { aiErrorMessage, ensureApiKey, isAbort, useKeyStore } from '../ai/client';
import { describePlan } from '../ai/describe';
import { askEdit } from '../ai/edit';
import { furnishWholePlan } from '../ai/furnishAll';
import { applyOps } from '../ai/ops';
import { defFor } from '../ai/planGeom';
import { classifyRequest, extractUrl, scoreCommand } from '../ai/route';
import { acceptFurnish, cancelFurnish, runFurnish } from '../aiFurnish';
import { customKind } from '../catalog';
import { EXPORTS } from '../export';
import { dist, pointInPolygon } from '../geometry';
import { undo } from '../history';
import { getPlanData } from '../plan';
import { importProductFromUrl, looksLikeProductUrl } from '../products/importProduct';
import { detectRooms } from '../rooms';
import { usePlanStore } from '../store';
import { useViewStore } from '../three/viewStore';
import { toast } from '../toast';
import { useUiStore } from '../uiStore';
import { formatArea, formatLength, useUnits } from '../units';
import '../styles/ask.css';

/** The Generate package's entry point, if that module exists in this build. */
const generateModules = import.meta.glob<{ generateFromText?: (text: string) => unknown }>('../generate/api.ts');

async function handToGenerate(text: string): Promise<void> {
  const load = generateModules['../generate/api.ts'];
  if (load) {
    const mod = await load();
    if (typeof mod.generateFromText === 'function') {
      await mod.generateFromText(text);
      return;
    }
  }
  useUiStore.getState().openGenerate(text);
}

interface Notice {
  text: string;
  tone: 'info' | 'error';
}

interface RequestResult {
  /** the request is on its way or done — the bar can go */
  close: boolean;
  /** something to say in the bar instead (it stays open) */
  notice?: Notice;
}

/**
 * Free text, in order: a link → import the product and start placing it;
 * a brief for a whole house → Generate; anything else → edit this plan.
 */
async function runRequest(
  raw: string,
  signal: AbortSignal,
  setLabel: (label: string) => void = () => {},
): Promise<RequestResult> {
  const t = raw.trim();
  if (!t) return { close: false };
  const plan = getPlanData();
  const link = looksLikeProductUrl(t) ? t : extractUrl(t);
  const kind = link ? 'url' : classifyRequest(t, { empty: plan.walls.length === 0 && plan.furniture.length === 0 });

  if (kind === 'brief') {
    // Generate owns its own progress and key handling.
    handToGenerate(t).catch((e: unknown) => toast(aiErrorMessage(e), { tone: 'error' }));
    return { close: true };
  }

  if (!(await ensureApiKey()) || signal.aborted) return { close: false };

  if (kind === 'url' && link) {
    setLabel('Reading the product page');
    const item = await importProductFromUrl(link, signal);
    if (signal.aborted || useUiStore.getState().readOnly) return { close: false };
    const ui = useUiStore.getState();
    if (ui.mode !== 'plan') ui.setMode('plan');
    ui.startPlacing(customKind(item.id));
    toast(`Click where the ${item.label.toLowerCase()} goes.`);
    return { close: true };
  }

  setLabel('Working on it');
  const outcome = await askEdit(t, signal);
  if (outcome.status === 'done') return { close: true };
  return { close: false, notice: { text: outcome.message, tone: outcome.status === 'cannot' ? 'info' : 'error' } };
}

interface Context {
  label: string;
  detail?: string;
}

/** What "this" means right now: the selection, in a few words. */
function readContext(): Context | null {
  const ui = useUiStore.getState();
  const plan = getPlanData();
  const units = plan.settings.units;
  if (ui.selectedRoomKey) {
    const room = detectRooms(plan.walls).find((r) => r.key === ui.selectedRoomKey);
    if (room) return { label: plan.roomNames[room.key] ?? 'Room', detail: formatArea(room.area, units) };
  }
  if (ui.selectedWallIds.length === 1) {
    const w = plan.walls.find((x) => x.id === ui.selectedWallIds[0]);
    if (w) return { label: 'Wall', detail: formatLength(dist(w.a, w.b), units) };
  } else if (ui.selectedWallIds.length > 1) {
    return { label: `${ui.selectedWallIds.length} walls` };
  }
  if (ui.selectedOpeningIds.length === 1) {
    const o = plan.openings.find((x) => x.id === ui.selectedOpeningIds[0]);
    if (o) return { label: o.type === 'door' ? 'Door' : 'Window', detail: formatLength(o.width, units) };
  } else if (ui.selectedOpeningIds.length > 1) {
    return { label: `${ui.selectedOpeningIds.length} openings` };
  }
  if (ui.selectedFurnitureIds.length === 1) {
    const f = plan.furniture.find((x) => x.id === ui.selectedFurnitureIds[0]);
    const def = f && defFor(plan, f.kind);
    if (f && def) return { label: f.label || def.label };
  } else if (ui.selectedFurnitureIds.length > 1) {
    return { label: `${ui.selectedFurnitureIds.length} pieces` };
  }
  return null;
}

interface Command {
  id: string;
  label: string;
  /** extra words to match on */
  keywords?: string;
  kbd?: string;
  /** shown on the right in place of a key, e.g. a file extension */
  meta?: string;
  /** only listed once something is typed (keeps the empty bar short) */
  typedOnly?: boolean;
}

const exportLabel = (label: string): string =>
  /^[A-Z][a-z]/.test(label) ? `Export ${label.charAt(0).toLowerCase()}${label.slice(1)}` : `Export ${label}`;

/** The selected room, as a furnish command. Read once when the bar opens. */
function readRoomCommand(): { key: string; label: string; furnished: boolean } | null {
  const key = useUiStore.getState().selectedRoomKey;
  if (!key) return null;
  const plan = getPlanData();
  const room = detectRooms(plan.walls).find((r) => r.key === key);
  if (!room) return null;
  const furnished = plan.furniture.some((f) => pointInPolygon({ x: f.x, y: f.y }, room.polygon));
  const name = plan.roomNames[key];
  return { key, furnished, label: `${furnished ? 'Refurnish' : 'Furnish'} ${name ? `the ${name.toLowerCase()}` : 'this room'}` };
}

type Row = { type: 'command'; command: Command } | { type: 'send'; verb: string; text: string };

/** A task the bar waits on. Resolve `true` to keep the bar open afterwards. */
type Task = (signal: AbortSignal, setLabel: (label: string) => void) => Promise<boolean | void>;

/** ⌘K — one field for commands and for anything you would ask Claude to change. */
export function CommandBar() {
  const open = useUiStore((s) => s.commandOpen);
  const readOnly = useUiStore((s) => s.readOnly);

  // A plan you are only viewing cannot be asked to change.
  useEffect(() => {
    if (open && readOnly) useUiStore.getState().closeCommand();
  }, [open, readOnly]);

  if (!open || readOnly) return null;
  return <Bar />;
}

function Bar() {
  const [text, setText] = useState(() => useUiStore.getState().commandSeed);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [context] = useState(readContext);
  const [roomCommand] = useState(readRoomCommand);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const mode = useUiStore((s) => s.mode);
  const showDimensions = useUiStore((s) => s.showDimensions);
  const units = useUnits();
  const hasWalls = usePlanStore((s) => s.walls.length > 0);
  const empty = usePlanStore((s) => s.walls.length === 0 && s.furniture.length === 0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      taskRef.current?.abort();
      taskRef.current = null;
    };
  }, []);

  const close = () => useUiStore.getState().closeCommand();

  const runTask = (label: string, task: Task): void => {
    taskRef.current?.abort();
    const ctl = new AbortController();
    taskRef.current = ctl;
    setBusy(label);
    setNotice(null);
    const current = () => alive.current && taskRef.current === ctl;
    task(ctl.signal, (l) => {
      if (current()) setBusy(l);
    })
      .then((keep) => {
        if (current() && !ctl.signal.aborted && !keep) close();
      })
      .catch((e: unknown) => {
        if (!current() || ctl.signal.aborted || isAbort(e)) return;
        setNotice({ text: aiErrorMessage(e), tone: 'error' });
      })
      .finally(() => {
        if (!current()) return;
        taskRef.current = null;
        setBusy(null);
        requestAnimationFrame(() => inputRef.current?.focus());
      });
  };

  const stop = (): void => {
    taskRef.current?.abort();
    taskRef.current = null;
    setBusy(null);
    setNotice({ text: 'Stopped.', tone: 'info' });
  };

  // Esc works even when focus has wandered off the field (re-bound each render: it reads `busy`).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target === inputRef.current || useKeyStore.getState().asking) return;
      e.preventDefault();
      e.stopPropagation();
      if (busy) stop();
      else close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const send = (raw: string): void => {
    runTask('Working on it', async (signal, setLabel) => {
      const result = await runRequest(raw, signal, setLabel);
      if (result.notice && !signal.aborted && alive.current) setNotice(result.notice);
      return !result.close;
    });
  };

  const furnishAll = (): void => {
    runTask('Furnishing rooms', async (signal, setLabel) => {
      const r = await furnishWholePlan(signal, (done, total) => {
        if (total > 1) setLabel(`Furnishing rooms · ${done} of ${total}`);
      });
      if (r.placed === 0) {
        const noRooms = detectRooms(getPlanData().walls).length === 0;
        setNotice(
          r.failed > 0
            ? { text: "Couldn't furnish any room — try again.", tone: 'error' }
            : noRooms
              ? { text: 'Close a room first — there is nothing to furnish yet.', tone: 'info' }
              : { text: 'Nothing to furnish: every room already has furniture.', tone: 'info' },
        );
        return true;
      }
      const skipped = r.failed > 0 ? ` ${r.failed} room${r.failed === 1 ? '' : 's'} skipped.` : '';
      toast(
        `Furnished ${r.rooms} room${r.rooms === 1 ? '' : 's'} with ${r.placed} piece${r.placed === 1 ? '' : 's'}.${skipped}`,
        { action: { label: 'Undo', run: () => void (!useUiStore.getState().readOnly && undo()) } },
      );
      return false;
    });
  };

  const commands: Command[] = [
    { id: 'generate', label: 'Generate from a brief…', keywords: 'new house home layout design create plan', kbd: 'G' },
    ...(roomCommand && hasWalls ? [{ id: 'furnish-room', label: roomCommand.label, keywords: 'furniture ai room' }] : []),
    ...(hasWalls ? [{ id: 'furnish-all', label: 'Furnish all rooms', keywords: 'furniture ai every house' }] : []),
    { id: 'product', label: 'Add an Amazon product', keywords: 'url link amazon ikea import furniture item paste search shop buy', kbd: 'A' },
    {
      id: 'dimensions',
      label: showDimensions ? 'Hide wall dimensions' : 'Show wall dimensions',
      keywords: 'toggle lengths measurements labels',
      kbd: 'L',
    },
    {
      id: 'units',
      label: units === 'm' ? 'Switch to feet' : 'Switch to meters',
      keywords: 'units toggle imperial metric inches metres',
    },
    { id: 'fit', label: 'Zoom to fit', keywords: 'view center whole plan', kbd: '0' },
    ...(mode === 'model'
      ? [{ id: 'plan', label: 'Back to plan', keywords: 'model 2d drawing', kbd: 'B' }]
      : hasWalls
        ? [{ id: 'build', label: 'Build model', keywords: '3d view walk extrude', kbd: 'B' }]
        : []),
    { id: 'projects', label: 'Projects and templates', keywords: 'open switch file', kbd: 'P' },
    { id: 'shortcuts', label: 'Keyboard shortcuts', keywords: 'keys help', kbd: '?' },
    ...(hasWalls
      ? EXPORTS.map((e) => ({
          id: `export:${e.id}`,
          label: e.group === 'Plan file' ? e.label : exportLabel(e.label),
          keywords: `export download file ${e.ext.replace('.', '')} ${e.group}`,
          meta: e.ext,
          typedOnly: true,
        }))
      : []),
  ];

  const runCommand = (id: string): void => {
    const ui = useUiStore.getState();
    switch (id) {
      case 'furnish-all':
        furnishAll();
        return;
      case 'product':
        close();
        ui.openProducts();
        return;
    }
    // Everything else acts at once and gets out of the way.
    close();
    if (id.startsWith('export:')) {
      // Export entries report their own problems as toasts and never reject.
      void EXPORTS.find((e) => `export:${e.id}` === id)?.run();
      return;
    }
    switch (id) {
      case 'generate':
        ui.openGenerate();
        break;
      case 'furnish-room':
        if (roomCommand) void runFurnish(roomCommand.key, { replace: roomCommand.furnished });
        break;
      case 'dimensions':
        ui.setShowDimensions(!ui.showDimensions);
        break;
      case 'units':
        if (!ui.readOnly) usePlanStore.getState().updateSettings({ units: units === 'm' ? 'ft' : 'm' });
        break;
      case 'fit': {
        // What the 0 key does in each view, and no more: fitNonce is for a different plan being loaded.
        const scene = useViewStore.getState();
        if (ui.mode !== 'model') ui.requestZoomFit();
        else if (!scene.walking) scene.resetView();
        break;
      }
      case 'plan':
        ui.setMode('plan');
        break;
      case 'build':
        ui.setMode('model');
        break;
      case 'projects':
        ui.setPanel('projects');
        break;
      case 'shortcuts':
        ui.setShortcutsOpen(true);
        break;
    }
  };

  const rows = ((): Row[] => {
    const q = text.trim();
    if (!q) return commands.filter((c) => !c.typedOnly).map((command) => ({ type: 'command', command }));
    const scored = commands
      .map((command, i) => ({ command, i, score: scoreCommand(q, command.label, command.keywords) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const link = looksLikeProductUrl(q) || !!extractUrl(q);
    const verb = link ? 'Add this product' : classifyRequest(q, { empty }) === 'brief' ? 'Generate a plan' : 'Ask Gaudí';
    const sendRow: Row = { type: 'send', verb, text: q };
    if (link) return [sendRow];
    const strong = scored.filter((x) => x.score >= 100);
    // A whole sentence is a request, not a mistyped command.
    const weak = q.split(/\s+/).length <= 3 ? scored.filter((x) => x.score < 100) : [];
    return [
      ...strong.map((x): Row => ({ type: 'command', command: x.command })),
      sendRow,
      ...weak.map((x): Row => ({ type: 'command', command: x.command })),
    ];
  })();

  const at = Math.min(cursor, Math.max(0, rows.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const runRow = (row: Row | undefined): void => {
    if (!row || busy) return;
    if (row.type === 'send') send(row.text);
    else runCommand(row.command.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Nothing typed here should reach the canvas shortcuts.
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (busy) stop();
      else close();
      return;
    }
    if (busy || e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((at + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runRow(rows[at]);
    }
  };

  const placeholder = context
    ? 'Say what should change, or pick a command'
    : 'Ask for a change, or pick a command';

  return (
    <div
      className="ask-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="ask"
        role="dialog"
        aria-label="Ask Gaudí"
        onMouseDown={(e) => {
          // Clicking the chrome must not take focus from the field.
          if (e.target !== inputRef.current) e.preventDefault();
        }}
      >
        <div className="ask-field">
          {busy ? <span className="spinner" /> : <span className="ask-glyph">✦</span>}
          {context && (
            <span className="chip ask-context" title="What “this” refers to — your selection">
              {context.label}
              {context.detail && <span className="mono">{context.detail}</span>}
            </span>
          )}
          <input
            ref={inputRef}
            className="ask-input"
            type="text"
            value={text}
            readOnly={!!busy}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            role="combobox"
            aria-label="Ask Gaudí"
            aria-expanded={rows.length > 0 && !busy}
            aria-controls="ask-list"
            aria-activedescendant={rows.length > 0 && !busy ? `ask-row-${at}` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setCursor(0);
              setNotice(null);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        {busy && (
          <div className="ask-status" role="status">
            <span className="hint">{busy}…</span>
            <span className="kbd">Esc</span>
            <span className="hint" style={{ flex: 'none' }}>
              stops
            </span>
          </div>
        )}
        {!busy && notice && (
          <div className="ask-status" role="status">
            <span className={`hint ${notice.tone === 'error' ? 'error' : ''}`}>{notice.text}</span>
          </div>
        )}
        {!busy && rows.length > 0 && (
          <div className="ask-list" id="ask-list" role="listbox" ref={listRef}>
            {rows.map((row, i) => (
              <button
                key={row.type === 'send' ? 'send' : row.command.id}
                id={`ask-row-${i}`}
                className={`menu-item ${i === at ? 'cursor' : ''}`}
                role="option"
                aria-selected={i === at}
                tabIndex={-1}
                onMouseMove={() => setCursor(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runRow(row)}
              >
                {row.type === 'send' ? (
                  <>
                    <span className="ask-row-label">
                      <span className="ask-row-send">{row.verb}</span> <em>“{row.text}”</em>
                    </span>
                    <span className="kbd">↵</span>
                  </>
                ) : (
                  <>
                    <span className="ask-row-label">{row.command.label}</span>
                    {row.command.kbd && <span className="kbd">{row.command.kbd}</span>}
                    {row.command.meta && <span className="menu-meta">{row.command.meta}</span>}
                  </>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Dev handle: lets a reviewer drive every Ask feature from the console.
if (import.meta.env.DEV) {
  window.__gaudi = {
    ...(window.__gaudi ?? {}),
    ask: {
      /** askEdit(text) → runs the `edit` call against the current plan and commits it */
      askEdit,
      /** describePlan(getPlanData(), selection) → { text, refs, kinds } as sent to Claude */
      describe: () => describePlan(getPlanData(), {
        wallIds: useUiStore.getState().selectedWallIds,
        openingIds: useUiStore.getState().selectedOpeningIds,
        furnitureIds: useUiStore.getState().selectedFurnitureIds,
        roomKey: useUiStore.getState().selectedRoomKey,
      }),
      /** applyOps(ops) → dry run against the current plan (nothing is committed) */
      applyOps: (ops: unknown) => {
        const plan = getPlanData();
        return applyOps(plan, ops, describePlan(plan).refs);
      },
      classify: (text: string) => classifyRequest(text, { empty: getPlanData().walls.length === 0 }),
      runFurnish,
      acceptFurnish,
      cancelFurnish,
      furnishWholePlan,
      /** send(text) → exactly what pressing Enter on free text does (link / brief / edit) */
      send: (text: string) => runRequest(text, new AbortController().signal),
      open: (seed?: string) => useUiStore.getState().openCommand(seed),
    },
  } as NonNullable<Window['__gaudi']>;
}
