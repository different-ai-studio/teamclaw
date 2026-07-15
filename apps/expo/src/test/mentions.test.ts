import { describe, expect, it } from "vitest";

describe("mentionQuery", () => {
  it("returns the partial mention at the end of the text", async () => {
    const { mentionQuery } = await import(
      "../features/sessions/components/mentions"
    );
    expect(mentionQuery("Hey @Mac")).toBe("Mac");
    expect(mentionQuery("@")).toBe("");
    expect(mentionQuery("hi @Macmini")).toBe("Macmini");
  });

  it("returns null when the cursor is not on a mention", async () => {
    const { mentionQuery } = await import(
      "../features/sessions/components/mentions"
    );
    expect(mentionQuery("plain text")).toBeNull();
    expect(mentionQuery("@Macmini hi")).toBeNull();
    expect(mentionQuery("email@example.com")).toBeNull();
  });
});

describe("filterMentionCandidates", () => {
  it("filters by case-insensitive substring", async () => {
    const { filterMentionCandidates } = await import(
      "../features/sessions/components/mentions"
    );
    const pool = [
      { actorId: "a1", displayName: "Macmini" },
      { actorId: "a2", displayName: "Jinliang" },
      { actorId: "a3", displayName: "Matt-iOS" },
    ];
    expect(filterMentionCandidates(pool, "ma")).toEqual([
      { actorId: "a1", displayName: "Macmini" },
      { actorId: "a3", displayName: "Matt-iOS" },
    ]);
  });

  it("caps to five results", async () => {
    const { filterMentionCandidates } = await import(
      "../features/sessions/components/mentions"
    );
    const pool = Array.from({ length: 10 }, (_, i) => ({
      actorId: `a${i}`,
      displayName: `Actor-${i}`,
    }));
    expect(filterMentionCandidates(pool, "actor")).toHaveLength(5);
  });
});

describe("applyMention", () => {
  it("replaces the trailing mention token with the target name + space", async () => {
    const { applyMention } = await import(
      "../features/sessions/components/mentions"
    );
    expect(
      applyMention("Hey @Mac", { actorId: "a1", displayName: "Macmini" }),
    ).toBe("Hey @Macmini ");
  });

  it("returns the input unchanged when no mention is in progress", async () => {
    const { applyMention } = await import(
      "../features/sessions/components/mentions"
    );
    expect(
      applyMention("plain text", { actorId: "a1", displayName: "Macmini" }),
    ).toBe("plain text");
  });
});
