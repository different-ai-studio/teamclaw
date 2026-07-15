import type { DaemonWorkspace } from "@/lib/daemon-workspaces";
import type { SessionWorkspaceRow } from "@/lib/local-cache";

/** Viewer + local machine context for session workspace resolution. */
export type ViewerWorkspaceContext = {
  memberId: string | null;
  localDaemonAgentId: string | null;
  ownedAgentIds: ReadonlySet<string>;
  localWorkspacesByCloudId: Map<string, { path: string; agentId: string | null }>;
};

export type ViewerSessionBinding = {
  agentId: string;
  cloudWorkspaceId: string;
  localPath: string | null;
  updatedAt: string;
};

function indexLocalWorkspaces(
  workspaces: DaemonWorkspace[],
): Map<string, { path: string; agentId: string | null }> {
  const out = new Map<string, { path: string; agentId: string | null }>();
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const id = ws.id?.trim();
    const path = ws.path?.trim();
    if (!id || !path) continue;
    out.set(id, { path, agentId: ws.agentId });
  }
  return out;
}

/** Load the current member, owned agents, and locally registered workspace paths. */
export async function loadViewerWorkspaceContext(
  teamId: string,
): Promise<ViewerWorkspaceContext> {
  const { useCurrentTeamStore } = await import("@/stores/current-team");
  const memberId = useCurrentTeamStore.getState().currentMember?.id ?? null;

  const [{ getLocalDaemonActorId }, { listDaemonWorkspaces }, { getBackend }] =
    await Promise.all([
      import("@/lib/daemon-agent-admin"),
      import("@/lib/daemon-workspaces"),
      import("@/lib/backend"),
    ]);

  const localDaemonAgentId = await getLocalDaemonActorId();
  const localWorkspaces = await listDaemonWorkspaces(teamId).catch(() => []);

  const ownedAgentIds = new Set<string>();
  if (localDaemonAgentId) ownedAgentIds.add(localDaemonAgentId);

  try {
    const connected = await getBackend().actors.listConnectedAgents(teamId);
    for (const row of connected) {
      if (!row.is_owner) continue;
      const id = row.agent_id?.trim() || row.id?.trim();
      if (id) ownedAgentIds.add(id);
    }
  } catch {
    // Offline — local daemon id is enough for the common desktop path.
  }

  return {
    memberId,
    localDaemonAgentId,
    ownedAgentIds,
    localWorkspacesByCloudId: indexLocalWorkspaces(localWorkspaces),
  };
}

export function isViewerAgent(
  agentId: string,
  ctx: ViewerWorkspaceContext,
): boolean {
  return ctx.ownedAgentIds.has(agentId.trim());
}

/** Map a cloud workspace UUID to a path registered on this machine's daemon. */
export function resolveLocalPathForCloudWorkspace(
  cloudWorkspaceId: string | null | undefined,
  ctx: ViewerWorkspaceContext,
): string | null {
  const id = cloudWorkspaceId?.trim();
  if (!id) return null;
  return ctx.localWorkspacesByCloudId.get(id)?.path ?? null;
}

/** Pick the best locally adoptable path from viewer-owned session bindings. */
export function pickBestViewerSessionPath(
  bindings: ViewerSessionBinding[],
  viewer: ViewerWorkspaceContext,
): string | null {
  if (bindings.length === 0) return null;

  const daemonBinding = viewer.localDaemonAgentId
    ? bindings.find(
        (b) => b.agentId === viewer.localDaemonAgentId && b.localPath,
      )
    : null;
  if (daemonBinding?.localPath) return daemonBinding.localPath;

  const accessible = bindings.filter((b) => b.localPath);
  if (accessible.length === 0) return null;

  accessible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return accessible[0].localPath;
}

export function bindingsFromCacheRows(
  rows: SessionWorkspaceRow[],
  viewer: ViewerWorkspaceContext,
  sessionId: string,
): ViewerSessionBinding[] {
  const bindings: ViewerSessionBinding[] = [];
  for (const row of rows) {
    if (row.sessionId !== sessionId) continue;
    const cloudId = row.workspaceId?.trim();
    if (!cloudId) continue;
    const cachedPath = row.workspacePath?.trim() || null;
    bindings.push({
      agentId: row.agentId,
      cloudWorkspaceId: cloudId,
      localPath:
        cachedPath ?? resolveLocalPathForCloudWorkspace(cloudId, viewer),
      updatedAt: row.updatedAt,
    });
  }
  return bindings;
}

async function bindingsFromRuntimes(
  teamId: string,
  sessionId: string,
  viewer: ViewerWorkspaceContext,
): Promise<ViewerSessionBinding[]> {
  const { listDaemonRuntimes } = await import("@/lib/daemon-runtimes");
  const runtimes = await listDaemonRuntimes(teamId).catch(() => []);
  const bindings: ViewerSessionBinding[] = [];

  for (const rt of runtimes) {
    if (rt.sessionId !== sessionId) continue;
    if (!isViewerAgent(rt.agentId, viewer)) continue;
    const cloudId = rt.workspaceId?.trim();
    if (!cloudId) continue;
    bindings.push({
      agentId: rt.agentId,
      cloudWorkspaceId: cloudId,
      localPath: resolveLocalPathForCloudWorkspace(cloudId, viewer),
      updatedAt: rt.updatedAt,
    });
  }
  return bindings;
}

async function bindingsFromViewerCache(
  teamId: string,
  sessionId: string,
  viewer: ViewerWorkspaceContext,
): Promise<ViewerSessionBinding[]> {
  if (!viewer.memberId) return [];
  const { loadSessionWorkspacesForTeam } = await import("@/lib/local-cache");
  const rows = await loadSessionWorkspacesForTeam(
    teamId,
    viewer.memberId,
  ).catch(() => []);
  return bindingsFromCacheRows(rows, viewer, sessionId);
}

/**
 * Resolve which local workspace path the viewer should adopt when opening a
 * session. Returns null for observers or when no locally registered path exists
 * — never returns another member's filesystem path.
 */
export async function resolveSessionWorkspaceForViewer(
  teamId: string,
  sessionId: string,
  ctx?: ViewerWorkspaceContext,
): Promise<string | null> {
  const viewer = ctx ?? (await loadViewerWorkspaceContext(teamId));

  let bindings = await bindingsFromRuntimes(teamId, sessionId, viewer);
  if (bindings.length === 0) {
    bindings = await bindingsFromViewerCache(teamId, sessionId, viewer);
  }

  return pickBestViewerSessionPath(bindings, viewer);
}

/** Best workspace label for a session from viewer-scoped cache rows. */
export function pickSessionWorkspaceLabel(
  rows: SessionWorkspaceRow[],
  sessionId: string,
  viewer: ViewerWorkspaceContext,
): string | null {
  const bindings = bindingsFromCacheRows(rows, viewer, sessionId);
  const path = pickBestViewerSessionPath(bindings, viewer);
  if (path) {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.split("/").pop() || trimmed;
  }
  const newest = bindings.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )[0];
  return newest?.cloudWorkspaceId ?? null;
}
