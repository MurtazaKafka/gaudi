/**
 * The Generate package's front door for the rest of the app (the ⌘K bar, the
 * empty state, dev tools).
 */
import { useUiStore } from '../uiStore';
import { layoutToPlan } from './layout';
import { parseBriefText } from './brief';
import { draftOptions } from './draft';
import { fillMask, programFit } from './fill';
import { outlineFromPolygon, readOutline, squareOff } from './outline';
import { generateProcedural } from './procedural';
import {
  applyBriefText,
  cancelRun,
  drawOutline,
  frameForRun,
  generate,
  outlineInUse,
  previewOption,
  setBrief,
  setUseOutline,
  squareOffOutline,
  useGenerateStore,
} from './run';
import { presetOutline, presetOutlines } from './shapes';

/**
 * A reply the 'generate-layout' tag would accept for the brief and canvas as
 * they are now — for mocking Claude in dev. With an outline in use the
 * coordinates are measured from the outline's north-west corner, as Claude is
 * asked to give them.
 */
function sampleReply(index = 0): unknown {
  // The fixed footprint Claude would be given: the canvas outline, or a framed preset (Z, H, cross, stepped).
  const frame = frameForRun();
  const options = draftOptions(useGenerateStore.getState().brief, { count: 5, outline: frame }).options;
  const d = options[index % Math.max(1, options.length)];
  if (!d) return { title: 'Empty', summary: '', rooms: [], links: [] };
  const ox = frame?.box.x ?? 0;
  const oy = frame?.box.y ?? 0;
  const n = (v: number) => Math.round(v * 1000) / 1000;
  return {
    title: d.layout.title ?? 'Layout',
    summary: d.layout.summary ?? '',
    rooms: d.layout.rooms.map((r) => ({ name: r.name, type: r.type, x: n(r.x - ox), y: n(r.y - oy), w: r.w, h: r.h })),
    links: d.layout.links.map((l) => ({ a: l.a, b: l.b, kind: l.kind })),
  };
}

/**
 * Open the Generate panel with `text` as the wish line. Counts, size, shape
 * and spaces the text clearly states ("3 bed 2 bath, 140 m², L-shaped, with
 * an office") are filled into the brief. Does not start a run — the person
 * reads the brief and presses Generate.
 */
export function generateFromText(text: string): void {
  const ui = useUiStore.getState();
  if (ui.readOnly) return;
  applyBriefText(text);
  // The brief is already filled, so the panel has nothing left to seed from.
  ui.openGenerate('');
}

if (import.meta.env.DEV) {
  window.__gaudi = {
    ...(window.__gaudi ?? {}),
    generate: {
      store: useGenerateStore,
      generateFromText,
      setBrief,
      applyBriefText,
      generate,
      cancelRun,
      previewOption,
      procedural: generateProcedural,
      layoutToPlan,
      parseBriefText,
    },
    // Footprints: outlines drawn on the canvas, preset shapes, the filler.
    shapes: {
      readOutline,
      outlineFromPolygon,
      outlineInUse,
      frameForRun,
      setUseOutline,
      drawOutline,
      squareOffOutline,
      squareOff,
      presetOutline,
      presetOutlines,
      fillMask,
      programFit,
      draftOptions,
      sampleReply,
    },
  } as Window['__gaudi'];
}
