import { describe, expect, it } from "vitest";

import { isAgentOnline } from "../features/actors/connected-agent-types";

const NOW = new Date("2026-05-20T10:00:00.000Z").getTime();

describe("isAgentOnline", () => {
  it("returns false when lastActiveAt is null", () => {
    expect(isAgentOnline({ lastActiveAt: null } as any, NOW)).toBe(false);
  });
  it("returns true when within 120s window", () => {
    const at = new Date(NOW - 119_000).toISOString();
    expect(isAgentOnline({ lastActiveAt: at } as any, NOW)).toBe(true);
  });
  it("returns false at the boundary", () => {
    const at = new Date(NOW - 120_000).toISOString();
    expect(isAgentOnline({ lastActiveAt: at } as any, NOW)).toBe(false);
  });
  it("returns false for malformed strings", () => {
    expect(isAgentOnline({ lastActiveAt: "nope" } as any, NOW)).toBe(false);
  });
});
