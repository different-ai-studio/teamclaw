import { create } from 'zustand'
import i18n from '@/lib/i18n'
import { isTauri } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import {
  probeDaemonHttp,
  invalidateDaemonConnection,
  fetchDaemonCloudAuthStatus,
} from '@/lib/daemon-local-client'
import { getLocalDaemonActorId } from '@/lib/daemon-agent-admin'
import { markStartup } from '@/lib/startup-perf'
import { appScheme } from '@/lib/build-config'

/**
 * After onboarding a local daemon, adopt it as the user's default agent — but
 * only when they don't already have one, so we never clobber an explicit choice.
 * Best-effort: failures here must not fail daemon onboarding.
 */
async function adoptAsDefaultAgentIfUnset(teamId: string, agentId: string): Promise<void> {
  try {
    const prefs = useMemberPreferencesStore.getState()
    await prefs.ensureLoaded(teamId)
    if (!useMemberPreferencesStore.getState().defaultAgentId) {
      await useMemberPreferencesStore.getState().setDefaultAgent(teamId, agentId)
    }
  } catch (e) {
    console.warn('[daemon-onboarding] could not set local daemon as default agent', e)
  }
}

// 'unknown'        — no current team yet (don't block)
// 'needs-onboard'  — daemon not bound to any team -> interactive wizard
// 'mismatch'       — daemon bound to a different team -> force reset wizard
// 'starting'       — onboarded to this team but daemon down/token-stale -> auto-recovering
// 'ready'          — onboarded to this team, running, token valid
// 'error'          — auto-recovery failed -> show retry
export type OnboardingStatus = 'unknown' | 'needs-onboard' | 'mismatch' | 'starting' | 'ready' | 'error'
export type Visibility = 'team' | 'personal'

export type OwnedAgent = { agentId: string; displayName: string; visibility: string }

/** Pure status from daemon-bound teamId vs the logged-in current teamId. */
export function computeOnboardingStatus(
  daemonTeamId: string | null,
  currentTeamId: string | null,
): OnboardingStatus {
  if (!currentTeamId) return 'unknown'
  if (!daemonTeamId) return 'needs-onboard'
  return daemonTeamId === currentTeamId ? 'ready' : 'mismatch'
}

type DaemonOnboardingState = {
  status: OnboardingStatus
  loaded: boolean
  busy: boolean
  error: string | null
  ownedAgents: OwnedAgent[]
  /** The local daemon's cloud session was terminally rejected (refresh token
   * dead). Drives the "reconnecting" banner; the daemon can't advertise its
   * backends or sync until re-onboarded. */
  cloudAuthExpired: boolean
  /** An auto re-onboard is in flight (mint re-invite → amuxd init → restart). */
  healing: boolean
  /** Last auto-heal failure (e.g. caller doesn't own the agent). Non-null
   * suppresses further automatic attempts; the banner offers a manual retry. */
  healError: string | null
  refresh: () => Promise<void>
  loadOwnedAgents: () => Promise<void>
  createNewAgent: (name: string, visibility: Visibility) => Promise<void>
  bindExistingAgent: (agentId: string, displayName: string) => Promise<void>
  forceReset: () => Promise<void>
  /** Poll the daemon's cloud-auth health; auto-heal once when terminally expired. */
  checkCloudSession: () => Promise<void>
  /** Re-onboard the local daemon in place (same actor) to restore credentials. */
  autoHealCloudSession: () => Promise<void>
}

async function daemonTeamId(): Promise<string | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return (await invoke<string | null>('get_daemon_team_id')) ?? null
}

