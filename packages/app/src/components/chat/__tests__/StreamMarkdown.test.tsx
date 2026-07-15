import { describe, expect, it } from "vitest";
import { splitStableBlocks } from "@/components/chat/StreamMarkdown";

describe("splitStableBlocks", () => {
  it("single growing paragraph is all tail", () => {
    expect(splitStableBlocks("hello wor")).toEqual({ stable: [], tail: "hello wor" });
  });

  it("closed paragraphs become stable blocks", () => {
    const r = splitStableBlocks("para1\n\npara2\n\ntail…");
    expect(r.stable).toEqual(["para1", "para2"]);
    expect(r.tail).toBe("tail…");
  });

  it("never splits inside an open code fence", () => {
    const text = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    const r = splitStableBlocks(text);
    expect(r.stable).toEqual(["intro"]);
    expect(r.tail).toBe("```ts\nconst a = 1;\n\nconst b = 2;");
  });

  it("closed fence block becomes stable", () => {
    const text = "```ts\nx\n```\n\nafter";
    const r = splitStableBlocks(text);
    expect(r.stable).toEqual(["```ts\nx\n```"]);
    expect(r.tail).toBe("after");
  });

  it("stable prefix is monotonic as text grows", () => {
    const a = splitStableBlocks("p1\n\np2");
    const b = splitStableBlocks("p1\n\np2 more\n\np3");
    expect(b.stable[0]).toBe(a.stable[0]);
  });

  it("does not split inside a ≤3-space indented code fence", () => {
    const text = "intro\n\n  ```ts\n  const a = 1;\n\n  const b = 2;";
    const r = splitStableBlocks(text);
    expect(r.stable).toEqual(["intro"]);
    expect(r.tail.startsWith("  ```ts")).toBe(true);
  });

  it("empty string", () => {
    expect(splitStableBlocks("")).toEqual({ stable: [], tail: "" });
  });
});
