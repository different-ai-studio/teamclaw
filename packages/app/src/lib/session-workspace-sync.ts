import { listDaemonRuntimes } from "@/lib/daemon-runtimes";
import {
  invalidateViewerWorkspaceContext,
  isViewerAgent,
  loadViewerWorkspaceContext,
  resolveLocalPathForCloudWorkspace,
} from "@/lib/session-viewer-workspace";
import { upsertSessionWorkspacesBatch, type SessionWorkspaceRow } from "@/lib/local-cache";

/**
 * Pull session → workspace links from the cloud daemon-runtimes list and
 * persist them into the local libsql `session_viewer_workspace` table.
 * The session list workspace filter reads ONLY this local table, so it keeps
 * working offline after the first sync.
 */
export async function syncSessionWorkspaces(teamId: string): Promise<void> {
  // This is the explicit refresh path — rebuild the viewer context from source
  // (newly connected agents / registered workspaces) instead of a cached copy.
  invalidateViewerWorkspaceContext(teamId);
  const viewer = await loadViewerWorkspaceContext(teamId);
  const memberId = viewer.memberId?.trim();
  if (!memberId) return;

  const runtimes = await listDaemonRuntimes(teamId);
  const now = new Date().toISOString();
  const rows: SessionWorkspaceRow[] = [];

  for (const rt of runtimes) {
    if (!rt.sessionId) continue;
    if (!isViewerAgent(rt.agentId, viewer)) continue;
    const workspaceId = rt.workspaceId?.trim();
    if (!workspaceId) continue;
    rows.push({
      sessionId: rt.sessionId,
      teamId,
      viewerMemberId: memberId,
      agentId: rt.agentId,
      workspaceId,
      workspacePath: resolveLocalPathForCloudWorkspace(workspaceId, viewer),
      updatedAt: now,
    });
  }

  if (rows.length === 0) return;
  await upsertSessionWorkspacesBatch(rows);
}
