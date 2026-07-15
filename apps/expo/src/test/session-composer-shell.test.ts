import { describe, expect, it } from "vitest";

describe("buildComposerPresentation", () => {
  it("enables send when trimmed text is present", async () => {
    const { buildComposerPresentation } = await import(
      "../features/sessions/components/session-composer-copy"
    );

    expect(
      buildComposerPresentation({
        composerText: " hello ",
        connectionState: "connected",
        isSending: false,
        sendErrorMessage: null,
      }),
    ).toMatchObject({
      canSend: true,
      helperText: null,
      isDisabled: false,
    });
  });

  it("enables send when a pending attachment is present without text", async () => {
    const { buildComposerPresentation } = await import(
      "../features/sessions/components/session-composer-copy"
    );

    expect(
      buildComposerPresentation({
        composerText: "",
        connectionState: "connected",
        isSending: false,
        pendingAttachmentCount: 1,
        sendErrorMessage: null,
      }),
    ).toMatchObject({
      canSend: true,
      isDisabled: false,
    });
  });

  it("shows a disconnected helper when realtime is unavailable", async () => {
    const { buildComposerPresentation } = await import(
      "../features/sessions/components/session-composer-copy"
    );

    expect(
      buildComposerPresentation({
        composerText: "",
        connectionState: "disconnected",
        isSending: false,
        sendErrorMessage: null,
      }),
    ).toMatchObject({
      canSend: false,
      helperText: "实时连接暂时不可用，仍可稍后重试发送。",
      isDisabled: true,
    });
  });

  it("keeps send disabled while realtime is still connecting", async () => {
    const { buildComposerPresentation } = await import(
      "../features/sessions/components/session-composer-copy"
    );

    expect(
      buildComposerPresentation({
        composerText: "hello",
        connectionState: "connecting",
        isSending: false,
        sendErrorMessage: null,
      }),
    ).toMatchObject({
      canSend: false,
      helperText: "正在连接实时通道，连上后就可以发送。",
      isDisabled: true,
    });
  });
});
