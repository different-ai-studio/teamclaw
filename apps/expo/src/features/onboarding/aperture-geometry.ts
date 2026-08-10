/**
 * Geometry for the TeamClu mark — "缺口 / The Aperture": a ring broken at the
 * upper right with a coral dot resting in the notch.
 *
 * Every value is the brand kit's, against its 120-unit viewBox, and matches the
 * iOS `ApertureSplashView` verbatim so the two apps draw the same mark:
 *
 *   ring   centre (60,60) · radius 38 · stroke 12 · round caps
 *   notch  centred on -45° (upper right), 60° wide
 *   dot    radius 9, sitting on the ring line at -45°
 */

export const APERTURE = {
  viewBox: 120,
  centre: 60,
  ringRadius: 38,
  strokeWidth: 12,
  dotRadius: 9,
  /** The notch spans 60° of 360°. */
  gapDegrees: 60,
  /** Notch centre, in clockwise-from-3-o'clock degrees. */
  notchCentreDegrees: -45,
} as const;

/** One unhurried lap, eased at both ends. */
export const APERTURE_LAP_MS = 2800;

/**
 * Let the first frame land before starting, so the dot is visible at rest in
 * the notch rather than mid-lap on appear.
 */
export const APERTURE_START_DELAY_MS = 80;

export const APERTURE_COLORS = {
  /** #1a1a14 — the ring on light backgrounds. */
  ink: "#1A1A14",
  /** #fdfbf7 — the ring reversed out on dark backgrounds. */
  cream: "#FDFBF7",
  /** #e85a4a — the dot. The kit's only accent; do not introduce a third colour. */
  coral: "#E85A4A",
} as const;

function pointOnRing(degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: APERTURE.centre + APERTURE.ringRadius * Math.cos(radians),
    y: APERTURE.centre + APERTURE.ringRadius * Math.sin(radians),
  };
}

/**
 * SVG path for the ring's arc: everything except the notch.
 *
 * Both SVG and SwiftUI measure angles clockwise from 3 o'clock in a y-down
 * space, so the arc runs from the notch's trailing edge round to its leading
 * edge, and the sweep flag is 1.
 */
export function apertureArcPath(): string {
  const half = APERTURE.gapDegrees / 2;
  const start = APERTURE.notchCentreDegrees + half;
  const end = APERTURE.notchCentreDegrees - half + 360;
  const from = pointOnRing(start);
  const to = pointOnRing(end);
  // The drawn arc is 360 - gap = 300°, always greater than a half turn.
  const largeArc = 1;
  const sweep = 1;
  const r = APERTURE.ringRadius;
  return [
    `M ${from.x.toFixed(3)} ${from.y.toFixed(3)}`,
    `A ${r} ${r} 0 ${largeArc} ${sweep} ${to.x.toFixed(3)} ${to.y.toFixed(3)}`,
  ].join(" ");
}

/**
 * Rotation applied to the dot's container, in degrees.
 *
 * The dot is parked at 12 o'clock and rotated into place, so a single rotation
 * drives the whole lap — the same trick the Swift uses. 12 o'clock is -90°, so
 * the offset brings the resting position to the notch centre.
 */
export function apertureDotRotation(lapProgress: number): number {
  return APERTURE.notchCentreDegrees + 90 + lapProgress * 360;
}
