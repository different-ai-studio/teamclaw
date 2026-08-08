/**
 * Rest-position logic for `SwipeableRow`, kept free of React and of
 * `@expo/vector-icons` so it can be unit-tested. Importing the component itself
 * from a test pulls in the icon set, which does not resolve under vitest's node
 * environment.
 */

/** Past this fraction of the action strip, release snaps open instead of shut. */
export const OPEN_RATIO = 0.5;
/** A fast enough flick decides the direction regardless of distance (points/second). */
export const FLICK_VELOCITY = 500;

export type SwipeRestInput = {
  /** Offset the row was resting at when the gesture began. */
  restOffset: number;
  /** Horizontal travel of the gesture (negative = leftwards). */
  translation: number;
  /** Horizontal velocity at release (negative = leftwards), points/second. */
  velocity: number;
  /** Width of the revealed action strip. */
  actionsWidth: number;
};

/**
 * Where the row should come to rest when the finger leaves: `0` (shut) or
 * `-actionsWidth` (open). Never anything in between.
 */
export function resolveSwipeRest({
  restOffset,
  translation,
  velocity,
  actionsWidth,
}: SwipeRestInput): number {
  // Nothing measured yet — opening would strand the row over an empty strip.
  if (actionsWidth <= 0) return 0;
  // Flicks are checked before distance, so a decisive flick back to the right
  // closes even from fully open, and a decisive left flick opens from barely
  // moved.
  if (velocity < -FLICK_VELOCITY) return -actionsWidth;
  if (velocity > FLICK_VELOCITY) return 0;
  const travelled = restOffset + translation;
  return travelled < -actionsWidth * OPEN_RATIO ? -actionsWidth : 0;
}
