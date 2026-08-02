import {
  dedupeAgentModelOptions,
  resolveAgentAvailableModels,
  type AgentModelOption,
} from "@/lib/agent-available-models";
import { firstAvailableRecentModel } from "@/lib/local-daemon-model-catalog";
import type { RuntimeInfo } from "@/lib/proto/amux_pb";

function isLocalAgent(
  agentId: string,
  localDaemonActorId: string | null | undefined,
): boolean {
  const id = agentId.trim();
  const localId = localDaemonActorId?.trim() || "";
  return !!id && !!localId && id === localId;
}

/**
 * The model catalog to resolve an agent against.
 *
 * The daemon retain is authoritative but may not have landed (or may not exist
 * at all, right after a restart). For the local agent the loopback catalog
 * answers the same question in one hop. The pill has always done this; the send
 * path did not, so on a cold start it resolved against an empty list — which
 * disables both the id canonicalization and the `available[0]` backstop inside
 * `selectAgentModel`.
 */
export function agentAvailableModelsWithLocalCatalog(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  runtimeInfo: RuntimeInfo | undefined;
  catalogModels: readonly AgentModelOption[] | undefined;
}): AgentModelOption[] {
  const fromRetain = resolveAgentAvailableModels(args.runtimeInfo);
  if (fromRetain.length > 0) return fromRetain;
  return isLocalAgent(args.agentId, args.localDaemonActorId)
    ? dedupeAgentModelOptions(args.catalogModels)
    : [];
}

/**
 * The `providerFallback` slot for `selectAgentModel` — this device's MRU.
 *
 * The pill (AgentSelectorDock) and the send path (ChatPanel) MUST pass the same
 * value here. They used to differ: the pill passed the daemon MRU while send
 * passed the provider store's global `currentModelKey`. That is exactly how a
 * brand-new session came to display one model and run on another — the pill
 * resolved to the MRU, the first outgoing message got stamped with the stale
 * global key, and `resolveSessionEstablishedModel` then froze that wrong answer
 * into the transcript.
 *
 * Local agent only: this device's history says nothing about a remote agent's.
 */
export function localRecentModelFallback(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  recentModels: string[] | undefined;
  available: AgentModelOption[];
}): string {
  if (!isLocalAgent(args.agentId, args.localDaemonActorId)) return "";
  return firstAvailableRecentModel(args.recentModels, args.available);
}
