import { describe, expect, it } from "vitest";

describe("matchesQuery", () => {
  it("returns true when every token in the query appears in the haystack", async () => {
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("Macmini agent runtime", "macmini")).toBe(true);
    expect(matchesQuery("Macmini agent runtime", "agent macmini")).toBe(true);
  });

  it("is case-insensitive", async () => {
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("Hello Expo", "expo")).toBe(true);
    expect(matchesQuery("Hello Expo", "HELLO")).toBe(true);
  });

  it("returns false when any token is missing", async () => {
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("Hello Expo", "missing")).toBe(false);
    expect(matchesQuery("Hello Expo", "expo missing")).toBe(false);
  });

  it("treats an empty query as a match for any haystack", async () => {
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("returns false on empty haystack with non-empty query", async () => {
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("", "needle")).toBe(false);
  });
});

describe("matchesAnyField", () => {
  it("joins fields and matches across them", async () => {
    const { matchesAnyField } = await import("../features/search/search-matcher");
    expect(
      matchesAnyField(["First idea", "About the new auth flow"], "auth idea"),
    ).toBe(true);
  });

  it("ignores nullish fields", async () => {
    const { matchesAnyField } = await import("../features/search/search-matcher");
    expect(matchesAnyField(["title", null, undefined, "tail"], "title tail")).toBe(true);
  });
});
