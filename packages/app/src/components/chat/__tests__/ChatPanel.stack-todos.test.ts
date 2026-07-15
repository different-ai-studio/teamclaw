import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ChatPanel composer stack props", () => {
  it("passes stackTodos alongside stackQueue to ChatInputArea", () => {
    const source = readFileSync(resolve(__dirname, "../ChatPanel.tsx"), "utf8");
    expect(source).toContain(
      "stackTodos={hasComposerPlanData ? (combinedTodos as Todo[]) : []}",
    );
    expect(source).toContain("stackQueue={hasComposerPlanData ? messageQueue : []}");
  });
});
