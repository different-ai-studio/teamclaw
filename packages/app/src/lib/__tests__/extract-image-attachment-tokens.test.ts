import { describe, expect, it } from "vitest";
import { extractImageAttachmentTokens } from "../extract-image-attachment-tokens";

describe("extractImageAttachmentTokens", () => {
  it("strips image attachment tokens and returns paths", () => {
    const { cleaned, imagePaths } = extractImageAttachmentTokens(
      'see [Attachment: a.png](path: /tmp/a.png) please',
    );
    expect(imagePaths).toEqual(["/tmp/a.png"]);
    expect(cleaned).toContain("see");
    expect(cleaned).toContain("please");
    expect(cleaned).not.toContain("[Attachment:");
  });

  it("leaves non-image attachments alone", () => {
    const src = "[Attachment: note.pdf](path: /tmp/note.pdf)";
    const { cleaned, imagePaths } = extractImageAttachmentTokens(src);
    expect(imagePaths).toEqual([]);
    expect(cleaned).toBe(src);
  });
});
