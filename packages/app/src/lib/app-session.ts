/**
 * The session an app is worked on in.
 *
 * An app has exactly one session for now. Creating an app opens that session
 * with an opening message already sent, so the user lands in a conversation
 * that is already underway rather than an empty box; opening an app later
 * returns to the same session.
 */
import { getBackend } from '@/lib/backend'
import { createSessionShell, createSessionWithFirstMessage } from '@/lib/session-create'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { upsertSessionWorkspacesBatch } from '@/lib/local-cache'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'
import { isTauri } from '@/lib/utils'
import { resolveAppType } from '@/lib/app-types'
import type { AppRow, AppSessionRow } from '@/lib/backend/types'

/** Resolve the local daemon's per-app workdir: `~/.amuxd/apps/<appId>`. */
export async function appWorkdirPath(appId: string): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const { homeDir } = await import('@tauri-apps/api/path')
    const home = await homeDir()
    return `${home}/.amuxd/apps/${appId}`
  } catch (e) {
    console.warn('[app-session] could not resolve home dir (non-fatal):', e)
    return null
  }
}

/**
 * Pick the most-recent session for an app, ordering by
 * `lastMessageAt ?? createdAt` descending.
 */
export function pickMostRecentSession(rows: AppSessionRow[]): AppSessionRow | null {
  if (rows.length === 0) return null
  const ts = (r: AppSessionRow): number => {
    const v = r.lastMessageAt ?? r.createdAt
    const n = v ? Date.parse(v) : NaN
    return Number.isNaN(n) ? 0 : n
  }
  return rows.reduce((best, r) => (ts(r) > ts(best) ? r : best))
}

/**
 * The opening message sent on the app's behalf, built from the name the user
 * typed plus a fixed per-type prompt.
 *
 * Each one points the agent at `AGENTS.md` first — that file is where the
 * template records the build contract it must not break — and asks for a plan
 * before edits, so the first thing the user sees is a proposal rather than a
 * pile of files.
 */
export function firstPromptForApp(app: Pick<AppRow, 'name' | 'type'>): string {
  const name = app.name.trim()
  switch (resolveAppType(app.type).id) {
    case 'static_web':
      return `我要做一个静态网页：${name}\n\n先读一下 AGENTS.md 了解这个项目的结构和约束，然后告诉我你打算做成什么样（有哪些页面、大致的结构和风格），我确认后你再动手改 public/ 下的文件。`
    case 'slides':
      return `我要做一套演示材料：${name}\n\n先读一下 AGENTS.md 了解幻灯片怎么组织，然后列一个提纲给我看（每一页讲什么），我确认后你再写进 public/index.html。`
    default:
      return `我要做一个数据操作应用：${name}\n\n先读一下 AGENTS.md 了解项目结构和数据库约定，然后告诉我你打算怎么设计数据表和页面，我确认后再动手写代码。`
  }
}

interface AppSessionContext {
  teamId: string
  authUserId: string | null
  creatorActorId: string | null
  localDaemonActorId: string | null
  viewerMemberId: string | null
}

async function loadContext(app: AppRow): Promise<AppSessionContext> {
  const team = useCurrentTeamStore.getState()
  const teamId = team.team?.id ?? app.teamId
  const authUserId = useAuthStore.getState().session?.user?.id ?? null
  const { getLocalDaemonActorId } = await import('@/lib/daemon-agent-admin')
  const localDaemonActorId = await getLocalDaemonActorId().catch(() => null)
  const creatorActorId = authUserId
    ? await resolveCurrentMemberActorId(teamId, authUserId, {
        currentTeamId: teamId,
        currentMemberId: team.currentMember?.id ?? null,
      }).catch(() => null)
    : null
  return {
    teamId,
    authUserId,
    creatorActorId,
    localDaemonActorId,
    viewerMemberId: team.currentMember?.id ?? null,
  }
}

/**
 * Point a session at the app's checkout, both locally and in the cloud.
 *
 * Two bindings, because two different things read them: the local libsql row
 * drives the desktop UI (file browser, workspace switch), and the cloud daemon
 * workspace is what runtime-start matches by path — without it the daemon falls
 * back to its default workspace and the agent runs in the wrong directory.
 */
