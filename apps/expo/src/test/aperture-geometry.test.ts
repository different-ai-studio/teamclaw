import { describe, expect, it } from "vitest";

import {
  APERTURE,
  apertureArcPath,
  apertureDotRotation,
} from "../features/onboarding/aperture-geometry";

/** Re-derive a point on the ring independently of the module under test. */
function ringPoint(degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: APERTURE.centre + APERTURE.ringRadius * Math.cos(radians),
    y: APERTURE.centre + APERTURE.ringRadius * Math.sin(radians),
  };
}

describe("apertureArcPath", () => {
  it("starts and ends on the notch edges, 60° apart at the upper right", () => {
    const path = apertureArcPath();
    const numbers = path.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
    // "M x y A r r 0 largeArc sweep x2 y2"
    const [startX, startY, rx, ry, xRotation, largeArc, sweep, endX, endY] = numbers;

    const expectedStart = ringPoint(APERTURE.notchCentreDegrees + APERTURE.gapDegrees / 2);
    const expectedEnd = ringPoint(APERTURE.notchCentreDegrees - APERTURE.gapDegrees / 2);

    expect(startX).toBeCloseTo(expectedStart.x, 2);
    expect(startY).toBeCloseTo(expectedStart.y, 2);
    expect(endX).toBeCloseTo(expectedEnd.x, 2);
    expect(endY).toBeCloseTo(expectedEnd.y, 2);

    expect(rx).toBe(APERTURE.ringRadius);
    expect(ry).toBe(APERTURE.ringRadius);
    expect(xRotation).toBe(0);
    // The drawn arc is 300°, so it must take the long way round, clockwise.
    expect(largeArc).toBe(1);
    expect(sweep).toBe(1);
  });

  it("leaves the notch centred on -45°", () => {
    const notchStart = APERTURE.notchCentreDegrees - APERTURE.gapDegrees / 2;
    const notchEnd = APERTURE.notchCentreDegrees + APERTURE.gapDegrees / 2;
    expect((notchStart + notchEnd) / 2).toBe(-45);
    expect(notchEnd - notchStart).toBe(60);
  });
});

describe("apertureDotRotation", () => {
  it("rests in the notch and returns to it after one lap", () => {
    // The dot is parked at 12 o'clock (-90°), so resting in the notch means a
    // rotation of notchCentre + 90.
    expect(apertureDotRotation(0)).toBe(APERTURE.notchCentreDegrees + 90);
    expect(apertureDotRotation(1)).toBe(apertureDotRotation(0) + 360);
  });

  it("travels monotonically through the lap", () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map(apertureDotRotation);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });
});
