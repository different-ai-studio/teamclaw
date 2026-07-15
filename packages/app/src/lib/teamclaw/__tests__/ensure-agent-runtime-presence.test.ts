import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLocalDaemonActorId = vi.fn();
const mockProbeDaemonHttp = vi.fn();

vi.mock("@/lib/daemon-agent-admin", () => ({
  getLocalDaemonActorId: () => mockGetLocalDaemonActorId(),
}));

vi.mock("@/lib/daemon-local-client", () => ({
  probeDaemonHttp: () => mockProbeDaemonHttp(),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

describe("resolveAgentDevicePresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetLocalDaemonActorId.mockReset();
    mockProbeDaemonHttp.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { useActorPresenceStore } = await import("@/stores/actor-presence-store");
    useActorPresenceStore.setState({ byActorId: {} });
  });

  it("returns online when MQTT retain is already present", async () => {
    const { resolveAgentDevicePresence } = await import("../ensure-agent-runtime");
    const { useActorPresenceStore } = await import("@/stores/actor-presence-store");

    useActorPresenceStore.getState().upsert("agent-1", {
      online: true,
      displayName: "b001-agent",
      lastUpdated: Date.now(),
    });

    await expect(resolveAgentDevicePresence("agent-1", { timeoutMs: 0 })).resolves.toBe("online");
  });

  it("waits for MQTT retain before treating presence as unknown", async () => {
    const { resolveAgentDevicePresence } = await import("../ensure-agent-runtime");
    const { useActorPresenceStore } = await import("@/stores/actor-presence-store");

    mockGetLocalDaemonActorId.mockResolvedValue(null);

    const promise = resolveAgentDevicePresence("agent-1", { timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(100);
    useActorPresenceStore.getState().upsert("agent-1", {
      online: true,
      displayName: "b001-agent",
      lastUpdated: Date.now(),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("online");
  });

  it("returns offline only when MQTT explicitly reports offline", async () => {
    const { resolveAgentDevicePresence } = await import("../ensure-agent-runtime");
    const { useActorPresenceStore } = await import("@/stores/actor-presence-store");

    useActorPresenceStore.getState().upsert("agent-1", {
      online: false,
      displayName: "b001-agent",
      lastUpdated: Date.now(),
    });

    await expect(resolveAgentDevicePresence("agent-1", { timeoutMs: 0 })).resolves.toBe("offline");
  });

  it("returns unknown when retain is missing and agent is not the local daemon", async () => {
    const { resolveAgentDevicePresence } = await import("../ensure-agent-runtime");

    mockGetLocalDaemonActorId.mockResolvedValue("local-device");
    mockProbeDaemonHttp.mockResolvedValue({ ok: true, reason: null });

    await expect(resolveAgentDevicePresence("remote-agent", { timeoutMs: 0 })).resolves.toBe("unknown");
    expect(mockProbeDaemonHttp).not.toHaveBeenCalled();
  });

  it("uses local HTTP probe for the desktop daemon when MQTT retain is still missing", async () => {
    const { resolveAgentDevicePresence } = await import("../ensure-agent-runtime");

    mockGetLocalDaemonActorId.mockResolvedValue("local-agent");
    mockProbeDaemonHttp.mockResolvedValue({ ok: true, reason: null });

    await expect(resolveAgentDevicePresence("local-agent", { timeoutMs: 0 })).resolves.toBe("online");
  });

  it("returns unknown when local HTTP probe fails during MQTT bootstrap", async () => {
    const { resolveAgentDevicePresence } = await import("../ensure-agent-runtime");

    mockGetLocalDaemonActorId.mockResolvedValue("local-agent");
    mockProbeDaemonHttp.mockResolvedValue({ ok: false, reason: "not_running" });

    await expect(resolveAgentDevicePresence("local-agent", { timeoutMs: 0 })).resolves.toBe("unknown");
  });
});
