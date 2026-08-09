import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeCommandSender,
  runtimeCommandsTopic,
} from "@/lib/teamclu/runtime-command";

function makeSender(overrides: {
  rpc?: (input: { targetActorId: string; sessionId: string }) => Promise<boolean>;
}) {
  const publish = vi.fn(async () => {});
  const sender = createRuntimeCommandSender({
    mqtt: { publish },
    rpc: overrides.rpc,
    teamId: "team-1",
    peerId: "peer-1",
    senderActorId: "member-1",
    commandId: () => "cmd-1",
    nowSeconds: () => 1,
  });
  return { sender, publish };
}

const CANCEL = { targetActorId: "agent-a", runtimeId: "rt-abcd", sessionId: "session-1" };
const PERMISSION = {
  targetActorId: "agent-a",
  runtimeId: "rt-abcd",
  sessionId: "session-1",
  requestId: "perm-1",
  granted: true,
  optionId: "once",
};
const ANSWER = {
  targetActorId: "agent-a",
  runtimeId: "rt-abcd",
  sessionId: "session-1",
  requestId: "q-1",
  answers: [["yes"]],
};

describe("runtime command dispatch", () => {
  it("addresses the session over rpc when one is available", async () => {
    const rpc = vi.fn(async () => true);
    const { sender, publish } = makeSender({ rpc });

    await sender.sendCancel(CANCEL);

    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ targetActorId: "agent-a", sessionId: "session-1" }),
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("throws when the daemon reports no attachment for the session", async () => {
    // A reachable daemon answering "nothing here" is the whole reason for
    // moving off `runtime/{id}/commands`: that topic had no reply path, so a
    // command aimed at a dead spawn was dropped in silence and the UI waited
    // forever for a state change (docs/debug/interrupt-agent-stale-runtime.md).
    const { sender, publish } = makeSender({ rpc: async () => false });

    await expect(sender.sendCancel(CANCEL)).rejects.toThrow(/no live attachment/);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not fall back to the legacy topic when cancel rpc is down", async () => {
    // Legacy fallback published cancel with session UUID as the topic
    // segment; the daemon looked that up as a spawn key and dropped it
    // silently — stop looked like a no-op (cross-actor interrupt on the
    // same machine). Prefer a loud failure over a silent miss.
    const { sender, publish } = makeSender({
      rpc: async () => {
        throw new Error("teamclu-rpc not initialized");
      },
    });

    await expect(sender.sendCancel(CANCEL)).rejects.toThrow(/teamclu-rpc not initialized/);
    expect(publish).not.toHaveBeenCalled();
  });

  it("uses the legacy topic when the caller has no session id yet", async () => {
    const rpc = vi.fn(async () => true);
    const { sender, publish } = makeSender({ rpc });

    await sender.sendCancel({ targetActorId: "agent-a", runtimeId: "rt-abcd" });

    expect(rpc).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // Issue #783: permission / answer share dispatch with cancel. A transport
  // blip must not leave the agent stuck waiting on an approval the user
  // already clicked — deliver via spawn-keyed MQTT after one RPC retry.
  it("delivers permission response via spawn topic when rpc transport fails", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("teamclu-rpc not initialized");
    });
    const { sender, publish } = makeSender({ rpc });

    await sender.sendPermissionResponse(PERMISSION);

    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toBe(
      runtimeCommandsTopic("team-1", "agent-a", "rt-abcd"),
    );
  });

  it("delivers answer-question via spawn topic when rpc transport fails", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("broker disconnected");
    });
    const { sender, publish } = makeSender({ rpc });

    await sender.sendAnswerQuestion(ANSWER);

    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toBe(
      runtimeCommandsTopic("team-1", "agent-a", "rt-abcd"),
    );
  });

  it("does not mqtt-fallback permission when the session is cold", async () => {
    const { sender, publish } = makeSender({ rpc: async () => false });

    await expect(sender.sendPermissionResponse(PERMISSION)).rejects.toThrow(
      /no live attachment/,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not mqtt-fallback answer-question when the session is cold", async () => {
    const { sender, publish } = makeSender({ rpc: async () => false });

    await expect(sender.sendAnswerQuestion(ANSWER)).rejects.toThrow(/no live attachment/);
    expect(publish).not.toHaveBeenCalled();
  });
});
