import { describe, expect, it } from "vitest";
import { outboxBackoffMs, OUTBOX_MAX_ATTEMPTS } from "../features/sessions/outbox-backoff";

describe("outboxBackoffMs", () => {
  it("returns 500ms for the first failure", () => {
    expect(outboxBackoffMs(1)).toBe(500);
  });
  it("doubles each step up to the cap", () => {
    expect(outboxBackoffMs(2)).toBe(1000);
    expect(outboxBackoffMs(3)).toBe(2000);
    expect(outboxBackoffMs(4)).toBe(4000);
    expect(outboxBackoffMs(5)).toBe(8000);
    expect(outboxBackoffMs(6)).toBe(16000);
    expect(outboxBackoffMs(7)).toBe(30000);
  });
  it("caps at 30s for all later attempts", () => {
    expect(outboxBackoffMs(20)).toBe(30000);
  });
});

describe("OUTBOX_MAX_ATTEMPTS", () => {
  it("matches iOS budget", () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBe(20);
  });
});
