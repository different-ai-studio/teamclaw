import { getBackend } from "@/lib/backend";
import i18n from "@/lib/i18n";
import { ensureSessionLiveSubscribed, ensureTeamSessionLiveSubscribed } from "@/lib/session-live-subscriptions";
import {
  startAgentRuntimesAsync,
  type RuntimeStartFailure,
  type RuntimeStartFailureCode,
} from "@/lib/session-create";
import { waitForTeamclawRpcReady } from "@/lib/teamclaw-rpc";
import { useActorPresenceStore } from "@/stores/actor-presence-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { resolveRuntimeStateEntryForAgent } from "@/lib/runtime-state-resolve";
import { resolveSessionWorkspaceHintForRuntimeStart } from "@/lib/teamclaw/resolve-runtime-start-workspace";
import { recordRuntimeEnsureAttempt } from "@/lib/teamclaw/runtime-ensure-scheduler";
import {
  DEVICE_PRESENCE_GATE_TIMEOUT_MS,
  RUNTIME_START_RPC_TIMEOUT_MS,
} from "@/lib/teamclaw/runtime-rpc-timeouts";
import { sessionFlowError, sessionFlowLog } from "@/lib/session-flow-log";
import { useWorkspaceStore } from "@/stores/workspace";
import { useMqttReconnectStore } from "@/stores/mqtt-reconnect";

type InFlightEntry = { promise: Promise<void>; startedAt: number };
const inFlight = new Map<string, InFlightEntry>();

export type AgentDevicePresence = "online" | "offline" | "unknown";

/**
 * Resolve whether an agent's daemon is reachable.
 *
 * MQTT retained ActorPresence can arrive slightly after subscribe — `undefined`
 * in actor-presence-store means "not yet known", not offline (see
 * SessionActorSheet computeDotStateAndAnimation). Only explicit `online:
 * false` (LWT) counts as offline. For the local desktop agent, HTTP probe
 * is used as a bootstrap when MQTT retain hasn't landed yet.
 */
export async function resolveAgentDevicePresence(
  agentActorId: string,
  opts?: { timeoutMs?: number },
): Promise<AgentDevicePresence> {
  const timeoutMs = opts?.timeoutMs ?? DEVICE_PRESENCE_GATE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entry = useActorPresenceStore.getState().byActorId[agentActorId];
    if (entry?.online === true) return "online";
    if (entry?.online === false) return "offline";
    await new Promise((r) => setTimeout(r, 100));
  }

  const entry = useActorPresenceStore.getState().byActorId[agentActorId];
  if (entry?.online === true) return "online";
  if (entry?.online === false) return "offline";

  const { isTauri } = await import("@/lib/utils");
  if (isTauri()) {
    const { getLocalDaemonActorId } = await import("@/lib/daemon-agent-admin");
    const { probeDaemonHttp } = await import("@/lib/daemon-local-client");
    const localId = await getLocalDaemonActorId();
    if (localId === agentActorId) {
      const probe = await probeDaemonHttp();
      // HTTP probe failure during bootstrap is not authoritative offline — MQTT
      // retain may still be in flight.
      return probe.ok ? "online" : "unknown";
    }
  }

  return "unknown";
}

function logDebug(
  eventCase: string,
  payload: unknown,
  opts?: { sessionId?: string; topic?: string; actorId?: string },
): void {
  void import("@/stores/acp-debug-store").then(({ useAcpDebugStore }) => {
    useAcpDebugStore.getState().append({
      sessionId: opts?.sessionId ?? "",
      topic: opts?.topic ?? "(client)",
      actorId: opts?.actorId ?? "",
      eventCase,
      payload,
    });
  });
}

async function ensureAgentIsSessionParticipant(sessionId: string, agentActorId: string): Promise<void> {
  const participants = await getBackend().sessionMembers.listParticipants(sessionId);
  if (participants.some((p) => p.id === agentActorId)) return;
  await getBackend().sessionMembers.addParticipant(sessionId, agentActorId);
  sessionFlowLog("ensure_agent_runtime.participant_added", { sessionId, agentActorId });
  logDebug("client:participant_added", { sessionId, agentActorId }, { sessionId, actorId: agentActorId });
}

function failureDescription(failure: RuntimeStartFailure): string {
  const shortId = failure.agentActorId.slice(0, 8);
  const trimmed = failure.reason.trim();
  switch (failure.code) {
    case "device_offline":
      return i18n.t("daemon.agentRuntime.deviceOfflineDesc", { shortId });
    case "transport_offline":
      return i18n.t("daemon.agentRuntime.transportOfflineDesc");
    case "workspace_rpc_timeout":
      return trimmed || i18n.t("daemon.agentRuntime.workspaceRpcTimeoutDesc", { shortId });
    case "workspace_ensure_failed":
      return trimmed || i18n.t("daemon.agentRuntime.workspaceEnsureFailedDesc", { shortId });
    case "runtime_rejected":
      return trimmed || i18n.t("daemon.agentRuntime.notStartedDesc", { shortId });
    case "runtime_rpc_failed":
      return trimmed || i18n.t("daemon.agentRuntime.notStartedDesc", { shortId });
    default:
      return trimmed || i18n.t("daemon.agentRuntime.notStartedDesc", { shortId });
  }
}

