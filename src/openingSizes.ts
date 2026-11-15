import type { OpeningType } from './types';

/** A door this wide or wider is a pair of leaves; a window gets a third light. Drawn that way in plan and model alike. */
export const DOUBLE_DOOR_MIN = 1.5;
export const TRIPLE_WINDOW_MIN = 2.2;

/**
 * The sizes a click steps an opening through, smallest first: clicking a door
 * with the door tool makes it a wide door, then a pair; a window grows from
 * one light to three.
 */
export const OPENING_STEPS: Record<OpeningType, readonly number[]> = {
  door: [0.9, 1.2, 1.6],
  window: [0.6, 1.2, 1.8, 2.4],
};
