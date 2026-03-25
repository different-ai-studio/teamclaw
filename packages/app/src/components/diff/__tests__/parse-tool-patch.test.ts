import { describe, it, expect } from "vitest";
import { tryParseToolPatchForUI } from "../parse-tool-patch";
import { extractPatchTextFromToolArgs } from "@/components/chat/tool-calls/tool-call-utils";

const UNIFIED = `diff --git a/foo/bar.ts b/foo/bar.ts
--- a/foo/bar.ts
+++ b/foo/bar.ts
@@ -1,2 +1,3 @@
 line1
-old
+new
 line2`;

const V4A = `*** Begin Patch
*** Update File: foo/bar.ts
@@
 context
-old line
+new line
*** End Patch`;

describe("tryParseToolPatchForUI", () => {
  it("parses unified diff --git", () => {
    const r = tryParseToolPatchForUI(UNIFIED, "");
    expect(r).not.toBeNull();
    expect(r!.filePath).toContain("bar.ts");
    expect(r!.additions).toBeGreaterThan(0);
    expect(r!.deletions).toBeGreaterThan(0);
    expect(r!.lines.some((l) => l.type === "added")).toBe(true);
  });

  it("parses V4A Begin Patch block", () => {
    const r = tryParseToolPatchForUI(V4A, "");
    expect(r).not.toBeNull();
    expect(r!.filePath).toBe("foo/bar.ts");
    expect(r!.lines.length).toBeGreaterThan(0);
  });
});

describe("extractPatchTextFromToolArgs", () => {
  it("reads patch key", () => {
    expect(extractPatchTextFromToolArgs({ patch: UNIFIED })).toBe(UNIFIED);
  });

  it("finds diff-looking content field", () => {
    expect(
      extractPatchTextFromToolArgs({ content: "*** Begin Patch\n" }),
    ).toContain("Begin Patch");
  });
});
