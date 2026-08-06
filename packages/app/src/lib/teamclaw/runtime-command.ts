import { create, toBinary } from "@bufbuild/protobuf";
import {
  AcpAnswerQuestionSchema,
  AcpCancelSchema,
  AcpCommandSchema,
  AcpDenyPermissionSchema,
  AcpGrantPermissionSchema,
  RuntimeCommandEnvelopeSchema,
} from "@/lib/proto/amux_pb";
import type { RuntimeCommandEnvelope } from "@/lib/proto/amux_pb";

export type RuntimeCommandMqtt = {
  publish: (topic: string, bytes: Uint8Array, retain?: boolean) => Promise<void>;
};

type RuntimeCommandSenderDeps = {
  mqtt: RuntimeCommandMqtt;
  /**
   * Session-addressed dispatch over `rpc/req`. Preferred over publishing to
   * `runtime/{runtimeId}/commands`, which has no reply path — a command aimed
   * at a spawn the daemon no longer knows is dropped silently, which is how a
   * stop button stopped working (docs/debug/interrupt-agent-stale-runtime.md).
   *
   * Resolves false when the session is cold (no attachment). Omitted when the
   * caller has no session id yet — then the MQTT topic is used instead.
   * RPC errors are not silently re-routed to that topic.
   */
  rpc?: (input: {
    targetActorId: string;
    sessionId: string;
    envelope: RuntimeCommandEnvelope;
  }) => Promise<boolean>;
  teamId: string;
  peerId: string;
  senderActorId?: string | null;
  commandId?: () => string;
  nowSeconds?: () => number;
};

export type RuntimePermissionResponseInput = {
  targetActorId: string;
  runtimeId: string;
  /** Preferred address. Falls back to `runtimeId` topic routing when absent. */
  sessionId?: string;
  requestId: string;
  granted: boolean;
  /** ACP option_id when granted (e.g. OpenCode "once" / "always"). */
  optionId?: string;
};

export type RuntimeCancelInput = {
  targetActorId: string;
  runtimeId: string;
  /** Preferred address. Falls back to `runtimeId` topic routing when absent. */
  sessionId?: string;
};

export type RuntimeAnswerQuestionInput = {
  targetActorId: string;
  runtimeId: string;
  /** Preferred address. Falls back to `runtimeId` topic routing when absent. */
  sessionId?: string;
  requestId: string;
  /** `[[selected labels], ...]` — one array per question, in order. */
  answers: string[][];
  reject?: boolean;
};

export type RuntimeCommandSender = {
  sendPermissionResponse: (input: RuntimePermissionResponseInput) => Promise<void>;
  sendAnswerQuestion: (input: RuntimeAnswerQuestionInput) => Promise<void>;
  sendCancel: (input: RuntimeCancelInput) => Promise<void>;
};

export type PermissionRuntimeTarget = {
  agentId: string;
  actorId: string;
  runtimeId: string;
};

export type PermissionRuntimeFallback = {
  agentId?: string | null;
  runtimeId?: string | null;
} | null;

