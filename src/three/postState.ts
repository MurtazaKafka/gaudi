/** What the live view's picture passes share with the rest of the app. */

/** Numbers worth tuning by eye. */
export const POST_TUNING = {
  /** How far (meters) a surface looks for neighbours that shade it. */
  aoRadius: 0.7,
  aoStrength: 0.85,
  /** Share of the focus distance, either side, that stays perfectly sharp. */
  focusBand: 0.42,
  /** Largest blur, in screen pixels at 1× density. */
  maxBlur: 5,
};

/**
 * The picture, drawn through the passes. Set while a live view is mounted, so
 * Snapshot saves what is on screen rather than the bare scene.
 */
export const livePost: { draw: (() => void) | null } = { draw: null };

if (import.meta.env.DEV) {
  (window as unknown as { __post?: typeof POST_TUNING }).__post = POST_TUNING;
}
