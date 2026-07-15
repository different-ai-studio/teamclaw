import { describe, expect, it } from "vitest";

import { buildThinkingPreview } from "../features/sessions/components/agent-thinking-presentation";

describe("buildThinkingPreview", () => {
  it("uses a working placeholder for punctuation-only thinking", () => {
    expect(buildThinkingPreview(".")).toBe("Working…");
    expect(buildThinkingPreview(" … ")).toBe("Working…");
  });

  it("keeps ordinary thinking text readable", () => {
    expect(buildThinkingPreview("question")).toBe("question");
  });

  it("truncates long thinking text to one compact preview", () => {
    expect(
      buildThinkingPreview(
        "I need to inspect the current session state before deciding how to answer the user.",
        24,
      ),
    ).toBe("I need to inspect the…");
  });
});
