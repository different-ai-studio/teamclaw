import { describe, expect, it } from "vitest";

import {
  collectSessionAttachmentUrlsFromText,
  encodeSessionAttachmentToken,
  expandSessionAttachmentTokensInText,
  parseSessionAttachmentToken,
  parseSessionAttachmentTokensFromText,
  textHasSessionAttachmentTokens,
} from "@/lib/session-attachment-token";

describe("session-attachment-token", () => {
  const ref = {
    name: "hiclaw-install.log",
    url: "https://example.com/files/hiclaw-install.log",
    isImage: false,
  };

  it("round-trips encode and parse", () => {
    const token = encodeSessionAttachmentToken(ref);
    expect(token.startsWith("@{att:b64:")).toBe(true);
    expect(parseSessionAttachmentToken(token)).toEqual(ref);
  });

  it("expands inline tokens for send", () => {
    const token = encodeSessionAttachmentToken(ref);
    const text = `see ${token} please`;
    expect(expandSessionAttachmentTokensInText(text)).toBe(
      `see [Attachment: hiclaw-install.log] (url: ${ref.url}) please`,
    );
  });

  it("expands image tokens", () => {
    const token = encodeSessionAttachmentToken({
      name: "shot.png",
      url: "https://example.com/shot.png",
      isImage: true,
    });
    expect(expandSessionAttachmentTokensInText(token)).toBe(
      "[Image: shot.png] (url: https://example.com/shot.png)",
    );
  });

  it("collects unique urls from text", () => {
    const token = encodeSessionAttachmentToken(ref);
    const text = `${token} ${token}`;
    expect(parseSessionAttachmentTokensFromText(text)).toHaveLength(1);
    expect(collectSessionAttachmentUrlsFromText(text)).toEqual([ref.url]);
    expect(textHasSessionAttachmentTokens(text)).toBe(true);
    expect(textHasSessionAttachmentTokens("hello")).toBe(false);
  });
});
