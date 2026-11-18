/**
 * Davidson College, whole: every building on campus in one plan.
 *
 * The outlines, positions and names are the real ones (OpenStreetMap). The
 * rooms inside are designed, not surveyed: Davidson publishes floor plans for
 * few of its buildings, so each interior is a plausible ground floor built
 * round the rooms a building is known for (Chambers' Lilly Gallery, the
 * library's Davidsoniana Room, Belk Arena in Baker). The Hurt Hub is the
 * app's own template, set on its real footprint.
 *
 * At about 3,300 walls the plan is far too big to carry in the page for a
 * tile, so it is a file fetched when the template is chosen; the tile shows
 * the outlines alone.
 */
import type { PlanData, Wall } from '../types';
import { DAVIDSON_OUTLINES } from './davidsonOutlines';
import type { Template } from './templates';

const outlineWalls: Wall[] = DAVIDSON_OUTLINES.flatMap((poly, b) =>
  poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return { id: `o${b}-${i}`, a: { x: p[0], y: p[1] }, b: { x: q[0], y: q[1] } };
  }),
).filter((w) => w.a.x !== w.b.x || w.a.y !== w.b.y);

const tile: PlanData = {
  name: 'Davidson College',
  walls: outlineWalls,
  openings: [],
  furniture: [],
  roomNames: {},
  settings: { wallHeight: 3.3, wallThickness: 0.2, gridSize: 0.5, units: 'm' },
  customItems: {},
  look: { style: 'industrial', roof: 'hip' },
};

async function load(): Promise<PlanData> {
  const res = await fetch(`${import.meta.env.BASE_URL}templates/davidson-college.json`);
  if (!res.ok) throw new Error('The campus plan could not be fetched.');
  // Asked for here, not at the top: this file is read by the template list, which stays free of the stores.
  const { normalizePlan } = await import('../plan');
  const checked = normalizePlan(await res.json());
  if (!checked.ok) throw new Error(checked.error);
  return checked.plan;
}

export const DAVIDSON: Template = {
  id: 'davidson-college',
  name: 'Davidson College',
  note: 'The whole campus, 116 buildings',
  layout: { rooms: [], links: [] },
  items: [],
  big: { tile, load },
};
