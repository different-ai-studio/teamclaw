import { describe, expect, it } from "vitest";
import {
  deriveAgentReplyContent,
  joinTextPartsFromParts,
  stripPriorTranscriptTextPrefix,
} from "@/lib/agent-reply-transcript";

describe("agent reply transcript", () => {
  it("joins multiple text parts for derived content", () => {
    const parts = [
      { type: "text", text: "Intro." },
      { type: "tool-call", toolCall: { id: "t1" } },
      { type: "text", text: "Final?" },
    ];
    expect(joinTextPartsFromParts(parts)).toBe("Intro.\n\nFinal?");
  });

  it("derives content from parts for ef30ac98 sandwich tools", () => {
    const intro =
      "Using brainstorming to design the todo webpage. Let me first explore the project context.";
    const final =
      "这个 todo 网页是要做成一个独立的纯 HTML 文件（可以浏览器直接打开），还是要集成到 TeamClaw 这个项目里作为一个新页面/组件？";
    const parts = [
      { type: "text", text: intro },
      { type: "tool-call", toolCall: { id: "skill" } },
      { type: "tool-call", toolCall: { id: "read" } },
      { type: "text", text: final },
    ];
    const pending = [
      { messageId: "m1", content: intro },
      { messageId: "m2", content: final },
    ] as never;
    const content = deriveAgentReplyContent(parts, pending);
    expect(content).toBe(`${intro}\n\n${final}`);
    expect(content.match(/brainstorming/g)?.length).toBe(1);
  });

  it("strips cumulative prefix before the last tool boundary", () => {
    const intro = "Using brainstorming to design the todo webpage.";
    const parts = [
      { type: "text", text: intro, content: intro },
      { type: "tool-call", toolCall: { id: "t1" } },
    ];
    const cumulative = `${intro}\n\n这个 todo 网页？`;
    expect(stripPriorTranscriptTextPrefix(parts, cumulative)).toBe("这个 todo 网页？");
    expect(stripPriorTranscriptTextPrefix(parts, "这个")).toBe("这个");
  });

  it("preserves leading spaces on incremental post-tool token deltas", () => {
    const intro = "The `issue-normalizer` skill is not available in this environment.";
    const parts = [
      { type: "text", text: intro, content: intro },
      { type: "tool-call", toolCall: { id: "t1" } },
    ];
    expect(stripPriorTranscriptTextPrefix(parts, " J")).toBe(" J");
    expect(stripPriorTranscriptTextPrefix(parts, " page")).toBe(" page");
  });

  it("merges daemon final tail when QoS0 dropped post-tool stream text", () => {
    const intro = "Intro before tools.";
    const final = "Answer after tools.";
    const parts = [
      { type: "text", text: intro },
      { type: "tool-call", toolCall: { id: "t1" } },
    ] as never;
    const pending = [{ messageId: "m1", content: final }] as never;
    expect(deriveAgentReplyContent(parts, pending)).toBe(`${intro}\n\n${final}`);
  });
});
