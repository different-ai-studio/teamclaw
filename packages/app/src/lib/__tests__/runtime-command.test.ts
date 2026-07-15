import { fromBinary } from "@bufbuild/protobuf";
import { RuntimeCommandEnvelopeSchema } from "@/lib/proto/amux_pb";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeCommandSender,
  resolvePermissionRuntimeTarget,
} from "@/lib/teamclaw/runtime-command";

describe("runtime command sender", () => {
  it("publishes a grant_permission ACP command to the runtime command topic", async () => {
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };
    const sender = createRuntimeCommandSender({
      mqtt,
      teamId: "team-1",
      peerId: "teamclaw-desktop-member-1",
      senderActorId: "member-actor-1",
      commandId: () => "command-1",
      nowSeconds: () => 1_779_430_400,
    });

    await sender.sendPermissionResponse({
      targetActorId: "actor-1",
      runtimeId: "rt-abcd",
      requestId: "perm-1",
      granted: true,
      optionId: "always",
    });

    expect(mqtt.publish).toHaveBeenCalledTimes(1);
    const [topic, bytes, retain] = mqtt.publish.mock.calls[0] as [
      string,
      Uint8Array,
      boolean,
    ];
    expect(topic).toBe("amux/team-1/actor-1/runtime/rt-abcd/commands");
    expect(retain).toBe(false);

    const envelope = fromBinary(RuntimeCommandEnvelopeSchema, bytes);
    expect(envelope.runtimeId).toBe("rt-abcd");
    expect(envelope.actorId).toBe("actor-1");
    expect(envelope.peerId).toBe("teamclaw-desktop-member-1");
    expect(envelope.commandId).toBe("command-1");
    expect(envelope.timestamp).toBe(1_779_430_400n);
    expect(envelope.senderActorId).toBe("member-actor-1");
    expect(envelope.acpCommand?.command.case).toBe("grantPermission");
    if (envelope.acpCommand?.command.case !== "grantPermission") {
      throw new Error("expected grantPermission command");
    }
    expect(envelope.acpCommand.command.value.requestId).toBe("perm-1");
    expect(envelope.acpCommand.command.value.optionId).toBe("always");
  });

  it("publishes a cancel ACP command to the runtime command topic", async () => {
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };
    const sender = createRuntimeCommandSender({
      mqtt,
      teamId: "team-1",
      peerId: "teamclaw-desktop-member-1",
      senderActorId: "member-actor-1",
      commandId: () => "command-2",
      nowSeconds: () => 1_779_430_400,
    });

    await sender.sendCancel({
      targetActorId: "actor-1",
      runtimeId: "rt-abcd",
    });

    expect(mqtt.publish).toHaveBeenCalledTimes(1);
    const [topic, bytes, retain] = mqtt.publish.mock.calls[0] as [
      string,
      Uint8Array,
      boolean,
    ];
    expect(topic).toBe("amux/team-1/actor-1/runtime/rt-abcd/commands");
    expect(retain).toBe(false);

    const envelope = fromBinary(RuntimeCommandEnvelopeSchema, bytes);
    expect(envelope.runtimeId).toBe("rt-abcd");
    expect(envelope.actorId).toBe("actor-1");
    expect(envelope.commandId).toBe("command-2");
    expect(envelope.acpCommand?.command.case).toBe("cancel");
  });
});

describe("resolvePermissionRuntimeTarget", () => {
  it("chooses the requesting agent live runtime and actor when available", () => {
    const target = resolvePermissionRuntimeTarget({
      requestingActorId: "agent-2",
      agentParticipantIds: ["agent-1", "agent-2"],
      connectedAgents: [
        { agentId: "agent-1", actorId: "agent-1" },
        { agentId: "agent-2", actorId: "agent-2" },
      ],
      runtimeInfoByAgentId: new Map([
        ["agent-1", { runtimeId: "rt-1" }],
        ["agent-2", { runtimeId: "rt-2" }],
      ]),
      fallbackRuntime: null,
    });

    expect(target).toEqual({
      agentId: "agent-2",
      actorId: "agent-2",
      runtimeId: "rt-2",
    });
  });
});
