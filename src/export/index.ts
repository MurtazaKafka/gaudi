/**
 * Everything that leaves Gaudí as a file. `EXPORTS` is the one list the
 * Export menu and the command bar both read; each writer is loaded on first
 * use so none of them weigh on startup.
 */
import { getPlanData } from '../plan';
import { downloadBlob, planToFile } from '../serialize';
import { toastError } from '../toast';
import type { PlanData } from '../types';
import { fileStem } from './text';

export type ExportGroup = 'Drawing' | 'CAD & BIM' | '3D' | 'Data' | 'Plan file';
export const EXPORT_GROUPS: readonly ExportGroup[] = ['Drawing', 'CAD & BIM', '3D', 'Data', 'Plan file'];

export interface ExportFile {
  data: string | Uint8Array | Blob;
  /** MIME type */ type: string;
}

export interface ExportEntry {
  id: string;
  /** Menu label, e.g. "Plan sheet". */
  label: string;
  /** With the dot: ".pdf". */
  ext: string;
  group: ExportGroup;
  /** Write the current plan to a file and download it. Never rejects — problems are shown as a toast. */
  run: () => Promise<void>;
  /** The file's contents for a given plan, without downloading (absent for exports that save themselves). */
  build?: (plan: PlanData) => Promise<ExportFile>;
}

function currentPlan(): PlanData {
  const plan = getPlanData();
  if (plan.walls.length === 0) throw new Error('Draw a wall first.');
  return plan;
}

function report(e: unknown): void {
  toastError(e instanceof Error && e.message ? e.message : 'Export failed.');
}

function fileExport(
  id: string,
  label: string,
  ext: string,
  group: ExportGroup,
  build: (plan: PlanData) => Promise<ExportFile>,
): ExportEntry {
  return {
    id,
    label,
    ext,
    group,
    build,
    run: async () => {
      try {
        const plan = currentPlan();
        const file = await build(plan);
        downloadBlob(file.data as BlobPart, `${fileStem(plan.name)}${ext}`, file.type);
      } catch (e) {
        report(e);
      }
    },
  };
}

export const EXPORTS: readonly ExportEntry[] = [
  fileExport('pdf', 'Plan sheet', '.pdf', 'Drawing', async (plan) => {
    const { planToPdf } = await import('./pdf');
    return { data: planToPdf(plan), type: 'application/pdf' };
  }),
  fileExport('png', 'Image', '.png', 'Drawing', async (plan) => {
    const [{ buildSheet }, { sheetToSvg }, { svgToPng }] = await Promise.all([
      import('./drawing'),
      import('./svg'),
      import('./png'),
    ]);
    const sheet = buildSheet(plan);
    return { data: await svgToPng(sheetToSvg(sheet), sheet.page.w, sheet.page.h), type: 'image/png' };
  }),
  fileExport('svg', 'Vector drawing', '.svg', 'Drawing', async (plan) => {
    const [{ buildSheet }, { sheetToSvg }] = await Promise.all([import('./drawing'), import('./svg')]);
    return { data: sheetToSvg(buildSheet(plan)), type: 'image/svg+xml' };
  }),
  fileExport('dxf', 'CAD drawing', '.dxf', 'CAD & BIM', async (plan) => {
    const { planToDxf } = await import('./dxf');
    return { data: planToDxf(plan), type: 'application/dxf' };
  }),
  fileExport('ifc', 'Building model', '.ifc', 'CAD & BIM', async (plan) => {
    const { planToIfc } = await import('./ifc');
    return { data: planToIfc(plan), type: 'application/x-step' };
  }),
  {
    id: 'glb',
    label: '3D model',
    ext: '.glb',
    group: '3D',
    run: async () => {
      try {
        currentPlan();
        const { exportGlb } = await import('../exportGlb');
        await exportGlb();
      } catch (e) {
        report(e);
      }
    },
  },
  fileExport('csv', 'Room schedule', '.csv', 'Data', async (plan) => {
    const { scheduleCsv } = await import('./schedule');
    return { data: scheduleCsv(plan), type: 'text/csv;charset=utf-8' };
  }),
  fileExport('json', 'Save plan', '.json', 'Plan file', async (plan) => ({
    data: JSON.stringify(planToFile(plan), null, 2),
    type: 'application/json',
  })),
];

export function exportById(id: string): ExportEntry | undefined {
  return EXPORTS.find((e) => e.id === id);
}

if (import.meta.env.DEV) {
  // window.__gaudi.export — drive the writers from the console or a test.
  const w = window as unknown as { __gaudi?: Record<string, unknown> };
  w.__gaudi = {
    ...(w.__gaudi ?? {}),
    export: {
      EXPORTS,
      run: (id: string) => exportById(id)?.run(),
      /** Contents of one export for the current plan (or a given one), without downloading. */
      build: async (id: string, plan?: PlanData) => {
        const entry = exportById(id);
        if (!entry?.build) throw new Error(`No buildable export "${id}".`);
        return entry.build(plan ?? currentPlan());
      },
    },
  };
}
