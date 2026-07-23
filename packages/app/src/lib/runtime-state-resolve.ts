import { AgentType, RuntimeLifecycle } from "@/lib/proto/amux_pb";
import {
  useRuntimeStateStore,
  type RuntimeStateEntry,
} from "@/stores/runtime-state-store";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";

/**
 * Canonical agent / runtime identity glossary (read before touching this file):
 *
 *   agentActorId   — UUID. The agent's team `actor_id`. Stable forever.
 *                    Used in: @-mentions, RPC `targetActorId`, MQTT topic
 *                    `amux/{team}/{X}/...`, pick store keys.
 *                    By current daemon convention, daemonActorId == agentActorId.
 *
 *   runtimeSpawnId — 8-char hex. Assigned by `RuntimeManager` per spawn.
 *                    Used in: `setModel.runtimeId`, `runtimeStop.runtimeId`,
 *                    MQTT topic `runtime/{X}/state`.
 *                    Throwaway — different on every spawn.
 *
 *   dbRuntimeId    — same shape as runtimeSpawnId, persisted in `agent_runtimes`.
 *                    Often stale; treat as a hint, not as truth.
 *
 *   modelId        — May appear as a short form (`big-pickle`) OR fully
 *                    qualified ACP id (`opencode/big-pickle`). Always
 *                    canonicalize via `normalizeAgentModelId` before
 *                    sending to RPC or comparing for equality.
 */

function considerRuntimeEntry(
  best: RuntimeStateEntry | undefined,
  candidate: RuntimeStateEntry | undefined,
): RuntimeStateEntry | undefined {
  if (!candidate) return best;
  if (!best || candidate.lastUpdated > best.lastUpdated) return candidate;
  return best;
}

/** Match a live MQTT RuntimeInfo retain to an agent actor id. */
export function resolveRuntimeStateEntryForAgent(
  agentId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  dbRuntimeId?: string | null,
): RuntimeStateEntry | undefined {
  const trimmedAgent = agentId.trim();
  if (!trimmedAgent) return undefined;

  // When the caller knows the session's own runtime id, that runtime is
  // authoritative — return it directly. An agent (e.g. the local daemon) runs a
  // separate runtime per session, and those runtimes can differ in backend and
  // model catalog (a stale opencode session vs. a fresh pi one). Picking "most
  // recently updated across all the agent's runtimes" would surface a DIFFERENT
  // session's models here, so a concrete session hint must win outright.
  const dbId = dbRuntimeId?.trim() ?? "";
  if (dbId) {
    const hinted = byRuntimeId[dbId];
    if (
      hinted &&
      (hinted.daemonActorId === trimmedAgent ||
        hinted.info.runtimeId === trimmedAgent ||
        hinted.info.runtimeId === dbId)
    ) {
      return hinted;
    }
  }

  // No session hint (or it hasn't been observed yet): fall back to the most
  // recently updated runtime for this agent.
  let best: RuntimeStateEntry | undefined;
  best = considerRuntimeEntry(best, byRuntimeId[trimmedAgent]);
  for (const entry of Object.values(byRuntimeId)) {
    if (entry.daemonActorId !== trimmedAgent && entry.info.runtimeId !== trimmedAgent) continue;
    best = considerRuntimeEntry(best, entry);
  }

  return best;
}

