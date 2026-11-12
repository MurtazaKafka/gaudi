import { useEffect, useMemo, useState } from 'react';
import { PanelShell } from './PanelShell';
import { PlanThumb } from './PlanThumb';
import { useUiStore } from '../uiStore';
import { formatArea, useUnits } from '../units';
import { library } from '../projects/lib';
import { measurePlan, relativeTime, type ProjectMeta } from '../projects/library';
import {
  createFromTemplate,
  deleteProject,
  duplicateProject,
  newProject,
  openProject,
  renameProject,
  useProjectStore,
} from '../projects/projectStore';
import { buildTemplate, TEMPLATES, type Template } from '../projects/templates';
import type { PlanData, Units } from '../types';
import '../styles/projects.css';

const closePanel = () => useUiStore.getState().setPanel(null);

function Icon({ d }: { d: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICON_RENAME = 'M3 13l.6-2.9L10.9 2.8a1.2 1.2 0 0 1 1.7 0l.6.6a1.2 1.2 0 0 1 0 1.7L5.9 12.4 3 13z';
const ICON_COPY = 'M6 6h7v7H6zM3.5 10H3V3h7v.5';
const ICON_DELETE = 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5';

function ProjectCard({
  meta,
  current,
  units,
  now,
}: {
  meta: ProjectMeta;
  current: boolean;
  units: Units;
  now: number;
}) {
  const [renaming, setRenaming] = useState(false);
  // The stored copy; re-read only when it has been written again.
  const plan = useMemo(
    () => library.record(meta.id)?.plan ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta.id, meta.updatedAt],
  );

  const sub = [
    meta.area > 0 ? formatArea(meta.area, units) : 'No rooms yet',
    relativeTime(meta.updatedAt, now),
    meta.shareId ? 'shared' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const body = (
    <>
      <span className="pj-thumb">{plan && <PlanThumb plan={plan} width={64} height={48} showFurniture={false} />}</span>
      <span className="pj-meta">
        {renaming ? (
          <input
            className="pj-rename"
            autoFocus
            defaultValue={meta.name}
            maxLength={80}
            aria-label="Project name"
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.currentTarget.value = meta.name;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              const next = e.target.value.trim();
              setRenaming(false);
              if (next && next !== meta.name) renameProject(meta.id, next);
            }}
          />
        ) : (
          <span className="pj-name">{meta.name}</span>
        )}
        <span className="pj-sub">{sub}</span>
        {meta.remixedFrom && (
          <span className="pj-lineage" title={`Remixed from shared plan ${meta.remixedFrom}`}>
            Remix of {meta.remixedName ?? 'a shared plan'}
          </span>
        )}
      </span>
    </>
  );

  return (
    <div className={`pj-card ${current ? 'current' : ''}`}>
      {renaming ? (
        <div className="pj-open">{body}</div>
      ) : (
        <button
          className="pj-open"
          title={current ? 'Open now' : 'Open'}
          aria-current={current ? 'true' : undefined}
          onClick={() => {
            if (openProject(meta.id)) closePanel();
          }}
        >
          {body}
        </button>
      )}
      {!renaming && (
        <span className="pj-actions">
          <button className="icon-btn" title="Rename" aria-label={`Rename ${meta.name}`} onClick={() => setRenaming(true)}>
            <Icon d={ICON_RENAME} />
          </button>
          <button
            className="icon-btn"
            title="Duplicate"
            aria-label={`Duplicate ${meta.name}`}
            onClick={() => duplicateProject(meta.id)}
          >
            <Icon d={ICON_COPY} />
          </button>
          <button
            className="icon-btn"
            title="Delete"
            aria-label={`Delete ${meta.name}`}
            onClick={() => deleteProject(meta.id)}
          >
            <Icon d={ICON_DELETE} />
          </button>
        </span>
      )}
    </div>
  );
}

/** Templates never change, so each is built once for its tile. */
const tileCache = new Map<string, { plan: PlanData; area: number }>();

function tileFor(template: Template): { plan: PlanData; area: number } {
  let tile = tileCache.get(template.id);
  if (!tile) {
    const { plan } = buildTemplate(template);
    tile = { plan, area: measurePlan(plan).area };
    tileCache.set(template.id, tile);
  }
  return tile;
}

function TemplateTile({ template, units }: { template: Template; units: Units }) {
  const tile = tileFor(template);
  return (
    <button
      className="pj-template"
      title={`${template.name} — ${template.note}. Opens as a new project.`}
      onClick={() => {
        // Built afresh for the new project, so two projects from one template share nothing.
        if (createFromTemplate(template.id)) closePanel();
      }}
    >
      <span className="pj-template-thumb">
        <PlanThumb plan={tile.plan} width={116} height={70} />
      </span>
      <span className="pj-template-name">{template.name}</span>
      <span className="pj-template-sub">{formatArea(tile.area, units)}</span>
    </button>
  );
}

/** Saved plans and starter templates. */
export function ProjectsPanel() {
  const projects = useProjectStore((s) => s.projects);
  const currentId = useProjectStore((s) => s.currentId);
  const units = useUnits();
  const [now, setNow] = useState(() => Date.now());

  // Keep "5 min ago" honest while the panel stays open.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const latest = projects.reduce((m, p) => Math.max(m, p.updatedAt), 0);

  return (
    <PanelShell title="Projects">
      <div className="panel-section">
        <button
          className="btn block"
          onClick={() => {
            newProject();
            closePanel();
          }}
        >
          New plan
        </button>
        {projects.length === 0 ? (
          <div className="hint">Plans are kept here as you draw. Nothing to save, nothing to lose.</div>
        ) : (
          <div className="pj-list">
            {projects.map((p) => (
              <ProjectCard key={p.id} meta={p} current={p.id === currentId} units={units} now={Math.max(now, latest)} />
            ))}
          </div>
        )}
      </div>
      <div className="panel-section">
        <div className="label">Start from a template</div>
        <div className="pj-templates">
          {TEMPLATES.map((t) => (
            <TemplateTile key={t.id} template={t} units={units} />
          ))}
        </div>
      </div>
    </PanelShell>
  );
}
