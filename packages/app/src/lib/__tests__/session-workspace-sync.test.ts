import { describe, it, expect, vi, beforeEach } from "vitest";

const { listDaemonRuntimes, upsertSessionWorkspacesBatch } = vi.hoisted(() => ({
  listDaemonRuntimes: vi.fn(),
  upsertSessionWorkspacesBatch: vi.fn(),
}));
const { loadViewerWorkspaceContext, isViewerAgent, resolveLocalPathForCloudWorkspace } =
  vi.hoisted(() => ({
    loadViewerWorkspaceContext: vi.fn(),
    isViewerAgent: vi.fn(),
    resolveLocalPathForCloudWorkspace: vi.fn(),
  }));

vi.mock("@/lib/daemon-runtimes", () => ({ listDaemonRuntimes }));
vi.mock("@/lib/local-cache", () => ({ upsertSessionWorkspacesBatch }));
vi.mock("@/lib/session-viewer-workspace", () => ({
  loadViewerWorkspaceContext,
  invalidateViewerWorkspaceContext: vi.fn(),
  isViewerAgent,
  resolveLocalPathForCloudWorkspace,
}));

import { syncSessionWorkspaces } from "@/lib/session-workspace-sync";

const viewerCtx = {
  memberId: "member-b",
  localDaemonAgentId: "agent-local",
  ownedAgentIds: new Set(["agent-local"]),
  localWorkspacesByCloudId: new Map(),
};

describe("syncSessionWorkspaces", () => {
  beforeEach(() => {
    listDaemonRuntimes.mockReset();
    upsertSessionWorkspacesBatch.mockReset();
    loadViewerWorkspaceContext.mockReset();
    isViewerAgent.mockReset();
    resolveLocalPathForCloudWorkspace.mockReset();
    loadViewerWorkspaceContext.mockResolvedValue(viewerCtx);
    isViewerAgent.mockImplementation((agentId: string) => agentId === "agent-local");
    resolveLocalPathForCloudWorkspace.mockImplementation(
      (workspaceId: string) =>
        workspaceId === "ws1" ? "/Users/b/local-ws" : null,
    );
  });

  it("upserts one row per viewer-owned runtime with locally resolved paths", async () => {
    listDaemonRuntimes.mockResolvedValue([
      { sessionId: "s1", agentId: "agent-local", workspaceId: "ws1", updatedAt: "2026-06-01" },
      { sessionId: "s1", agentId: "agent-local-2", workspaceId: "ws2", updatedAt: "2026-06-02" },
      { sessionId: "s1", agentId: "agent-alice", workspaceId: "ws-a", workspacePath: "/Users/alice/proj" },
      { sessionId: "s2", agentId: "agent-local", workspaceId: null },
    ]);
    isViewerAgent.mockImplementation(
      (agentId: string) => agentId === "agent-local" || agentId === "agent-local-2",
    );

    await syncSessionWorkspaces("teamA");
    expect(upsertSessionWorkspacesBatch).toHaveBeenCalledTimes(1);
    const rows = upsertSessionWorkspacesBatch.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      teamId: "teamA",
      viewerMemberId: "member-b",
      agentId: "agent-local",
      workspaceId: "ws1",
      workspacePath: "/Users/b/local-ws",
    });
    expect(rows[1]).toMatchObject({
      sessionId: "s1",
      agentId: "agent-local-2",
      workspaceId: "ws2",
      workspacePath: null,
    });
  });

  it("no-ops when viewer member id is missing", async () => {
    loadViewerWorkspaceContext.mockResolvedValue({ ...viewerCtx, memberId: null });
    listDaemonRuntimes.mockResolvedValue([
      { sessionId: "s1", agentId: "agent-local", workspaceId: "ws1" },
    ]);
    await syncSessionWorkspaces("teamA");
    expect(upsertSessionWorkspacesBatch).not.toHaveBeenCalled();
  });

  it("no-ops when nothing to persist", async () => {
    listDaemonRuntimes.mockResolvedValue([
      { sessionId: "s2", agentId: "agent-alice", workspaceId: "ws-a" },
    ]);
    await syncSessionWorkspaces("teamA");
    expect(upsertSessionWorkspacesBatch).not.toHaveBeenCalled();
  });
});
