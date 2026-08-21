import { t } from "../../../lib/i18n";
import type { SessionDetailConnectionState } from "../session-detail-controller";

export type SessionComposerPresentation = {
  canSend: boolean;
  helperText: string | null;
  isDisabled: boolean;
  placeholder: string;
  sendLabel: string;
};

export function buildComposerPresentation(input: {
  composerText: string;
  connectionState: SessionDetailConnectionState;
  isSending: boolean;
  pendingAttachmentCount?: number;
  sendErrorMessage: string | null;
}): SessionComposerPresentation {
  const trimmed = input.composerText.trim();
  const hasBody = trimmed.length > 0 || (input.pendingAttachmentCount ?? 0) > 0;

  if (input.connectionState === "connecting") {
    return {
      canSend: false,
      helperText: input.sendErrorMessage ?? t("Connecting to realtime. You can send once it is up."),
      isDisabled: true,
      placeholder: t("Connecting to realtime…"),
      sendLabel: input.isSending ? t("Sending…") : t("Send"),
    };
  }

  if (input.connectionState === "disconnected") {
    return {
      canSend: false,
      helperText: input.sendErrorMessage ?? t("Realtime is temporarily unavailable. You can retry sending later."),
      isDisabled: true,
      placeholder: t("Waiting for realtime to recover before sending."),
      sendLabel: input.isSending ? t("Sending…") : t("Send"),
    };
  }

  return {
    canSend: hasBody && !input.isSending,
    helperText: input.sendErrorMessage,
    isDisabled: !hasBody || input.isSending,
    placeholder: t("Send a message to this session"),
    sendLabel: input.isSending ? t("Sending…") : t("Send"),
  };
}