function collectSessionRuntimeIds(
  rows: ReadonlyArray<{ runtime_id: string | null }>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.runtime_id?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function isRuntimeLifecycleLive(state: RuntimeLifecycle | undefined): boolean {
  return state !== RuntimeLifecycle.STOPPED && state !== RuntimeLifecycle.FAILED;
}

function findLiveRuntimeIdForAgent(
  agentId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): string | undefined {
  let best: RuntimeStateEntry | undefined;
  for (const entry of Object.values(byRuntimeId)) {
    if (entry.daemonActorId !== agentId && entry.info.runtimeId !== agentId) continue;
    if (!isRuntimeLifecycleLive(entry.info.state)) continue;
    best = considerRuntimeEntry(best, entry);
  }
  const id = best?.info.runtimeId?.trim();
  return id || undefined;
}

function isDbRuntimeHintLive(
  dbRuntimeId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): boolean {
  if (!dbRuntimeId) return false;
  const retain = byRuntimeId[dbRuntimeId];
  if (!retain) return true;
  return isRuntimeLifecycleLive(retain.info.state);
}

/**
 * Resolve the spawn id for RPC/MQTT commands (cancel, permission, setModel).
 *
 * Priority:
 * 1. Live MQTT retain (state not Stopped/Failed) when session-safe
 * 2. DB hint from agent_runtimes (session-scoped, latest per agent)
 * 3. Any live MQTT retain for the agent
 */
export function resolveCommandRuntimeId(args: {
  agentId: string;
  dbRuntimeId?: string | null;
  byRuntimeId: Record<string, RuntimeStateEntry>;
  sessionRuntimeIds?: ReadonlySet<string>;
}): string | undefined {
  const trimmedAgent = args.agentId.trim();
  if (!trimmedAgent) return undefined;

  const dbId = args.dbRuntimeId?.trim() ?? "";
  const mqttEntry = resolveRuntimeStateEntryForAgent(
    trimmedAgent,
    args.byRuntimeId,
    dbId || null,
  );
  const mqttRuntimeId = mqttEntry?.info.runtimeId?.trim() ?? "";
  const mqttLive = !!mqttEntry && isRuntimeLifecycleLive(mqttEntry.info.state);

  const sessionIds = args.sessionRuntimeIds;
  const sessionSafe =
    !mqttRuntimeId ||
    (sessionIds && sessionIds.size > 0
      ? sessionIds.has(mqttRuntimeId)
      : !dbId || mqttRuntimeId === dbId || (mqttLive && !!mqttEntry));

  const dbHintDead =
    !!dbId && !isDbRuntimeHintLive(dbId, args.byRuntimeId);

  if (dbHintDead) {
    const liveRuntimeId = findLiveRuntimeIdForAgent(trimmedAgent, args.byRuntimeId);
    if (liveRuntimeId) return liveRuntimeId;
    if (mqttLive && mqttRuntimeId) return mqttRuntimeId;
    return undefined;
  }

  if (mqttLive && sessionSafe && mqttRuntimeId && mqttRuntimeId !== dbId) {
    return mqttRuntimeId;
  }

  // DB hint and the chosen mqtt entry can agree on a stale spawn id (both still
  // marked ACTIVE in the local cache). Prefer any other live retain for this
  // agent, but only on the session-agnostic path (setModel from the agent pill).
  // Permission/cancel targets pass sessionRuntimeIds and must not hop sessions.
  if (!sessionIds || sessionIds.size === 0) {
    const liveSpawnId = findLiveRuntimeIdForAgent(trimmedAgent, args.byRuntimeId);
    if (liveSpawnId && liveSpawnId !== dbId) {
      return liveSpawnId;
    }
  }

  if (dbId) return dbId;

  if (mqttLive && mqttRuntimeId && sessionSafe) return mqttRuntimeId;
  return undefined;
}

export type PermissionCommandTarget = {
  actorId: string;
  runtimeId: string;
};

/**
 * Resolve MQTT grant/deny/cancel command target for an in-session agent.
 * Merges session-scoped DB hints with live MQTT retains; stale Stopped
 * retains never override a session-bound row.
 */
export function resolvePermissionCommandTarget(args: {
  agentActorId: string;
  sessionRuntimeRows: ReadonlyArray<{
    agent_id: string | null;
    runtime_id: string | null;
  }>;
  byRuntimeId?: Record<string, RuntimeStateEntry>;
}): PermissionCommandTarget | null {
  const trimmedAgent = args.agentActorId.trim();
  if (!trimmedAgent) return null;
  const byRuntimeId = args.byRuntimeId ?? useRuntimeStateStore.getState().byRuntimeId;
  const sessionRuntimeIds = collectSessionRuntimeIds(args.sessionRuntimeRows);

  const sessionRow = args.sessionRuntimeRows.find(
    (row) => row.agent_id?.trim() === trimmedAgent && row.runtime_id?.trim(),
  );
  const runtimeId = resolveCommandRuntimeId({
    agentId: trimmedAgent,
    dbRuntimeId: sessionRow?.runtime_id,
    byRuntimeId,
    sessionRuntimeIds,
  });

  if (runtimeId) {
    return { actorId: trimmedAgent, runtimeId };
  }

  return null;
}

/** Short id for ACP ids (`opencode/foo` → `foo`). */
export function shortAgentModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Whether a dropdown row is the selected model.
 * Uses exact id equality only — `selectAgentModel` already canonicalizes
 * retain/pick to one `availableModels[i].id`.
 */
export function isAgentModelRowSelected(
  rowId: string,
  effectiveModelId: string,
): boolean {
  const left = rowId.trim();
  const right = effectiveModelId.trim();
  return left.length > 0 && right.length > 0 && left === right;
}

/** Whether two model ids refer to the same advertised runtime model. */
export function agentModelIdsMatch(
  a: string | undefined | null,
  b: string | undefined | null,
  available: Array<{ id: string }> = [],
): boolean {
  const left = a?.trim() ?? "";
  const right = b?.trim() ?? "";
  if (!left || !right) return false;
  if (left === right) return true;
  if (shortAgentModelId(left) === shortAgentModelId(right)) return true;
  for (const model of available) {
    const ids = new Set([model.id, shortAgentModelId(model.id)]);
    if (ids.has(left) && ids.has(right)) return true;
  }
  return false;
}

type AgentModelOption = { id: string; displayName: string };

export function agentModelDisplayLabel(
  modelId: string,
  available: AgentModelOption[],
): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const exact = available.find((m) => m.id === trimmed);
  if (exact) return exact.displayName || exact.id;
  const match = available.find((m) =>
    agentModelIdsMatch(m.id, trimmed, available),
  );
  if (match) return match.displayName || match.id;
  // Catalog not loaded (or unknown id): show the model part, not the raw
  // `provider/model` id ("anthropic/claude-haiku-4-5-20251001" → the pill
  // should still read like a model name).
  return shortAgentModelId(trimmed);
}

