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
  /**
   * Draw a quicker, plainer picture while the view is moving and the full one when it comes to
   * rest. Off for a recording, where every frame is kept.
   */
  adaptive: true,
};

/**
 * The picture, drawn through the passes. Set while a live view is mounted, so
 * Snapshot saves what is on screen rather than the bare scene. `draw` is always
 * the full picture; `frame` is the view's own frame, which may be the quick one.
 */
export const livePost: { draw: (() => void) | null; frame: (() => void) | null } = { draw: null, frame: null };

if (import.meta.env.DEV) {
  // The demo recorder keeps every frame, so it asks (before the page loads) for each to be drawn in full.
  if ((window as unknown as { __fullFrames?: boolean }).__fullFrames) POST_TUNING.adaptive = false;
  (window as unknown as { __post?: typeof POST_TUNING }).__post = POST_TUNING;
}
