import { describe, expect, it } from "vitest";

import { resolveSwipeRest } from "../ui/swipeable-row-rest";

const WIDTH = 100;

/** A release with no meaningful velocity, so distance alone decides. */
function released(restOffset: number, translation: number) {
  return resolveSwipeRest({
    restOffset,
    translation,
    velocity: 0,
    actionsWidth: WIDTH,
  });
}

describe("resolveSwipeRest", () => {
  it("stays shut for a drag that does not clear half the strip", () => {
    expect(released(0, -10)).toBe(0);
    expect(released(0, -49)).toBe(0);
  });

  it("opens once the drag clears half the strip", () => {
    expect(released(0, -51)).toBe(-WIDTH);
    expect(released(0, -WIDTH)).toBe(-WIDTH);
  });

  it("closes an open row once it is dragged back past half", () => {
    // Starting open (-100) and dragging right by 60 leaves it at -40.
    expect(released(-WIDTH, 60)).toBe(0);
    // Still past halfway, so it snaps back open.
    expect(released(-WIDTH, 40)).toBe(-WIDTH);
  });

  it("opens on a fast left flick even when barely dragged", () => {
    expect(
      resolveSwipeRest({
        restOffset: 0,
        translation: -5,
        velocity: -900,
        actionsWidth: WIDTH,
      }),
    ).toBe(-WIDTH);
  });

  it("closes on a fast right flick even from fully open", () => {
    expect(
      resolveSwipeRest({
        restOffset: -WIDTH,
        translation: -0,
        velocity: 900,
        actionsWidth: WIDTH,
      }),
    ).toBe(0);
  });

  it("never opens before the action strip has been measured", () => {
    // `onLayout` has not fired yet: opening to -0 would strand the row with no
    // buttons visible under it.
    expect(
      resolveSwipeRest({
        restOffset: 0,
        translation: -400,
        velocity: -2000,
        actionsWidth: 0,
      }),
    ).toBe(0);
  });

  it("clamps to the two rest positions and nothing in between", () => {
    const outcomes = new Set(
      [-200, -120, -80, -60, -40, -20, 0, 20, 80].map((t) => released(0, t)),
    );
    expect([...outcomes].sort((a, b) => a - b)).toEqual([-WIDTH, 0]);
  });
});
