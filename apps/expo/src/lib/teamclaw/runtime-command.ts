import { create, toBinary } from "@bufbuild/protobuf";
import {
  AcpCommandSchema,
  AcpDenyPermissionSchema,
  AcpGrantPermissionSchema,
  RuntimeCommandEnvelopeSchema,
} from "@teamclaw/app/proto/amux_pb";

import type { ConnectedAgent, RuntimeInfo } from "../../features/actors/connected-agent-types";
import type { TeamMqttClient } from "../mqtt/team-mqtt";
import { uuidV4 } from "../uuid";

export type RuntimeCommandMqtt = Pick<TeamMqttClient, "publish">;

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
  optionId?: string;
};

export type RuntimeCommandSender = {
  sendPermissionResponse: (input: RuntimePermissionResponseInput) => Promise<void>;
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
        commandId: deps.commandId?.() ?? uuidV4(),
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
  connectedAgents: ReadonlyArray<Pick<ConnectedAgent, "agentId">>;
  runtimeInfoByAgentId: ReadonlyMap<string, Pick<RuntimeInfo, "runtimeId">>;
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

  // An agent's routing actor id IS its agentId (== actor_id); the directory no
  // longer carries a separate deviceId. Only consider agents we know are
  // connected so we don't route to an offline daemon.
  const connectedAgentIds = new Set<string>();
  for (const agent of args.connectedAgents) {
    if (agent.agentId) connectedAgentIds.add(agent.agentId);
  }

  for (const agentId of candidates) {
    if (!connectedAgentIds.has(agentId)) continue;

    const runtimeId =
      args.runtimeInfoByAgentId.get(agentId)?.runtimeId?.trim() ||
      fallbackRuntimeForAgent(args.fallbackRuntime, agentId, agentParticipantIds.length);
    if (!runtimeId) continue;

    return { agentId, actorId: agentId, runtimeId };
  }

  return null;
}
