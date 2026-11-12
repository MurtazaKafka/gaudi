/**
 * Display units. The plan is always stored in meters; these helpers only
 * format for reading and parse what a person types.
 */
import { usePlanStore } from './store';
import type { Units } from './types';

export const M_PER_FT = 0.3048;
export const SQFT_PER_M2 = 10.763910417;

/** "3.50 m" · "11′ 6″" */
export function formatLength(m: number, units: Units, digits = 2): string {
  if (units === 'm') return `${m.toFixed(digits)} m`;
  const totalIn = Math.round((m / M_PER_FT) * 12);
  const sign = totalIn < 0 ? '-' : '';
  const ft = Math.floor(Math.abs(totalIn) / 12);
  const inch = Math.abs(totalIn) % 12;
  return `${sign}${ft}′ ${inch}″`;
}

/** Compact form for tight labels: "3.5" · "11′6″" (no unit suffix in metric). */
export function formatLengthShort(m: number, units: Units): string {
  if (units === 'm') return `${Math.round(m * 100) / 100}`;
  return formatLength(m, units).replace(' ', '');
}

/** "24.0 m²" · "258 ft²" */
export function formatArea(m2: number, units: Units): string {
  if (units === 'm') return `${m2.toFixed(1)} m²`;
  return `${Math.round(m2 * SQFT_PER_M2).toLocaleString('en-US')} ft²`;
}

/** Footprint like "1.6×2.0" · "5′3″×6′7″" */
export function formatFootprint(w: number, d: number, units: Units): string {
  if (units === 'm') return `${w.toFixed(1)}×${d.toFixed(1)}`;
  return `${formatLengthShort(w, units)}×${formatLengthShort(d, units)}`;
}

export const unitSuffix = (units: Units): string => (units === 'm' ? 'm' : 'ft');

/** Convert a value in display units (decimal meters or decimal feet) to meters. */
export const toMeters = (v: number, units: Units): number => (units === 'm' ? v : v * M_PER_FT);
/** Convert meters to a decimal number in display units. */
export const fromMeters = (m: number, units: Units): number => (units === 'm' ? m : m / M_PER_FT);

/**
 * Parse typed lengths into meters. Understands: "3.5", "3.5m", "350cm",
 * "12ft", "12'", "12' 6\"", "12 6" (feet inches, when units are ft), "150in".
 * A bare number is read in the current display units. Returns null if unreadable.
 */
export function parseLength(text: string, units: Units): number | null {
  const t = text.trim().toLowerCase().replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  if (!t) return null;
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/))) {
    return (parseFloat(m[1]) + (m[2] ? parseFloat(m[2]) / 12 : 0)) * M_PER_FT;
  }
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/))) return (parseFloat(m[1]) / 12) * M_PER_FT;
  if ((m = t.match(/^(-?\d+(?:\.\d+)?)\s*(?:m|meter|meters|metre|metres)$/))) return parseFloat(m[1]);
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*cm$/))) return parseFloat(m[1]) / 100;
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*mm$/))) return parseFloat(m[1]) / 1000;
  if (units === 'ft' && (m = t.match(/^(\d+)\s+(\d+(?:\.\d+)?)$/))) {
    return (parseFloat(m[1]) + parseFloat(m[2]) / 12) * M_PER_FT;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return toMeters(parseFloat(t), units);
  return null;
}

/** Subscribe a component to the plan's display units. */
export function useUnits(): Units {
  return usePlanStore((s) => s.settings.units);
}

/** Non-reactive read, for event handlers and exporters. */
export function currentUnits(): Units {
  return usePlanStore.getState().settings.units;
}