function required(value: string | null | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function runtimeCommandsTopic(teamId: string, actorId: string, runtimeId: string): string {
  return `amux/${teamId}/${actorId}/runtime/${runtimeId}/commands`;
}

export function createRuntimeCommandSender(
  deps: RuntimeCommandSenderDeps,
): RuntimeCommandSender {
  return {
    async sendPermissionResponse(input) {
      const teamId = required(deps.teamId, "team id");
      const targetActorId = required(input.targetActorId, "target actor id");
      const runtimeId = required(input.runtimeId, "runtime id");
      const requestId = required(input.requestId, "request id");
      const peerId = required(deps.peerId, "peer id");
      const grantOptionId = input.optionId?.trim() ?? "";
      const acpCommand = input.granted
        ? create(AcpCommandSchema, {
            command: {
              case: "grantPermission",
              value: create(AcpGrantPermissionSchema, {
                requestId,
                optionId: grantOptionId,
              }),
            },
          })
        : create(AcpCommandSchema, {
            command: {
              case: "denyPermission",
              value: create(AcpDenyPermissionSchema, { requestId }),
            },
          });
      const senderActorId = deps.senderActorId?.trim() ?? "";
      const envelope = create(RuntimeCommandEnvelopeSchema, {
        runtimeId,
        actorId: targetActorId,
        peerId,
        commandId: deps.commandId?.() ?? crypto.randomUUID(),
        timestamp: BigInt(Math.floor(deps.nowSeconds?.() ?? Date.now() / 1000)),
        senderActorId,
        acpCommand,
      });

      await dispatch(deps, teamId, targetActorId, runtimeId, input.sessionId, envelope);
    },

    async sendAnswerQuestion(input) {
      const teamId = required(deps.teamId, "team id");
      const targetActorId = required(input.targetActorId, "target actor id");
      const runtimeId = required(input.runtimeId, "runtime id");
      const requestId = required(input.requestId, "request id");
      const peerId = required(deps.peerId, "peer id");
      const acpCommand = create(AcpCommandSchema, {
        command: {
          case: "answerQuestion",
          value: create(AcpAnswerQuestionSchema, {
            requestId,
            answersJson: JSON.stringify(input.answers ?? []),
            reject: !!input.reject,
          }),
        },
      });
      const senderActorId = deps.senderActorId?.trim() ?? "";
      const envelope = create(RuntimeCommandEnvelopeSchema, {
        runtimeId,
        actorId: targetActorId,
        peerId,
        commandId: deps.commandId?.() ?? crypto.randomUUID(),
        timestamp: BigInt(Math.floor(deps.nowSeconds?.() ?? Date.now() / 1000)),
        senderActorId,
        acpCommand,
      });

      await dispatch(deps, teamId, targetActorId, runtimeId, input.sessionId, envelope);
    },

    async sendCancel(input) {
      const teamId = required(deps.teamId, "team id");
      const targetActorId = required(input.targetActorId, "target actor id");
      const runtimeId = required(input.runtimeId, "runtime id");
      const peerId = required(deps.peerId, "peer id");
      const acpCommand = create(AcpCommandSchema, {
        command: {
          case: "cancel",
          value: create(AcpCancelSchema, {}),
        },
      });
      const senderActorId = deps.senderActorId?.trim() ?? "";
      const envelope = create(RuntimeCommandEnvelopeSchema, {
        runtimeId,
        actorId: targetActorId,
        peerId,
        commandId: deps.commandId?.() ?? crypto.randomUUID(),
        timestamp: BigInt(Math.floor(deps.nowSeconds?.() ?? Date.now() / 1000)),
        senderActorId,
        acpCommand,
      });

      await dispatch(deps, teamId, targetActorId, runtimeId, input.sessionId, envelope);
    },
  };
}

/**
 * Send by (actor, session) when both a session id and an RPC dispatcher are
 * available; otherwise fall back to the per-spawn commands topic.
 *
 * When RPC is attempted, failures are not silently re-routed to the legacy
 * topic — that topic has no delivery receipt and after ADR-0004 often
 * addresses by session UUID while the daemon map is still spawn-keyed.
 */
async function dispatch(
  deps: RuntimeCommandSenderDeps,
  teamId: string,
  targetActorId: string,
  runtimeId: string,
  sessionId: string | undefined,
  envelope: RuntimeCommandEnvelope,
): Promise<void> {
  const session = sessionId?.trim() ?? "";
  if (deps.rpc && session) {
    // No silent legacy fallback: publishing to runtime/{sessionId}/commands
    // after ADR-0004 addresses by session while the daemon map is still
    // spawn-keyed, so a failed RPC that "falls back" becomes a silent miss.
    const dispatched = await deps.rpc({ targetActorId, sessionId: session, envelope });
    if (!dispatched) {
      // The daemon answered and holds nothing for this session — it is cold.
      // Surfacing this is the entire point of moving onto a channel with a
      // reply path; the old topic swallowed it.
      throw new Error(`no live attachment for session ${session}`);
    }
    return;
  }
  await deps.mqtt.publish(
    runtimeCommandsTopic(teamId, targetActorId, runtimeId),
    toBinary(RuntimeCommandEnvelopeSchema, envelope),
    false,
  );
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function fallbackRuntimeForAgent(
  fallbackRuntime: PermissionRuntimeFallback,
  agentId: string,
  agentParticipantCount: number,
): string {
  const runtimeId = fallbackRuntime?.runtimeId?.trim() ?? "";
  if (!runtimeId) return "";
  const fallbackAgentId = fallbackRuntime?.agentId?.trim() ?? "";
  if (fallbackAgentId === agentId) return runtimeId;
  return agentParticipantCount === 1 ? runtimeId : "";
}

export function resolvePermissionRuntimeTarget(args: {
  requestingActorId?: string | null;
  agentParticipantIds: ReadonlyArray<string>;
  connectedAgents: ReadonlyArray<{ agentId: string; actorId: string | null | undefined }>;
  runtimeInfoByAgentId: ReadonlyMap<string, { runtimeId: string }>;
  fallbackRuntime: PermissionRuntimeFallback;
}): PermissionRuntimeTarget | null {
  const agentParticipantIds = unique(
    args.agentParticipantIds.map((id) => id.trim()).filter(Boolean),
  );
  if (agentParticipantIds.length === 0) return null;

  const participantSet = new Set(agentParticipantIds);
  const fallbackAgentId = args.fallbackRuntime?.agentId?.trim() ?? "";
  const candidates = unique([
    args.requestingActorId?.trim() ?? "",
    fallbackAgentId,
    ...agentParticipantIds,
  ].filter((id) => id && participantSet.has(id)));

  const connectedByAgentId = new Map<string, { agentId: string; actorId: string }>();
  for (const agent of args.connectedAgents) {
    const actorId = agent.actorId?.trim() ?? "";
    if (agent.agentId && actorId) connectedByAgentId.set(agent.agentId, { agentId: agent.agentId, actorId });
  }

  for (const agentId of candidates) {
    const actorId = connectedByAgentId.get(agentId)?.actorId?.trim() ?? "";
    if (!actorId) continue;

    const runtimeId =
      args.runtimeInfoByAgentId.get(agentId)?.runtimeId?.trim() ||
      fallbackRuntimeForAgent(args.fallbackRuntime, agentId, agentParticipantIds.length);
    if (!runtimeId) continue;

    return { agentId, actorId, runtimeId };
  }

  return null;
}