async function bindAppWorkspace(
  app: AppRow,
  sessionId: string,
  ctx: AppSessionContext,
): Promise<void> {
  const appWorkdir = await appWorkdirPath(app.id)
  if (!appWorkdir || !ctx.localDaemonActorId) return

  if (ctx.viewerMemberId) {
    try {
      await upsertSessionWorkspacesBatch([
        {
          sessionId,
          teamId: ctx.teamId,
          viewerMemberId: ctx.viewerMemberId,
          agentId: ctx.localDaemonActorId,
          workspaceId: app.workspaceId ?? null,
          workspacePath: appWorkdir,
          updatedAt: new Date().toISOString(),
        },
      ])
    } catch (e) {
      console.warn('[app-session] could not bind session workspace (non-fatal):', e)
    }
  }

  try {
    const { listDaemonWorkspaces, createDaemonWorkspace } = await import('@/lib/daemon-workspaces')
    const { workspacePathsMatch } = await import('@/stores/session-utils')
    const existing = (await listDaemonWorkspaces(ctx.teamId, ctx.localDaemonActorId)).find(
      (w) => !w.archived && w.path && workspacePathsMatch(w.path, appWorkdir),
    )
    if (!existing) {
      await createDaemonWorkspace({
        teamId: ctx.teamId,
        agentId: ctx.localDaemonActorId,
        createdByMemberId: ctx.creatorActorId,
        name: app.name,
        path: appWorkdir,
      })
    }
  } catch (e) {
    console.warn('[app-session] could not register app daemon workspace (non-fatal):', e)
  }
}

/**
 * The session for an app: its most recent one, or a fresh one linked to it.
 *
 * The local daemon is seated as a participant either way. It has to be: the
 * cloud API serves `GET /v1/sessions/:id` through participant-scoped RLS, so a
 * daemon with no seat cannot read the session it is asked to run and
 * runtimeStart fails with "session not found".
 */
export async function ensureAppSession(app: AppRow): Promise<string | null> {
  const ctx = await loadContext(app)

  const sessions = await getBackend().apps.listAppSessions(app.id)
  const recent = pickMostRecentSession(sessions)

  if (recent) {
    if (ctx.localDaemonActorId) {
      try {
        await getBackend().sessionMembers.addParticipant(recent.id, ctx.localDaemonActorId)
      } catch (e) {
        console.warn('[app-session] could not seat the local daemon (non-fatal):', e)
      }
    }
    await bindAppWorkspace(app, recent.id, ctx)
    return recent.id
  }

  if (!ctx.creatorActorId) {
    console.error('[app-session] cannot create a session: no current actor')
    return null
  }
  const { sessionId } = await createSessionShell({
    teamId: ctx.teamId,
    creatorActorId: ctx.creatorActorId,
    title: app.name,
    additionalActorIds: ctx.localDaemonActorId ? [ctx.localDaemonActorId] : [],
    appId: app.id,
  })
  await bindAppWorkspace(app, sessionId, ctx)
  return sessionId
}

/**
 * Open a brand-new app: create its session with the opening message already
 * sent, so the agent is working by the time the user looks at it.
 *
 * The message @-mentions the local daemon on purpose. An unmentioned message
 * is only silent-queued by the daemon, so without it the agent would sit idle
 * until the user typed something — which defeats the point of sending an
 * opening message at all.
 */
export async function startAppFirstSession(app: AppRow): Promise<string | null> {
  const ctx = await loadContext(app)
  if (!ctx.creatorActorId) {
    console.error('[app-session] cannot start the first session: no current actor')
    return null
  }
  const agentIds = ctx.localDaemonActorId ? [ctx.localDaemonActorId] : []

  const { sessionId } = await createSessionWithFirstMessage({
    teamId: ctx.teamId,
    creatorActorId: ctx.creatorActorId,
    additionalActorIds: agentIds,
    agentActorIds: agentIds,
    messageText: firstPromptForApp(app),
    title: app.name,
    appId: app.id,
    mentionActorIds: agentIds,
  })

  // Bind before starting the runtime: runtime-start resolves the session's
  // workspace, and an unbound session lands the agent in the default folder.
  await bindAppWorkspace(app, sessionId, ctx)

  if (agentIds.length > 0) {
    const { startAgentRuntimesAsync } = await import('@/lib/session-create')
    void startAgentRuntimesAsync({
      sessionId,
      teamId: ctx.teamId,
      agentActorIds: agentIds,
    }).catch((e) => console.warn('[app-session] runtime start failed (non-fatal):', e))
  }
  return sessionId
}
