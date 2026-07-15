import { beforeEach, describe, expect, it } from "vitest";
import { loadPinnedSessionIds, savePinnedSessionIds } from "../session-pins";

const STORAGE_KEY = "teamclaw-pinned-sessions";

describe("session-pins (team-scoped)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads and saves pins under team id", () => {
    savePinnedSessionIds("team-a", ["s1", "s2"]);
    expect(loadPinnedSessionIds("team-a")).toEqual(["s1", "s2"]);
    expect(loadPinnedSessionIds("team-b")).toEqual([]);
  });

  it("migrates legacy workspace keys into team scope on first load", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        "/Users/dev/TeamClaw": ["s-pin"],
        "/Users/dev/other-ws": ["s-other"],
        __legacy__: ["s-legacy"],
      }),
    );

    const ids = loadPinnedSessionIds("team-a");
    expect(ids.sort()).toEqual(["s-legacy", "s-other", "s-pin"].sort());

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
      string,
      string[]
    >;
    expect(stored["team-a"].sort()).toEqual(["s-legacy", "s-other", "s-pin"].sort());
    expect(stored["/Users/dev/TeamClaw"]).toBeUndefined();
    expect(stored.__legacy__).toBeUndefined();
  });

  it("keeps team pins when saving after migration", () => {
    savePinnedSessionIds("team-a", ["s1"]);
    savePinnedSessionIds("team-a", ["s1", "s2"]);
    expect(loadPinnedSessionIds("team-a")).toEqual(["s1", "s2"]);
  });

  it("falls back to __legacy__ when team id is missing", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ __legacy__: ["s0"] }));
    expect(loadPinnedSessionIds(null)).toEqual(["s0"]);
  });
});
