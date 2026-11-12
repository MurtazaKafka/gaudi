import { Fragment, useCallback, useRef, useState } from 'react';
import { usePlanStore } from '../store';
import { useUiStore } from '../uiStore';
import { usePreviewStore } from '../preview';
import { openPlanFile } from '../projects/projectStore';
import { toastError } from '../toast';
import { EXPORTS, EXPORT_GROUPS } from '../export';
import { useDismiss } from './useDismiss';
import '../styles/export.css';

/** One menu for everything that leaves or enters the app as a file. */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useDismiss(ref, open, useCallback(() => setOpen(false), []));

  const hasWalls = usePlanStore((s) => s.walls.length > 0);
  // Opening a file puts another plan on the canvas, so it waits while the plan is locked or a preview is up.
  const readOnly = useUiStore((s) => s.readOnly);
  const previewing = usePreviewStore((s) => s.active);
  const locked = readOnly || previewing;

  return (
    <div className="pop-anchor" ref={ref}>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          file
            .text()
            .then((text) => {
              // Things may have changed while the file picker was up.
              if (useUiStore.getState().readOnly || usePreviewStore.getState().active) {
                toastError("Can't open a file right now.");
                return;
              }
              // As a project of its own: the plan that was open is saved and stays in the library.
              openPlanFile(text);
            })
            .catch(() => toastError("Couldn't read that file."));
        }}
      />
      <button
        className={`btn ${open ? 'active' : ''}`}
        title="Export or open files"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Export
      </button>
      {open && (
        <div className="menu export-menu" role="menu">
          {EXPORT_GROUPS.filter((g) => g === 'Plan file' || EXPORTS.some((e) => e.group === g)).map((group, i) => (
            <Fragment key={group}>
              {i > 0 && <div className="menu-rule" />}
              <div className="menu-label">{group}</div>
              {EXPORTS.filter((e) => e.group === group).map((e) => (
                <button
                  key={e.id}
                  className="menu-item"
                  role="menuitem"
                  disabled={!hasWalls}
                  onClick={() => {
                    setOpen(false);
                    void e.run();
                  }}
                >
                  {e.label} <span className="menu-meta">{e.ext}</span>
                </button>
              ))}
              {group === 'Plan file' && (
                <button
                  className="menu-item"
                  role="menuitem"
                  disabled={locked}
                  onClick={() => {
                    setOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  Open plan… <span className="menu-meta">.json</span>
                </button>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