function notifyRuntimeStartFailures(failures: RuntimeStartFailure[]): void {
  if (failures.length === 0) return;
  void import("sonner").then(({ toast }) => {
    for (const failure of failures) {
      toast.error(i18n.t("daemon.agentRuntime.notStartedTitle"), {
        id: `runtime-start-failed-${failure.agentActorId}`,
        description: failureDescription(failure),
        duration: 8000,
      });
      logDebug(
        "client:runtime_start_failed",
        failure,
        { actorId: failure.agentActorId },
      );
    }
  });
}

async function gateAgentsForRuntimeStart(
  agentActorIds: string[],
): Promise<{ eligible: string[]; failures: RuntimeStartFailure[] }> {
  const failures: RuntimeStartFailure[] = [];
  const eligible: string[] = [];

  for (const agentActorId of agentActorIds) {
    const presence = await resolveAgentDevicePresence(agentActorId, {
      timeoutMs: DEVICE_PRESENCE_GATE_TIMEOUT_MS,
    });
    if (presence === "offline") {
      failures.push({
        agentActorId,
        code: "device_offline",
        reason: "device offline",
      });
      continue;
    }
    eligible.push(agentActorId);
  }

  return { eligible, failures };
}

export type EnsureAgentRuntimeArgs = {
  sessionId: string;
  teamId: string;
  agentActorIds: string[];
  modelId?: string;
  modelIdByAgent?: Record<string, string>;
  /** Cloud workspace UUID captured at send time — passed through to runtimeStart. */
  workspaceIdHint?: string;
  reason?: string;
};

/**
 * Idempotent: ensure session live subscription, session membership, and
 * daemon runtimeStart for each agent. Safe to call on @-mention and on send.
 *
 * TODO(perf-runtime-start-throttle): Opening or re-activating a session often
 * fires runtimeStart even when the daemon dedup-reuses an existing runtime.
 * That path still does Cloud session fetch, MQTT live unsub/sub on switch, and
 * full-history `reconcile_runtime_cursor` (see `apply_start_runtime` dedup in
 * amuxd). Consider client-side TTL dedupe by (sessionId, workspace, agentIds)
 * and a daemon fast path that skips full reconcile/catchup when already live.
 *
 * Do NOT implement this TODO unless the user explicitly requests it — ignore
 * during routine work. 无用户明确指令时不要实现本 TODO，日常开发请忽略。
 */
