import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shouldAutoAllow: vi.fn(() => false),
  replyAcpPermission: vi.fn(() => Promise.resolve()),
  setPermissionRequest: vi.fn(),
}));

vi.mock("@/lib/session-permission-mode", () => ({
  shouldAutoAllowSessionPermissions: mocks.shouldAutoAllow,
}));

vi.mock("@/lib/teamclaw/reply-acp-permission", () => ({
  replyAcpPermission: mocks.replyAcpPermission,
}));

vi.mock("@/stores/v2-streaming-store", () => ({
  useV2StreamingStore: {
    getState: () => ({
      setPermissionRequest: mocks.setPermissionRequest,
    }),
  },
}));

import {
  handleAcpPermissionRequest,
  resetAcpPermissionInFlightForTests,
} from "../handle-acp-permission-request";

const sampleRequest = {
  requestId: "perm-1",
  toolName: "bash",
  description: "run ls",
  params: { command: "ls" },
};

describe("handleAcpPermissionRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAcpPermissionInFlightForTests();
    mocks.shouldAutoAllow.mockReturnValue(false);
  });

  it("writes pending permission in default mode", async () => {
    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    expect(mocks.setPermissionRequest).toHaveBeenCalledWith(
      "sess-1",
      "agent-1",
      sampleRequest,
    );
    expect(mocks.replyAcpPermission).not.toHaveBeenCalled();
  });

  it("auto-replies without writing store in fullAccess mode", async () => {
    mocks.shouldAutoAllow.mockReturnValue(true);

    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    expect(mocks.replyAcpPermission).toHaveBeenCalledWith({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      requestId: "perm-1",
      decision: "allow",
    });
    expect(mocks.setPermissionRequest).not.toHaveBeenCalled();
  });

  it("falls back to pending on auto-reply failure", async () => {
    mocks.shouldAutoAllow.mockReturnValue(true);
    mocks.replyAcpPermission.mockRejectedValueOnce(new Error("mqtt down"));

    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    expect(mocks.setPermissionRequest).toHaveBeenCalledWith(
      "sess-1",
      "agent-1",
      sampleRequest,
    );
  });

  it("ignores empty requestId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: { ...sampleRequest, requestId: "  " },
    });

    expect(mocks.setPermissionRequest).not.toHaveBeenCalled();
    expect(mocks.replyAcpPermission).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dedupes in-flight requestId", async () => {
    mocks.shouldAutoAllow.mockReturnValue(true);
    let resolveReply!: () => void;
    mocks.replyAcpPermission.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReply = resolve;
        }),
    );

    const first = handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });
    const second = handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    resolveReply();
    await Promise.all([first, second]);

    expect(mocks.replyAcpPermission).toHaveBeenCalledTimes(1);
  });
});
