import { describe, expect, it } from "vitest";

describe("uuidV4", () => {
  it("produces an RFC4122 v4 UUID format", async () => {
    const { uuidV4 } = await import("../lib/uuid");
    const value = uuidV4();
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("yields distinct values across repeated calls", async () => {
    const { uuidV4 } = await import("../lib/uuid");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(uuidV4());
    }
    expect(seen.size).toBeGreaterThan(190);
  });
});