/** Runtime id for RPC/commands — prefer live retain, fall back to DB hint. */
export function resolveRuntimeIdForAgent(
  agentId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  dbRuntimeId?: string | null,
  sessionRuntimeIds?: ReadonlySet<string>,
): string | undefined {
  return resolveCommandRuntimeId({
    agentId,
    dbRuntimeId,
    byRuntimeId,
    sessionRuntimeIds,
  });
}

/**
 * Map any model id (short, prefixed, or pick-store form) onto the exact id
 * the agent's `availableModels` advertises. Returns the input unchanged when
 * no advertised list is available yet (caller will retry once retain lands).
 */
export function normalizeAgentModelId(
  agentId: string,
  modelId: string | undefined | null,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): string | undefined {
  const raw = modelId?.trim();
  if (!raw) return undefined;

  const entry = resolveRuntimeStateEntryForAgent(agentId, byRuntimeId);
  const available = entry?.info.availableModels ?? [];
  if (available.some((m) => m.id === raw)) return raw;

  const suffixMatch = available.find(
    (m) => m.id === raw || m.id.endsWith(`/${raw}`),
  );
  if (suffixMatch) return suffixMatch.id;

  for (const prefix of ["opencode/", "alibaba-cn/", "claude-code/"]) {
    const candidate = `${prefix}${raw}`;
    if (available.some((m) => m.id === candidate)) return candidate;
  }

  return raw;
}

/** Pick the short or fully-qualified form depending on what the runtime advertises. */
export function resolveSetModelId(
  agentId: string,
  modelId: string,
  byRuntimeId: Record<string, RuntimeStateEntry>,
): string {
  const normalized =
    normalizeAgentModelId(agentId, modelId, byRuntimeId) ?? modelId.trim();
  const entry = resolveRuntimeStateEntryForAgent(agentId, byRuntimeId);
  const available = entry?.info.availableModels ?? [];
  if (available.length === 0) return normalized;

  if (available.some((m) => m.id === normalized)) return normalized;

  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) {
    const shortId = normalized.slice(slash + 1);
    if (available.some((m) => m.id === shortId)) return shortId;
  }
  return normalized;
}

// ────────────────────────────────────────────────────────────────────────────
// THE canonical model resolver — used by pill display, send pipeline, and
// every place that needs to answer "which model should this agent run?".
// ────────────────────────────────────────────────────────────────────────────

/** Wire format stored in provider store and sent to the daemon (`provider/model`). */
export function formatProviderModelKey(
  provider: string,
  modelId: string,
): string {
  const p = provider.trim();
  const m = modelId.trim();
  if (!p || !m) return m || p;
  return `${p}/${m}`;
}

export function providerModelKeyFromOption(
  option: { provider: string; id: string } | null | undefined,
): string {
  if (!option) return "";
  return formatProviderModelKey(option.provider, option.id);
}

export type AgentModelSource = "pick" | "retain" | "fallback" | "none";

export interface SelectedAgentModel {
  /** Canonical model id (matches `availableModels[i].id` when the list is known). */
  modelId: string;
  /** Where the answer came from. Useful for diagnostics and UI hints. */
  source: AgentModelSource;
}

