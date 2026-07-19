import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPendingEntryFromAcpPermission,
  collectAcpBystanderWaitingPermissions,
  collectAcpStreamingPermissions,
} from "@/lib/teamclaw/acp-permission-entries";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

describe("acp permission entries", () => {
  beforeEach(() => {
    useCurrentTeamStore.setState({
      currentMember: { id: "me-actor", display_name: "Me" } as never,
    });
  });

  it("maps bash tool permission for the approval card", () => {
    const entry = buildPendingEntryFromAcpPermission("sess-1", "agent-1", {
      requestId: "perm-1",
      toolName: "bash",
      description: "ls -la",
      params: { command: "ls -la" },
    });
    expect(entry.permission.id).toBe("perm-1");
    expect(entry.permission.permission).toBe("bash");
    expect(entry.permission.patterns).toEqual(["ls -la"]);
    expect(entry.permission.metadata?._acp_agent_actor_id).toBe("agent-1");
  });

  it("collects pending permissions for the active session only", () => {
    const rows = collectAcpStreamingPermissions("sess-a", {
      "sess-a::agent-1": {
        sessionId: "sess-a",
        actorId: "agent-1",
        pendingPermissionsByRequestId: {
          p1: {
            requestId: "p1",
            toolName: "Bash",
            description: "echo hi",
            params: {},
          },
        },
      },
      "sess-b::agent-2": {
        sessionId: "sess-b",
        actorId: "agent-2",
        pendingPermissionsByRequestId: {
          p2: {
            requestId: "p2",
            toolName: "bash",
            description: "pwd",
            params: {},
          },
        },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permission.id).toBe("p1");
  });

  it("hides interactive queue for bystander when requester is stamped", () => {
    const byKey = {
      "sess-a::agent-1": {
        sessionId: "sess-a",
        actorId: "agent-1",
        pendingPermissionsByRequestId: {
          p1: {
            requestId: "p1",
            toolName: "bash",
            description: "ls",
            params: { requester_actor_id: "other-actor" },
            requesterActorId: "other-actor",
          },
        },
      },
    };
    expect(collectAcpStreamingPermissions("sess-a", byKey)).toHaveLength(0);
    const waiting = collectAcpBystanderWaitingPermissions("sess-a", byKey);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.permission.metadata?.requester_actor_id).toBe("other-actor");
  });

  it("keeps interactive queue for requester and for legacy empty stamp", () => {
    expect(
      collectAcpStreamingPermissions("sess-a", {
        "sess-a::agent-1": {
          sessionId: "sess-a",
          actorId: "agent-1",
          pendingPermissionsByRequestId: {
            mine: {
              requestId: "mine",
              toolName: "bash",
              description: "ls",
              params: { requester_actor_id: "me-actor" },
              requesterActorId: "me-actor",
            },
            legacy: {
              requestId: "legacy",
              toolName: "bash",
              description: "pwd",
              params: {},
            },
          },
        },
      }),
    ).toHaveLength(2);
    expect(
      collectAcpBystanderWaitingPermissions("sess-a", {
        "sess-a::agent-1": {
          sessionId: "sess-a",
          actorId: "agent-1",
          pendingPermissionsByRequestId: {
            mine: {
              requestId: "mine",
              toolName: "bash",
              description: "ls",
              params: { requester_actor_id: "me-actor" },
              requesterActorId: "me-actor",
            },
          },
        },
      }),
    ).toHaveLength(0);
  });

  it("collects multiple parallel subagent permissions for one actor", () => {
    const rows = collectAcpStreamingPermissions("sess-a", {
      "sess-a::agent-1": {
        sessionId: "sess-a",
        actorId: "agent-1",
        pendingPermissionsByRequestId: {
          "perm-1": {
            requestId: "perm-1",
            toolName: "bash",
            description: "ps",
            params: { command: "ps", childSessionId: "child-1" },
          },
          "perm-2": {
            requestId: "perm-2",
            toolName: "bash",
            description: "ps",
            params: { command: "ps", childSessionId: "child-2" },
          },
          "perm-3": {
            requestId: "perm-3",
            toolName: "bash",
            description: "ps",
            params: { command: "ps", childSessionId: "child-3" },
          },
        },
      },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.permission.id).sort()).toEqual([
      "perm-1",
      "perm-2",
      "perm-3",
    ]);
  });
});

describe("parallel permission queue in v2 store", () => {
  beforeEach(() => {
    useCurrentTeamStore.setState({
      currentMember: { id: "me-actor", display_name: "Me" } as never,
    });
    useV2StreamingStore.setState({
      byKey: {},
      revisionBySession: {},
      archived: [],
      persistedPlansBySession: {},
      subagentByToolId: {},
      archivedSubagentByToolId: {},
      childAcpSessionToToolId: {},
      pendingSubagentEvents: {},
    });
  });

  it("keeps all pending requests until each is cleared by requestId", async () => {
    const store = useV2StreamingStore.getState();
    const req = (id: string, childSessionId: string) => ({
      requestId: id,
      toolName: "bash",
      description: "ps",
      params: { command: "ps", childSessionId },
    });

    store.setPermissionRequest("sess-1", "agent-1", req("perm-1", "child-1"));
    store.setPermissionRequest("sess-1", "agent-1", req("perm-2", "child-2"));
    store.setPermissionRequest("sess-1", "agent-1", req("perm-3", "child-3"));

    const collected = collectAcpStreamingPermissions(
      "sess-1",
      useV2StreamingStore.getState().byKey,
    );
    expect(collected).toHaveLength(3);

    store.clearPermissionRequest("sess-1", "agent-1", "perm-1");
    expect(
      collectAcpStreamingPermissions("sess-1", useV2StreamingStore.getState().byKey),
    ).toHaveLength(2);

    store.clearPermissionRequest("sess-1", "agent-1", "perm-2");
    store.clearPermissionRequest("sess-1", "agent-1", "perm-3");
    expect(
      collectAcpStreamingPermissions("sess-1", useV2StreamingStore.getState().byKey),
    ).toHaveLength(0);
  });
});