/** Run create-invite → amuxd init → install-service. Returns the claimed agentId. */
async function onboard(teamId: string, displayName: string, targetActorId: string | null): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  const invite = await getBackend().teams.createTeamInvite({
    teamId,
    kind: 'agent',
    displayName,
    agentKind: 'claude',
    // Short TTL: this invite is claimed immediately by `amuxd init`; a tight
    // window avoids leaving orphan agent invites if init fails.
    ttlSeconds: 600,
    targetActorId,
  })
  // Carry this app's effective Cloud API endpoint into the invite so the daemon
  // talks to the same backend the desktop build/runtime resolved — otherwise it
  // falls back to its own hardcoded default and diverges in non-prod builds.
  const { getEffectiveServerConfig } = await import('@/lib/server-config')
  const cloudApiUrl = (await getEffectiveServerConfig()).cloudApiUrl
  let inviteUrl = `${appScheme}://invite?token=${encodeURIComponent(invite.token)}`
  if (cloudApiUrl) {
    inviteUrl += `&cloud_api_url=${encodeURIComponent(cloudApiUrl)}`
  }
  const result = await invoke<{ actorId: string; teamId: string }>('daemon_init', { inviteUrl })
  // `daemon_init` already claimed the invite and wrote fresh credentials — the
  // actor is onboarded to the team at this point. `install-service` only
  // registers the launchd background service, which fails when the amuxd binary
  // isn't deployed to ~/.amuxd/bin (e.g. a dev daemon run via `cargo run`/pnpm).
  // Don't fail the whole onboard over it: that would trap the user in the wizard
  // even though the team binding succeeded. The caller's refresh()/ensureHealthy
  // verifies the running daemon and surfaces a real problem if it isn't healthy.
  try {
    await invoke('daemon_install_service')
  } catch (e) {
    console.warn('[daemon-onboarding] install-service failed (non-fatal):', e)
  }
  return result.actorId
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The daemon is onboarded to the current team — ensure it's actually running with a
 * valid token. Auto-recover (start/restart) and poll until healthy. Returns true if ready. */
async function ensureHealthy(): Promise<boolean> {
  let probe = await probeDaemonHttp()
  if (probe.ok) return true
  // not_running / port_file_missing / token_invalid all recover the same way:
  // (re)register + (re)start the service (install-service kickstarts an already-loaded
  // job, so a stale token gets rewritten). Then poll — the daemon needs a moment to
  // bind its port and write fresh ~/.amuxd/amuxd.http.{port,token}.
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('daemon_install_service')
  } catch {
    /* fall through to polling; surfacing the probe failure is more useful */
  }
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    invalidateDaemonConnection()
    probe = await probeDaemonHttp()
    if (probe.ok) return true
  }
  return false
}

/**
 * Register the user's active workspace in the daemon registry + cloud when it is
 * a real project directory. The old default (`~/.amuxd/teams/<teamId>`) must
 * never be registered — that path is the global sync store, not a workspace.
 */
async function ensureDefaultWorkspaceRegistered(teamId: string | null): Promise<void> {
  if (!isTauri() || !teamId) return
  const { useWorkspaceStore } = await import('@/stores/workspace')
  const workspacePath = useWorkspaceStore.getState().workspacePath
  if (!workspacePath || workspacePath.includes('/.amuxd/')) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('register_daemon_workspace', { workspacePath })
  } catch (e) {
    console.warn('[daemon-onboarding] workspace registration failed (non-critical)', e)
  }
}

