import { create, toBinary } from "@bufbuild/protobuf";
import {
  AcpCancelSchema,
  AcpCommandSchema,
  AcpDenyPermissionSchema,
  AcpGrantPermissionSchema,
  RuntimeCommandEnvelopeSchema,
} from "@/lib/proto/amux_pb";

export type RuntimeCommandMqtt = {
  publish: (topic: string, bytes: Uint8Array, retain?: boolean) => Promise<void>;
};

type RuntimeCommandSenderDeps = {
  mqtt: RuntimeCommandMqtt;
  teamId: string;
  peerId: string;
  senderActorId?: string | null;
  commandId?: () => string;
  nowSeconds?: () => number;
};

export type RuntimePermissionResponseInput = {
  targetActorId: string;
  runtimeId: string;
  requestId: string;
  granted: boolean;
  /** ACP option_id when granted (e.g. OpenCode "once" / "always"). */
  optionId?: string;
};

export type RuntimeCancelInput = {
  targetActorId: string;
  runtimeId: string;
};

export type RuntimeCommandSender = {
  sendPermissionResponse: (input: RuntimePermissionResponseInput) => Promise<void>;
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

      await deps.mqtt.publish(
        runtimeCommandsTopic(teamId, targetActorId, runtimeId),
        toBinary(RuntimeCommandEnvelopeSchema, envelope),
        false,
      );
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

      await deps.mqtt.publish(
        runtimeCommandsTopic(teamId, targetActorId, runtimeId),
        toBinary(RuntimeCommandEnvelopeSchema, envelope),
        false,
      );
    },
  };
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
