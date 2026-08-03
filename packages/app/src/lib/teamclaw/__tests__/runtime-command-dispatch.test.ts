import { describe, expect, it, vi } from "vitest";

import { createRuntimeCommandSender, runtimeCommandsTopic } from "@/lib/teamclaw/runtime-command";

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

  it("falls back to the legacy topic when the rpc channel itself is down", async () => {
    // Distinct from the case above: no answer at all, rather than a negative
    // one. The old path may still deliver, so failing here would lose a command
    // needlessly during the dual-channel transition.
    const { sender, publish } = makeSender({
      rpc: async () => {
        throw new Error("teamclaw-rpc not initialized");
      },
    });

    await sender.sendCancel(CANCEL);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toBe(
      runtimeCommandsTopic("team-1", "agent-a", "rt-abcd"),
    );
  });

  it("uses the legacy topic when the caller has no session id yet", async () => {
    const rpc = vi.fn(async () => true);
    const { sender, publish } = makeSender({ rpc });

    await sender.sendCancel({ targetActorId: "agent-a", runtimeId: "rt-abcd" });

    expect(rpc).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