/**
 * Single resolver for "which model is selected for this agent in this session".
 *
 * Priority: user pick → daemon retain → provider fallback → empty.
 *
 * The user pick ALWAYS wins. MQTT retain updates do not, cannot, and must not
 * silently override it. The only way to lose a pick is for the user to pick
 * something else (or call `clearPick` when removing the agent).
 */
export function selectAgentModel(args: {
  sessionId: string | null | undefined;
  agentId: string;
  available: AgentModelOption[];
  byRuntimeId: Record<string, RuntimeStateEntry>;
  providerFallback?: string;
  /**
   * The model this session has ALREADY run with, taken from its transcript
   * (e.g. a cron job that pinned a model, or any continued conversation). When
   * set, it wins over the cross-session `lastPick` heuristic so an existing
   * session's pill reflects the model it actually used — but brand-new sessions
   * (no transcript, no established model) still default to `lastPick`.
   */
  sessionEstablishedModel?: string | null;
}): SelectedAgentModel {
  const sessionId = args.sessionId?.trim() ?? "";
  const agentId = args.agentId.trim();
  if (!agentId) return { modelId: "", source: "none" };

  const pick = sessionId
    ? useAgentModelPickStore.getState().getPick(sessionId, agentId)
    : undefined;
  if (pick) {
    return {
      modelId: canonicalizeAgainstAvailable(
        args.agentId,
        pick,
        args.available,
        args.byRuntimeId,
      ),
      source: "pick",
    };
  }

  // A session that has already run carries its real model in the transcript;
  // that truth beats the cross-session `lastPick` default below.
  const established = args.sessionEstablishedModel?.trim();
  if (established) {
    return {
      modelId: canonicalizeAgainstAvailable(
        args.agentId,
        established,
        args.available,
        args.byRuntimeId,
      ),
      source: "retain",
    };
  }

  const entry = resolveRuntimeStateEntryForAgent(agentId, args.byRuntimeId);
  const retain = entry?.info.currentModel?.trim() ?? "";
  if (retain) {
    return {
      modelId: canonicalizeAgainstAvailable(
        args.agentId,
        retain,
        args.available,
        args.byRuntimeId,
      ),
      source: "retain",
    };
  }

  // No pick, no transcript, no live retain — a brand-new session. Default to
  // the user's most recent pick for this agent ("上次选的模型") instead of
  // the daemon's default model. Kept strictly last among user-ish signals:
  // letting it beat retain made session-switching flash another session's
  // model while this session's transcript was still loading.
  const lastPick = useAgentModelPickStore.getState().getLastPick(agentId);
  if (lastPick) {
    return {
      modelId: canonicalizeAgainstAvailable(
        args.agentId,
        lastPick,
        args.available,
        args.byRuntimeId,
      ),
      source: "pick",
    };
  }

  const fallback = args.providerFallback?.trim() ?? "";
  if (fallback) {
    return {
      modelId: canonicalizeAgainstAvailable(
        args.agentId,
        fallback,
        args.available,
        args.byRuntimeId,
      ),
      source: "fallback",
    };
  }

  return { modelId: "", source: "none" };
}

function canonicalizeAgainstAvailable(
  agentId: string,
  raw: string,
  available: AgentModelOption[],
  byRuntimeId: Record<string, RuntimeStateEntry>,
): string {
  const exact = available.find((m) => m.id === raw);
  if (exact) return exact.id;
  const normalized = normalizeAgentModelId(agentId, raw, byRuntimeId) ?? raw;
  const normalizedExact = available.find((m) => m.id === normalized);
  if (normalizedExact) return normalizedExact.id;
  const match = available.find((m) =>
    agentModelIdsMatch(m.id, normalized, available),
  );
  return match?.id ?? normalized;
}

export function backendTypeFromRuntimeEntry(
  entry: RuntimeStateEntry | undefined,
  fallback?: string | null,
): string | undefined {
  const explicit = fallback?.trim();
  if (explicit) return explicit;
  if (!entry) return undefined;
  switch (entry.info.agentType) {
    case AgentType.CLAUDE_CODE:
      return "claude-code";
    case AgentType.OPENCODE:
      return "opencode";
    case AgentType.CODEX:
      return "codex";
    case AgentType.PI:
      return "pi";
    default:
      return undefined;
  }
}

// Re-export the runtime-state-store hook so other modules don't need to import
// it separately just to invalidate selectors.
export { useRuntimeStateStore };
