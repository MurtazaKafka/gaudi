/**
 * Dressing a generated plan for the canvas: an option brings walls, openings
 * and room names; everything that belongs to the person's document — its
 * name, units and other settings, its look (style and roof), its imported
 * items — stays as it is. Pure.
 */
import type { PlanData } from '../types';
import type { Brief } from './brief';

/** True for a plan nobody has touched: nothing drawn and still carrying the default name. */
export function isBlankPlan(plan: Pick<PlanData, 'name' | 'walls' | 'furniture'>, defaultName: string): boolean {
  const name = plan.name.trim();
  return plan.walls.length === 0 && plan.furniture.length === 0 && (name === '' || name === defaultName);
}

/** "3-bed house" · "Studio" — what an untitled plan is called once an option is accepted into it. */
export function briefPlanName(brief: Brief): string {
  return brief.bedrooms === 0 ? 'Studio' : `${brief.bedrooms}-bed house`;
}

export interface DressOptions {
  /** The store's default plan name ("Untitled plan"). */
  defaultName: string;
  /** Carry the furniture already on the canvas over (rooms were fitted into the person's own outline). */
  keepFurniture?: boolean;
}

/**
 * The plan an option becomes when previewed / accepted. Look, units (all
 * settings) and name are the real plan's — only a blank, untitled plan takes
 * a name from the brief.
 */
export function dressOption(option: PlanData, real: PlanData, brief: Brief, opts: DressOptions): PlanData {
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    name: isBlankPlan(real, opts.defaultName) ? briefPlanName(brief) : real.name,
    walls: copy(option.walls),
    openings: copy(option.openings),
    furniture: opts.keepFurniture ? copy(real.furniture) : copy(option.furniture),
    roomNames: { ...option.roomNames },
    settings: { ...real.settings },
    customItems: copy(real.customItems),
    look: { ...real.look },
  };
}
