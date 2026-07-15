import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import type { AcpPermissionDecision } from "@/lib/teamclaw/reply-acp-permission";

export type StreamingPermissionOption = {
  optionId: string;
  kind: string;
  name: string;
};

/** Map ACP / OpenCode option list from MQTT into the v2 streaming shape. */
export function mapAcpPermissionOptions(
  options: ReadonlyArray<{ optionId?: string; kind?: string; name?: string }> | undefined,
): StreamingPermissionOption[] {
  if (!options?.length) return defaultOpenCodePermissionOptions();
  return options
    .map((o) => ({
      optionId: o.optionId?.trim() ?? "",
      kind: o.kind?.trim() ?? "",
      name: o.name?.trim() ?? "",
    }))
    .filter((o) => o.optionId.length > 0);
}

/** OpenCode ACP agent default option ids (packages/opencode/src/acp/agent.ts). */
export function defaultOpenCodePermissionOptions(): StreamingPermissionOption[] {
  return [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ];
}

export function acpOptionIdForDecision(
  decision: AcpPermissionDecision,
  request: Pick<StreamingPermissionRequest, "options">,
): string | undefined {
  if (decision === "deny") return undefined;
  const options = request.options?.length
    ? request.options
    : defaultOpenCodePermissionOptions();
  if (decision === "always") {
    return (
      options.find((o) => o.kind === "allow_always")?.optionId ??
      options.find((o) => o.optionId === "always")?.optionId ??
      "always"
    );
  }
  return (
    options.find((o) => o.kind === "allow_once")?.optionId ??
    options.find((o) => o.optionId === "once")?.optionId ??
    "once"
  );
}
