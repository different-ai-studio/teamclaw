import { describe, expect, it } from "vitest";

import type { MentionTarget } from "../features/sessions/components/mentions";

function member(actorId: string, displayName: string): MentionTarget {
  return { actorId, displayName, kind: "member", subtitle: "Member" };
}

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
      member("a1", "Macmini"),
      member("a2", "Jinliang"),
      member("a3", "Matt-iOS"),
    ];
    expect(filterMentionCandidates(pool, "ma")).toEqual([
      member("a1", "Macmini"),
      member("a3", "Matt-iOS"),
    ]);
  });

  it("caps to five results", async () => {
    const { filterMentionCandidates } = await import(
      "../features/sessions/components/mentions"
    );
    const pool = Array.from({ length: 10 }, (_, i) => member(`a${i}`, `Actor-${i}`));
    expect(filterMentionCandidates(pool, "actor")).toHaveLength(5);
  });
});

describe("applyMention", () => {
  it("replaces the trailing mention token with the target name + space", async () => {
    const { applyMention } = await import(
      "../features/sessions/components/mentions"
    );
    expect(
      applyMention("Hey @Mac", member("a1", "Macmini")),
    ).toBe("Hey @Macmini ");
  });

  it("returns the input unchanged when no mention is in progress", async () => {
    const { applyMention } = await import(
      "../features/sessions/components/mentions"
    );
    expect(
      applyMention("plain text", member("a1", "Macmini")),
    ).toBe("plain text");
  });
});

describe("mention candidate shape", () => {
  it("keeps members and agents distinguishable", async () => {
    // The popup marks members with `@` and agents with a dot, and mentioning an
    // agent routes the turn to a runtime — the two rows must not be
    // interchangeable.
    const { filterMentionCandidates } = await import(
      "../features/sessions/components/mentions"
    );
    const pool: MentionTarget[] = [
      { actorId: "g1", displayName: "claude", kind: "agent", subtitle: "Claude" },
      member("m1", "Jinliang"),
    ];
    const [first, second] = filterMentionCandidates(pool, "");
    expect(first?.kind).toBe("agent");
    expect(first?.subtitle).toBe("Claude");
    expect(second?.kind).toBe("member");
  });

  it("matches on display name regardless of kind", async () => {
    const { filterMentionCandidates } = await import(
      "../features/sessions/components/mentions"
    );
    const pool: MentionTarget[] = [
      { actorId: "g1", displayName: "opencode", kind: "agent", subtitle: "OpenCode" },
      member("m1", "Open Sesame"),
    ];
    expect(filterMentionCandidates(pool, "open").map((t) => t.actorId)).toEqual([
      "g1",
      "m1",
    ]);
  });
});
