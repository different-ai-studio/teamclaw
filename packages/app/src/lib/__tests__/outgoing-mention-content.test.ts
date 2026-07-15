import { describe, expect, it } from "vitest";
import {
  buildHumanMentionChip,
  buildStructuredMentionLines,
  hasStructuredMentionLines,
} from "../outgoing-mention-content";
import { expandMemberMentionTokensInText } from "../member-mention-token";

describe("outgoing-mention-content", () => {
  it("builds agent prefix line only", () => {
    expect(buildStructuredMentionLines({ displayName: "MACPRO" })).toEqual([
      "[Mentioned agents: MACPRO]",
    ]);
    expect(buildStructuredMentionLines(null)).toEqual([]);
  });

  it("builds human mention chip with default English instruction", () => {
    expect(buildHumanMentionChip("Haigang Ye")).toBe(
      "[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye]",
    );
  });

  it("builds human mention chip with custom instruction", () => {
    expect(
      buildHumanMentionChip("Haigang Ye", "这条信息还提及了人类 Haigang Ye"),
    ).toBe(
      "[Mentioned: Haigang Ye|instruction: 这条信息还提及了人类 Haigang Ye]",
    );
  });

  it("detects structured agent mention lines", () => {
    expect(hasStructuredMentionLines("[Mentioned agents: MACPRO]\n\nhi")).toBe(true);
    expect(
      hasStructuredMentionLines(
        "[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye]",
      ),
    ).toBe(false);
  });
});

describe("expandMemberMentionTokensInText", () => {
  it("replaces wire tokens with human mention chips", () => {
    const token = "@{member:m1|Haigang%20Ye}";
    expect(expandMemberMentionTokensInText(`${token} 123`)).toBe(
      "[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye] 123",
    );
  });

  it("uses custom instruction callback when provided", () => {
    const token = "@{member:m1|Haigang%20Ye}";
    expect(
      expandMemberMentionTokensInText(`${token} 123`, {
        humanMentionInstruction: (name) => `提及 ${name}`,
      }),
    ).toBe("[Mentioned: Haigang Ye|instruction: 提及 Haigang Ye] 123");
  });
});