export async function ensureAgentRuntimesForSession(args: EnsureAgentRuntimeArgs): Promise<void> {
  const agentActorIds = [...new Set(args.agentActorIds.map((id) => id.trim()).filter(Boolean))];
  if (!args.sessionId || !args.teamId || agentActorIds.length === 0) return;

  const key = `${args.sessionId}::${agentActorIds.slice().sort().join(",")}`;
  const reason = args.reason ?? "unknown";
  const existing = inFlight.get(key);
  if (existing) return existing.promise;

  const work = (async () => {
    logDebug(
      "client:ensure_runtime_begin",
      { reason, agentActorIds, teamId: args.teamId },
      { sessionId: args.sessionId, topic: `ensure/${args.sessionId}` },
    );

    try {
      const mqttConnected = useMqttReconnectStore.getState().connected;
      if (mqttConnected === false) {
        const transportFailures: RuntimeStartFailure[] = agentActorIds.map((agentActorId) => ({
          agentActorId,
          code: "transport_offline" as RuntimeStartFailureCode,
          reason: "mqtt disconnected",
        }));
        notifyRuntimeStartFailures(transportFailures);
        logDebug("client:transport_offline", { mqttConnected }, { sessionId: args.sessionId });
        return;
      }

      await ensureTeamSessionLiveSubscribed(args.teamId);
      await ensureSessionLiveSubscribed(args.teamId, args.sessionId);
    } catch (error) {
      sessionFlowError("ensure_agent_runtime.live_subscribe_failed", error, args);
      logDebug("client:live_subscribe_failed", { error: String(error) }, { sessionId: args.sessionId });
    }

    const rpcReady = await waitForTeamclawRpcReady(20_000);
    if (!rpcReady) {
      logDebug("client:rpc_not_ready", { waitedMs: 20_000 }, { sessionId: args.sessionId });
      void import("sonner").then(({ toast }) => {
        toast.error(i18n.t("daemon.agentRuntime.rpcNotReadyTitle"), {
          description: i18n.t("daemon.agentRuntime.rpcNotReadyDesc"),
        });
      });
      return;
    }

    const { eligible, failures: gateFailures } = await gateAgentsForRuntimeStart(agentActorIds);
    if (gateFailures.length > 0) {
      notifyRuntimeStartFailures(gateFailures);
    }
    if (eligible.length === 0) {
      logDebug("client:ensure_runtime_all_gated", { gateFailures }, { sessionId: args.sessionId });
      return;
    }

    await Promise.all(
      eligible.map(async (agentActorId) => {
        try {
          await ensureAgentIsSessionParticipant(args.sessionId, agentActorId);
        } catch (error) {
          sessionFlowError("ensure_agent_runtime.add_participant_failed", error, {
            sessionId: args.sessionId,
            agentActorId,
          });
          logDebug("client:add_participant_failed", { agentActorId, error: String(error) }, {
            sessionId: args.sessionId,
            actorId: agentActorId,
          });
        }
      }),
    );

    const localWorkspacePath = useWorkspaceStore.getState().workspacePath?.trim() || null
    let localDaemonActorId: string | null = null
    const { isTauri } = await import("@/lib/utils")
    if (isTauri()) {
      try {
        const { getLocalDaemonActorId } = await import("@/lib/daemon-agent-admin")
        localDaemonActorId = await getLocalDaemonActorId()
      } catch {
        localDaemonActorId = null
      }
    }
    const workspaceIdHint =
      args.workspaceIdHint?.trim() ||
      (await resolveSessionWorkspaceHintForRuntimeStart({
        teamId: args.teamId,
        localWorkspacePath,
        sessionId: args.sessionId,
        agentActorIds: eligible,
        localDaemonActorId,
      })) ||
      undefined

    recordRuntimeEnsureAttempt(args.sessionId, eligible);

    logDebug(
      "client:runtime_start_batch",
      {
        agentActorIds: eligible,
        modelId: args.modelId ?? null,
        workspaceIdHint: workspaceIdHint ?? null,
        localWorkspacePath,
      },
      { sessionId: args.sessionId, topic: `rpc/runtimeStart/${args.sessionId}` },
    );
    sessionFlowLog("ensure_agent_runtime.workspace_resolved", {
      sessionId: args.sessionId,
      teamId: args.teamId,
      reason,
      workspaceIdHint: workspaceIdHint ?? null,
      localWorkspacePath,
    });

    const runtimeFailures = await startAgentRuntimesAsync({
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: eligible,
      modelId: args.modelId,
      modelIdByAgent: args.modelIdByAgent,
      workspaceIdHint,
      rpcTimeoutMs: RUNTIME_START_RPC_TIMEOUT_MS,
      suppressWorkspaceToast: true,
    });
    notifyRuntimeStartFailures(runtimeFailures);

    const retainDeadline = Date.now() + 12_000;
    while (Date.now() < retainDeadline) {
      const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
      const missing = eligible.filter((id) => {
        const entry = resolveRuntimeStateEntryForAgent(id, byRuntimeId);
        return !entry || entry.info.availableModels.length === 0;
      });
      if (missing.length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const agentActorId of eligible) {
      const entry = resolveRuntimeStateEntryForAgent(
        agentActorId,
        useRuntimeStateStore.getState().byRuntimeId,
      );
      logDebug(
        entry ? "client:runtime_state_observed" : "client:runtime_state_missing",
        entry
          ? {
              agentActorId,
              runtimeId: entry.info.runtimeId,
              agentType: entry.info.agentType,
              availableModelIds: entry.info.availableModels.map((m) => m.id),
            }
          : { agentActorId, waitedMs: 12_000 },
        { sessionId: args.sessionId, actorId: agentActorId },
      );
    }

    logDebug(
      "client:runtime_start_batch_done",
      { agentActorIds: eligible },
      { sessionId: args.sessionId, topic: `rpc/runtimeStart/${args.sessionId}` },
    );
  })().catch((error) => {
    sessionFlowError("ensure_agent_runtime.failed", error, args);
    logDebug("client:ensure_runtime_failed", { error: String(error) }, { sessionId: args.sessionId });
    void import("sonner").then(({ toast }) => {
      toast.error(i18n.t("daemon.agentRuntime.startFailedTitle"), {
        description: error instanceof Error ? error.message : String(error),
      });
    });
    throw error;
  });

  const entry: InFlightEntry = { promise: work, startedAt: Date.now() };
  inFlight.set(key, entry);
  try {
    await work;
  } finally {
    if (inFlight.get(key) === entry) {
      inFlight.delete(key);
    }
  }
}
