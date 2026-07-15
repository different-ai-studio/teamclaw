import type { ToolCall } from "@/stores/session-types";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

/** Parse OpenCode task tool rawOutput metadata → child ACP session binding. */
export function extractTaskChildBinding(
  rawOutput: unknown,
): { childAcpSessionId: string; parentAcpSessionId: string } | null {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  const root = rawOutput as Record<string, unknown>;
  const metadata = root.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const meta = metadata as Record<string, unknown>;
  const child =
    typeof meta.sessionId === "string" ? meta.sessionId.trim() : "";
  if (!child) return null;
  const parent =
    typeof meta.parentSessionId === "string"
      ? meta.parentSessionId.trim()
      : "";
  return { childAcpSessionId: child, parentAcpSessionId: parent };
}

/** Task tool renames to human title on in_progress updates — detect by args/id. */
export function isTaskToolCall(toolCall: Pick<ToolCall, "name" | "arguments">): boolean {
  if (toolCall.name === "task") return true;
  const args = toolCall.arguments as {
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
  return Boolean(args?.subagent_type || args?.prompt);
}

export function findCallingTaskToolId(
  sessionId: string,
  actorId: string,
  byKey: Record<string, AgentStreamEntry>,
): string | undefined {
  const entry = byKey[`${sessionId}::${actorId}`];
  if (!entry) return undefined;
  return entry.toolCalls.find(
    (tc) => tc.status === "calling" && isTaskToolCall(tc),
  )?.id;
}

/** Bind child ACP session from permission.params.childSessionId + sourceToolCallId. */
export function tryBindChildFromPermission(
  sessionId: string,
  actorId: string,
  childSessionId: string,
  sourceToolCallId?: string,
): void {
  const trimmedChild = childSessionId.trim();
  const trimmedParent = sourceToolCallId?.trim() ?? "";
  if (!trimmedChild || !trimmedParent) return;
  bindTaskChild(sessionId, actorId, trimmedParent, trimmedChild, "permission");
}

/** Single bind entry — writes map and replays pending events for childSid. */
export function bindTaskChild(
  sessionId: string,
  actorId: string,
  parentToolId: string,
  childAcpSessionId: string,
  _source: "metadata" | "permission",
): void {
  const trimmedChild = childAcpSessionId.trim();
  const trimmedParent = parentToolId.trim();
  if (!trimmedChild || !trimmedParent) return;
  const store = useV2StreamingStore.getState();
  const existingParent = store.childAcpSessionToToolId[trimmedChild];
  if (existingParent && existingParent !== trimmedParent) return;
  store.bindChildAcpSession(sessionId, actorId, trimmedParent, trimmedChild);
}

export function maybeBindTaskChildFromToolUpdate(
  get: () => Pick<
    ReturnType<typeof useV2StreamingStore.getState>,
    "byKey"
  >,
  sessionId: string,
  actorId: string,
  toolId: string,
  toolName: string,
  rawOutput: unknown,
  rawInput?: unknown,
): void {
  const entry = get().byKey[`${sessionId}::${actorId}`];
  const existing = entry?.toolCalls.find((tc) => tc.id === toolId);
  const isTask =
    toolName === "task" ||
    (existing ? isTaskToolCall(existing) : false) ||
    isTaskToolCall({ name: toolName, arguments: (rawInput as Record<string, unknown>) ?? {} });
  if (!isTask) return;

  const binding =
    extractTaskChildBinding(rawOutput) ?? extractTaskChildBinding(rawInput);
  if (!binding) return;
  bindTaskChild(
    sessionId,
    actorId,
    toolId,
    binding.childAcpSessionId,
    "metadata",
  );
}
