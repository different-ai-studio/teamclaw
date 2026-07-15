import { adaptTeamclawMessages } from "@/lib/v2-message-adapter";
import type { MessageRow } from "@/lib/local-cache";
import { messageRowsToProto } from "./collect";
import { sanitizeOpenCodeMessages } from "./sanitize";
import { sdkMessageToOpenCode } from "./serialize-opencode";
import type { SessionExportBundle, SessionExportOptions } from "./types";

export type { OpenCodeMessage, SessionExportBundle, SessionExportOptions } from "./types";
export { messageRowsToProto } from "./collect";
export { sanitizeOpenCodeMessages } from "./sanitize";
export { sdkMessageToOpenCode } from "./serialize-opencode";

export function exportSessionFromRows(
  sessionId: string,
  rows: MessageRow[],
  opts: SessionExportOptions = {},
): SessionExportBundle {
  const {
    includeThinking = true,
    includeTools = true,
    sanitize = true,
    includeSystem = true,
  } = opts;

  const protos = messageRowsToProto(rows);
  const sdkMessages = adaptTeamclawMessages(protos) ?? [];

  let messages = sdkMessages
    .filter((msg) => includeSystem || msg.role !== "system")
    .map(sdkMessageToOpenCode);

  if (!includeThinking || !includeTools) {
    messages = messages.map((msg) => ({
      ...msg,
      parts: msg.parts.filter((part) => {
        if (!includeThinking && part.type === "reasoning") return false;
        if (!includeTools && part.type === "tool") return false;
        return true;
      }),
    }));
  }

  if (sanitize) {
    messages = sanitizeOpenCodeMessages(messages);
  }

  return {
    session_id: sessionId,
    exported_at: new Date().toISOString(),
    source: {
      type: "teamclaw_local_cache",
    },
    messages,
  };
}
