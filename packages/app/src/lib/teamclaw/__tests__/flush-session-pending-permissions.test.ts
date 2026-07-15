import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replyAcpPermission: vi.fn(() => Promise.resolve()),
  byKey: {} as Record<
    string,
    {
      sessionId: string;
      actorId: string;
      pendingPermissionsByRequestId: Record<
        string,
        {
          requestId: string;
          toolName: string;
          description: string;
          params: Record<string, string>;
        }
      >;
    }
  >,
}));

vi.mock("@/lib/teamclaw/reply-acp-permission", () => ({
  replyAcpPermission: mocks.replyAcpPermission,
}));

vi.mock("@/stores/v2-streaming-store", () => ({
  useV2StreamingStore: {
    getState: () => ({ byKey: mocks.byKey }),
  },
}));

import { flushSessionPendingPermissions } from "../flush-session-pending-permissions";

describe("flushSessionPendingPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.byKey = {};
  });

  it("auto-allows all pending permissions for the session", async () => {
    mocks.byKey["sess-1::agent-a"] = {
      sessionId: "sess-1",
      actorId: "agent-a",
      pendingPermissionsByRequestId: {
        "perm-a": {
          requestId: "perm-a",
          toolName: "bash",
          description: "",
          params: {},
        },
      },
    };
    mocks.byKey["sess-1::agent-b"] = {
      sessionId: "sess-1",
      actorId: "agent-b",
      pendingPermissionsByRequestId: {
        "perm-b": {
          requestId: "perm-b",
          toolName: "write",
          description: "",
          params: {},
        },
      },
    };
    mocks.byKey["sess-2::agent-c"] = {
      sessionId: "sess-2",
      actorId: "agent-c",
      pendingPermissionsByRequestId: {
        "perm-c": {
          requestId: "perm-c",
          toolName: "read",
          description: "",
          params: {},
        },
      },
    };

    await flushSessionPendingPermissions("sess-1");

    expect(mocks.replyAcpPermission).toHaveBeenCalledTimes(2);
    expect(mocks.replyAcpPermission).toHaveBeenCalledWith({
      sessionId: "sess-1",
      agentActorId: "agent-a",
      requestId: "perm-a",
      decision: "allow",
    });
    expect(mocks.replyAcpPermission).toHaveBeenCalledWith({
      sessionId: "sess-1",
      agentActorId: "agent-b",
      requestId: "perm-b",
      decision: "allow",
    });
  });

  it("auto-allows multiple pending permissions on the same actor", async () => {
    mocks.byKey["sess-1::agent-a"] = {
      sessionId: "sess-1",
      actorId: "agent-a",
      pendingPermissionsByRequestId: {
        "perm-1": {
          requestId: "perm-1",
          toolName: "bash",
          description: "",
          params: {},
        },
        "perm-2": {
          requestId: "perm-2",
          toolName: "bash",
          description: "",
          params: {},
        },
        "perm-3": {
          requestId: "perm-3",
          toolName: "bash",
          description: "",
          params: {},
        },
      },
    };

    await flushSessionPendingPermissions("sess-1");

    expect(mocks.replyAcpPermission).toHaveBeenCalledTimes(3);
  });

  it("keeps pending when auto-allow fails", async () => {
    mocks.byKey["sess-1::agent-a"] = {
      sessionId: "sess-1",
      actorId: "agent-a",
      pendingPermissionsByRequestId: {
        "perm-a": {
          requestId: "perm-a",
          toolName: "bash",
          description: "",
          params: {},
        },
      },
    };
    mocks.replyAcpPermission.mockRejectedValueOnce(new Error("fail"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await flushSessionPendingPermissions("sess-1");

    expect(mocks.replyAcpPermission).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
