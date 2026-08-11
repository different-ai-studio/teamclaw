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

describe("diacritic folding", () => {
  it("matches in both directions, accented or not", async () => {
    // Decomposing without stripping the marks only worked one way: "jose"
    // found "José", but "josé" did not find "Jose" — so searching *with* an
    // accent silently under-matched.
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("José Álvarez", "jose")).toBe(true);
    expect(matchesQuery("Jose Alvarez", "josé")).toBe(true);
    expect(matchesQuery("José Álvarez", "álvarez")).toBe(true);
    expect(matchesQuery("Jose Alvarez", "álvarez")).toBe(true);
  });

  it("folds case as well", async () => {
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("MACMINI", "macmini")).toBe(true);
    expect(matchesQuery("macmini", "MACMINI")).toBe(true);
  });

  it("leaves CJK alone", async () => {
    const { matchesQuery } = await import("../features/search/search-matcher");
    expect(matchesQuery("海港 · 前端", "海港")).toBe(true);
    expect(matchesQuery("海港", "前端")).toBe(false);
  });

  it("exposes the fold for callers that match field-by-field", async () => {
    const { foldForSearch } = await import("../features/search/search-matcher");
    expect(foldForSearch("José")).toBe("jose");
    expect(foldForSearch("  Ünïcödé  ")).toBe("unicode");
  });
});
