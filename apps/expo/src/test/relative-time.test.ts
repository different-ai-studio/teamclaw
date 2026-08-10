import { describe, expect, it } from "vitest";

import {
  formatRelativeAbbreviated,
  formatRelativeTime,
} from "../lib/relative-time";

const NOW = new Date("2026-05-20T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("formatRelativeTime", () => {
  it("counts up to a week, then switches to MM/DD", () => {
    expect(formatRelativeTime(ago(30), NOW)).toBe("now");
    expect(formatRelativeTime(ago(90), NOW)).toBe("1m");
    expect(formatRelativeTime(ago(3 * 3600), NOW)).toBe("3h");
    expect(formatRelativeTime(ago(3 * 86_400), NOW)).toBe("3d");
    // Past a week the sessions list shows a date, matching iOS `formatTime`.
    expect(formatRelativeTime(new Date("2026-01-02T00:00:00.000Z"), NOW)).toBe("01/02");
  });
});

describe("formatRelativeAbbreviated", () => {
  it("keeps counting in weeks, months and years", () => {
    expect(formatRelativeAbbreviated(ago(30), NOW)).toBe("now");
    expect(formatRelativeAbbreviated(ago(59 * 60), NOW)).toBe("59m");
    expect(formatRelativeAbbreviated(ago(23 * 3600), NOW)).toBe("23h");
    expect(formatRelativeAbbreviated(ago(6 * 86_400), NOW)).toBe("6d");
    expect(formatRelativeAbbreviated(ago(14 * 86_400), NOW)).toBe("2w");
    // 8 weeks is where iOS rolls over to months: 70d → 2mo, not 10w.
    expect(formatRelativeAbbreviated(ago(70 * 86_400), NOW)).toBe("2mo");
    expect(formatRelativeAbbreviated(ago(500 * 86_400), NOW)).toBe("1y");
  });

  it("clamps a future timestamp to now rather than counting backwards", () => {
    expect(formatRelativeAbbreviated(ago(-3600), NOW)).toBe("now");
  });

  it("returns an empty string for an unparseable value", () => {
    expect(formatRelativeAbbreviated("not-a-date", NOW)).toBe("");
  });
});
