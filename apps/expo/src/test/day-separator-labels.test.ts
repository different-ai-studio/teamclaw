import { describe, expect, it } from "vitest";

describe("dayLabel", () => {
  const now = Date.UTC(2026, 4, 20, 12, 0, 0);

  it('returns "今天" when the message is the same calendar day', async () => {
    const { dayLabel } = await import(
      "../features/sessions/components/day-separator-labels"
    );
    const iso = new Date(now).toISOString();
    expect(dayLabel(iso, now)).toBe("今天");
  });

  it('returns "昨天" when the message is the previous calendar day', async () => {
    const { dayLabel } = await import(
      "../features/sessions/components/day-separator-labels"
    );
    const iso = new Date(now - 86400000).toISOString();
    expect(dayLabel(iso, now)).toBe("昨天");
  });

  it("returns 月/日 inside the same year", async () => {
    const { dayLabel } = await import(
      "../features/sessions/components/day-separator-labels"
    );
    // 2026-01-15 -> "1月15日" relative to a May 2026 now
    const iso = "2026-01-15T03:00:00Z";
    expect(dayLabel(iso, now)).toBe("1月15日");
  });

  it("returns 年月日 when the year differs", async () => {
    const { dayLabel } = await import(
      "../features/sessions/components/day-separator-labels"
    );
    const iso = "2025-11-09T03:00:00Z";
    expect(dayLabel(iso, now)).toBe("2025年11月9日");
  });
});

describe("isSameCalendarDay", () => {
  it("treats two times on the same local day as equal", async () => {
    const { isSameCalendarDay } = await import(
      "../features/sessions/components/day-separator-labels"
    );
    const a = new Date(2026, 4, 20, 1).toISOString();
    const b = new Date(2026, 4, 20, 23).toISOString();
    expect(isSameCalendarDay(a, b)).toBe(true);
  });

  it("returns false across the day boundary", async () => {
    const { isSameCalendarDay } = await import(
      "../features/sessions/components/day-separator-labels"
    );
    const a = new Date(2026, 4, 20, 23, 59).toISOString();
    const b = new Date(2026, 4, 21, 0, 1).toISOString();
    expect(isSameCalendarDay(a, b)).toBe(false);
  });
});
