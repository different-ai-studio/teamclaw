import { describe, expect, it } from "vitest";
import {
  parseToolContentBlocks,
  resolveToolCallDiff,
} from "@/components/chat/tool-calls/tool-call-content";
import type { ToolCall } from "@/stores/session-types";

describe("parseToolContentBlocks", () => {
  it("parses persisted metadata diff blocks", () => {
    const blocks = parseToolContentBlocks([
      {
        type: "diff",
        path: "src/a.ts",
        old_text: "old\n",
        new_text: "new\n",
      },
    ]);
    expect(blocks).toEqual([
      {
        type: "diff",
        diff: { path: "src/a.ts", oldText: "old\n", newText: "new\n" },
      },
    ]);
  });

  it("parses wire proto oneof payload blocks", () => {
    const blocks = parseToolContentBlocks({
      content: [
        {
          payload: {
            case: "diff",
            value: { path: "b.ts", oldText: "a", newText: "b" },
          },
        },
      ],
    });
    expect(blocks[0]?.type).toBe("diff");
  });
});

describe("resolveToolCallDiff", () => {
  it("prefers ACP content diff over arguments", () => {
    const toolCall: ToolCall = {
      id: "t1",
      name: "write",
      status: "completed",
      arguments: {
        old_string: "ignored",
        new_string: "ignored",
      },
      startTime: new Date(),
      content: [
        {
          type: "diff",
          diff: { path: "src/main.ts", oldText: "a", newText: "ab" },
        },
      ],
    };
    const view = resolveToolCallDiff(toolCall);
    expect(view?.headerPath).toBe("src/main.ts");
    expect(view?.additions).toBeGreaterThan(0);
  });
});
