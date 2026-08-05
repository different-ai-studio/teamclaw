import {
  dedupeAgentModelOptions,
  resolveAgentAvailableModels,
  type AgentModelOption,
} from "@/lib/agent-available-models";
import { firstAvailableRecentModel } from "@/lib/local-daemon-model-catalog";
import type { RuntimeInfo } from "@/lib/proto/amux_pb";
import {
  resolveSessionAttachmentEntry,
  type RuntimeStateEntry,
} from "@/stores/runtime-state-store";

export function isLocalDaemonAgent(
  agentId: string,
  localDaemonActorId: string | null | undefined,
): boolean {
  const id = agentId.trim();
  const localId = localDaemonActorId?.trim() || "";
  return !!id && !!localId && id === localId;
}

/** Draft / pre-attachment: no session yet, or session exists but no attachment retain. */
export function usesDraftCatalogContext(
  agentId: string,
  sessionId: string | null | undefined,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): boolean {
  const trimmedAgent = agentId.trim();
  const sid = sessionId?.trim() ?? "";
  if (!trimmedAgent) return true;
  if (!sid) return true;
  return !resolveSessionAttachmentEntry(trimmedAgent, sid, byRuntimeId);
}

/**
 * Model catalog for the agent pill and send path.
 *
 * Draft (no attachment): local agent → selected workspace loopback catalog;
 * remote agent → daemon-published default workspace catalog on `{actor}/state`.
 *
 * Attached session: retain first, loopback supplement for the local agent only.
 */
export function resolveAgentCatalogModels(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  sessionId: string | null | undefined;
  byRuntimeId: Record<string, RuntimeStateEntry>;
  runtimeInfo: RuntimeInfo | undefined;
  localWorkspaceCatalogModels: readonly AgentModelOption[] | undefined;
  remoteDefaultCatalogModels: readonly AgentModelOption[] | undefined;
}): AgentModelOption[] {
  if (
    usesDraftCatalogContext(args.agentId, args.sessionId, args.byRuntimeId)
  ) {
    if (isLocalDaemonAgent(args.agentId, args.localDaemonActorId)) {
      return dedupeAgentModelOptions(args.localWorkspaceCatalogModels);
    }
    return dedupeAgentModelOptions(args.remoteDefaultCatalogModels);
  }
  return agentAvailableModelsWithLocalCatalog({
    agentId: args.agentId,
    localDaemonActorId: args.localDaemonActorId,
    runtimeInfo: args.runtimeInfo,
    catalogModels: args.localWorkspaceCatalogModels,
  });
}

/**
 * The model catalog to resolve an agent against once a session attachment exists.
 *
 * The daemon retain is authoritative but may not have landed (or may not exist
 * at all, right after a restart). For the local agent the loopback catalog
 * answers the same question in one hop.
 */
export function agentAvailableModelsWithLocalCatalog(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  runtimeInfo: RuntimeInfo | undefined;
  catalogModels: readonly AgentModelOption[] | undefined;
}): AgentModelOption[] {
  const fromRetain = resolveAgentAvailableModels(args.runtimeInfo);
  if (fromRetain.length > 0) return fromRetain;
  return isLocalDaemonAgent(args.agentId, args.localDaemonActorId)
    ? dedupeAgentModelOptions(args.catalogModels)
    : [];
}

/**
 * The `providerFallback` slot for `selectAgentModel` — this device's MRU.
 *
 * Local agent only: this device's history says nothing about a remote agent's.
 */
export function localRecentModelFallback(args: {
  agentId: string;
  localDaemonActorId: string | null | undefined;
  recentModels: string[] | undefined;
  available: AgentModelOption[];
}): string {
  if (!isLocalDaemonAgent(args.agentId, args.localDaemonActorId)) return "";
  return firstAvailableRecentModel(args.recentModels, args.available);
}