export const useDaemonOnboardingStore = create<DaemonOnboardingState>((set, get) => ({
  status: 'unknown',
  loaded: false,
  busy: false,
  error: null,
  ownedAgents: [],
  cloudAuthExpired: false,
  healing: false,
  healError: null,

  refresh: async () => {
    if (!isTauri()) {
      set({ status: 'ready', loaded: true })
      return
    }
    markStartup('daemon-refresh:start')
    const currentTeamId = useCurrentTeamStore.getState().team?.id ?? null
    const dTeam = await daemonTeamId()
    markStartup('daemon-teamid:end')
    const base = computeOnboardingStatus(dTeam, currentTeamId)
    if (base !== 'ready') {
      // unknown / needs-onboard / mismatch — team-level, handled by the wizard.
      set({ status: base, loaded: true })
      markStartup('daemon-refresh:end')
      return
    }
    // Onboarded to the current team: also verify running + token valid, auto-recover.
    const first = await probeDaemonHttp()
    markStartup('daemon-refresh:end')
    if (first.ok) {
      set({ status: 'ready', loaded: true })
      // Daemon and actor share a team — ensure the default team workspace is
      // registered locally + in the cloud (idempotent, best-effort).
      void ensureDefaultWorkspaceRegistered(currentTeamId)
      // The daemon process is up, but its *cloud* session may be dead (refresh
      // token rejected) — detect and auto re-onboard so it can advertise its
      // backends + sync again. Best-effort; never blocks `ready`.
      void get().checkCloudSession()
      return
    }
    set({ status: 'starting', loaded: true, error: null })
    let ok = await ensureHealthy()
    if (!ok) ok = await ensureHealthy()
    set({
      status: ok ? 'ready' : 'error',
      loaded: true,
      error: ok
        ? null
        : i18n.t(
            'settings.daemonOnboarding.startFailed',
            'Failed to start the background service. Make sure it can run on this machine, then retry.',
          ),
    })
    if (ok) void ensureDefaultWorkspaceRegistered(currentTeamId)
  },

  loadOwnedAgents: async () => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    const rows = await getBackend().actors.listConnectedAgents(teamId)
    set({
      ownedAgents: rows
        .filter((r) => r.is_owner)
        .map((r) => ({
          agentId: r.agent_id ?? r.id,
          displayName: r.display_name ?? '',
          visibility: r.visibility ?? 'team',
        })),
    })
  },

  createNewAgent: async (name, visibility) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) { set({ error: 'no current team' }); return }
    set({ busy: true, error: null })
    try {
      const agentId = await onboard(teamId, name, null)
      if (visibility === 'personal') {
        await getBackend().actors.makeAgentPersonal(agentId)
      }
      await adoptAsDefaultAgentIfUnset(teamId, agentId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  bindExistingAgent: async (agentId, displayName) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) { set({ error: 'no current team' }); return }
    set({ busy: true, error: null })
    try {
      const claimedAgentId = await onboard(teamId, displayName, agentId)
      await adoptAsDefaultAgentIfUnset(teamId, claimedAgentId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  forceReset: async () => {
    if (!isTauri()) return
    set({ busy: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('daemon_clear')
      // Optimistically clear the mismatch screen while refresh re-resolves.
      set({ status: 'unknown' })
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  checkCloudSession: async () => {
    if (!isTauri()) return
    const status = await fetchDaemonCloudAuthStatus()
    if (status !== 'expired') {
      // Healthy / unknown (older daemon or transient) — clear any stale banner.
      if (get().cloudAuthExpired) set({ cloudAuthExpired: false })
      return
    }
    set({ cloudAuthExpired: true })
    // Auto-heal exactly once. A prior failure (`healError`) or an in-flight heal
    // suppresses further automatic attempts so a non-owner daemon never spins;
    // the banner's retry button drives subsequent attempts explicitly.
    if (!get().healing && !get().healError) {
      await get().autoHealCloudSession()
    }
  },

  autoHealCloudSession: async () => {
    if (!isTauri() || get().healing) return
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    set({ healing: true, healError: null })
    try {
      const actorId = await getLocalDaemonActorId()
      if (!actorId) throw new Error('daemon actor id unavailable')
      // Re-inviting an existing actor requires ownership (FC enforces it). If
      // this user doesn't own the daemon, surface manual guidance instead.
      await get().loadOwnedAgents()
      const owned = get().ownedAgents.find((a) => a.agentId === actorId)
      if (!owned) {
        set({
          healError: i18n.t(
            'settings.daemonOnboarding.cloudExpiredNotOwner',
            'This daemon’s cloud session expired and only its owner can reconnect it. Re-onboard it from the owning account.',
          ),
        })
        return
      }
      // Mint a re-invite for the SAME actor (rebind, no orphan), run `amuxd
      // init` to write fresh credentials, then install-service kickstarts the
      // running daemon (`launchctl kickstart -k`) so it reloads backend.toml.
      await onboard(teamId, owned.displayName, actorId)
      invalidateDaemonConnection()
      set({ cloudAuthExpired: false })
      await get().refresh()
    } catch (e) {
      set({ healError: String(e) })
    } finally {
      set({ healing: false })
    }
  },
}))
