import { describe, it, expect } from "vitest";
import { sanitizeOpenCodeMessages } from "../sanitize";

describe("sanitizeOpenCodeMessages", () => {
  it("removes media parts but keeps text", () => {
    const input = [
      {
        info: { id: "m1", role: "user" },
        parts: [
          { type: "text", text: "keep" },
          { type: "image", data: "data:image/png;base64,AAAA" },
        ],
      },
    ];
    expect(sanitizeOpenCodeMessages(input)).toEqual([
      {
        info: { id: "m1", role: "user" },
        parts: [{ type: "text", text: "keep" }],
      },
    ]);
  });

  it("strips large base64 fields from tool output", () => {
    const input = [
      {
        info: { id: "m1", role: "assistant" },
        parts: [
          {
            type: "tool",
            state: {
              output: {
                text: "keep",
                base64: "A".repeat(600),
              },
            },
          },
        ],
      },
    ];
    const out = sanitizeOpenCodeMessages(input)[0].parts[0] as {
      state: { output: Record<string, unknown> };
    };
    expect(out.state.output.text).toBe("keep");
    expect(out.state.output.base64).toBeUndefined();
  });
});
