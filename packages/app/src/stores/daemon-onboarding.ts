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
import { markStartup } from '@/lib/startup-perf'
import { appScheme } from '@/lib/build-config'
import {
  clearDaemonOnboardingIdentity,
  readDaemonOnboardingIdentity,
  writeDaemonOnboardingIdentity,
} from '@/lib/daemon-onboarding-identity'
import { useAuthStore } from '@/stores/auth-store'

/**
 * Adopt the machine's freshly bound agent as the user's default.
 *
 * Unconditional, unlike the old "only if unset": binding is no longer something
 * the user did, so there is no explicit choice to protect. Leaving a stale
 * default in place would point every new message at whichever agent the member
 * last had — including one that this machine has just stopped being.
 *
 * Best-effort: failures here must not fail the binding.
 */
async function adoptDeviceAgentAsDefault(teamId: string, agentId: string): Promise<void> {
  try {
    const prefs = useMemberPreferencesStore.getState()
    await prefs.ensureLoaded(teamId)
    if (useMemberPreferencesStore.getState().defaultAgentId !== agentId) {
      await useMemberPreferencesStore.getState().setDefaultAgent(teamId, agentId)
    }
  } catch (e) {
    console.warn('[daemon-onboarding] could not set local daemon as default agent', e)
  }
}

// 'unknown'        — no current team yet (don't block)
// 'needs-onboard'  — daemon bound to no team -> bind silently
// 'mismatch'       — daemon bound to a different team -> re-bind silently
// 'starting'       — binding, or bound to this team but daemon down/token-stale
// 'ready'          — bound to this team, running, token valid
// 'error'          — binding or auto-recovery failed -> show retry
//
// 'needs-onboard' and 'mismatch' are no longer screens. They are the two inputs
// that make `refresh` bind this machine's agent, and the user sees 'starting'
// while it happens. They stay in the type because they are still the honest
// description of what the daemon's config says.
export type OnboardingStatus = 'unknown' | 'needs-onboard' | 'mismatch' | 'starting' | 'ready' | 'error'

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
  /** The local daemon's cloud session was terminally rejected (refresh token
   * dead). Drives the "reconnecting" banner; the daemon can't advertise its
   * backends or sync until re-onboarded. */
  cloudAuthExpired: boolean
  /** An auto re-onboard is in flight (mint re-invite → amuxd init → restart). */
  healing: boolean
  /** Last auto-heal failure (e.g. caller doesn't own the agent). Non-null
   * suppresses further automatic attempts; the banner offers a manual retry. */
  healError: string | null
  /**
   * Set when this machine has no agent in the current team yet, i.e. the one case
   * that still asks the user something: name your new robot. Binding waits for
   * `nameDeviceAgent`, because the name can only be applied at creation.
   *
   * Null at every other moment, including every rebind — that path is silent.
   */
  pendingName: { teamId: string; deviceId: string; suggested: string } | null
  /** Create this machine's agent under `name` and finish binding. */
  nameDeviceAgent: (name: string) => Promise<void>
  /** `forceIdentityRebind` re-binds even when the daemon already points at the
   * current team — used after a linked-account switch, where the team is the same
   * but the authority behind the daemon's credentials is not. A team *change*
   * needs no flag: a mismatch always re-binds now. */
  refresh: (opts?: { forceIdentityRebind?: boolean }) => Promise<void>
  /** Wipe local daemon state. Settings-only (DaemonManualResetCard); the next
   * `refresh` re-binds this machine silently. */
  forceReset: () => Promise<void>
  /** Poll the daemon's cloud-auth health; auto-heal once when terminally expired. */
  checkCloudSession: (opts?: { allowRetryAfterHealError?: boolean }) => Promise<void>
  /** Re-onboard the local daemon in place (same actor) to restore credentials. */
  autoHealCloudSession: () => Promise<void>
}

async function daemonTeamId(): Promise<string | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return (await invoke<string | null>('get_daemon_team_id')) ?? null
}

function currentAuthUserId(): string | null {
  return useAuthStore.getState().session?.user?.id ?? null
}

function rememberDaemonIdentity(teamId: string): void {
  const userId = currentAuthUserId()
  if (userId) writeDaemonOnboardingIdentity({ teamId, userId })
}

/** The machine's own name, used as the agent's display name. */
async function deviceDisplayName(): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  const host = (await invoke<string>('get_device_hostname'))?.trim()
  // A nameless machine would create an agent called "" — the server rejects that,
  // so fall back to something a human can still recognize in the actor list.
  return host || 'Local daemon'
}

/** This machine's id, as the daemon reports it. Throws rather than inventing one. */
async function requireDeviceId(): Promise<string> {
  const { fetchDaemonDeviceId } = await import('@/lib/daemon-local-client')
  const deviceId = await fetchDaemonDeviceId()
  if (!deviceId) {
    // Deliberately fatal rather than falling back to a generated id: a fresh id
    // means the server sees an unknown machine and provisions a *second* agent
    // for a machine that already has one.
    throw new Error(
      i18n.t(
        'settings.daemonOnboarding.deviceIdUnavailable',
        "Can't read this machine's id from the local daemon. Make sure amuxd is running, then retry.",
      ),
    )
  }
  return deviceId
}

/**
 * Bind this machine's agent in `teamId` and rotate the daemon onto it.
 *
 * `displayName` is only consulted when the agent has to be created — the caller
 * has already looked the machine up (see `refresh`) and asked the user to name it
 * in that case. A rebind never renames: the user's chosen name outlives it.
 *
 * Replaces asking the user to pick team-vs-personal visibility, choose between
 * creating and binding, or reset a machine that belonged to another team.
 */
async function bindDeviceAgent(
  teamId: string,
  deviceId: string,
  displayName: string,
): Promise<{ agentId: string; created: boolean }> {
  const { invoke } = await import('@tauri-apps/api/core')
  const invite = await getBackend().actors.ensureAgentForDevice({
    teamId,
    deviceId,
    displayName,
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
  // actor is onboarded to the team at this point. Restart the desktop-managed
  // amuxd so it reloads backend.toml. Failure here means credentials are on
  // disk but the running daemon may still hold the old identity — treat as
  // onboard failure. No `daemon_ensure_running` fallback: ensure is a no-op
  // when a (stale) daemon is already healthy, which would fake success.
  await invoke('daemon_restart_managed')
  rememberDaemonIdentity(teamId)
  invalidateDaemonConnection()
  // The machine's agent is now this member's default recipient. Unconditional:
  // see adoptDeviceAgentAsDefault.
  await adoptDeviceAgentAsDefault(teamId, invite.agentId)
  if (result.actorId !== invite.agentId) {
    // The daemon reports which actor it claimed; if that disagrees with what the
    // server bound, later calls would address the wrong agent. Loud, because the
    // silent path has no user watching it.
    console.error(
      '[daemon-onboarding] claimed actor does not match the bound device agent',
      { claimed: result.actorId, bound: invite.agentId },
    )
  }
  return { agentId: invite.agentId, created: invite.created }
}

/**
 * Error copy for a failed bind.
 *
 * Deliberately not the "failed to start the local daemon" string: binding fails
 * for reasons that have nothing to do with the daemon starting (the Cloud API
 * refused, the machine id was unreadable, the team membership was gone), and
 * telling the user to check whether amuxd can run sends them somewhere useless.
 * Silent binding makes this worse than it used to be — nobody clicked anything,
 * so the message is all they have.
 */
function bindErrorMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e)
  return i18n.t(
    'settings.daemonOnboarding.bindFailed',
    "Couldn't set up this machine's agent: {{detail}}",
    { detail },
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** After re-onboard, wait until `/v1/info` reports a healthy cloud session. */
async function waitForDaemonCloudAuthOk(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await fetchDaemonCloudAuthStatus()
    if (status === 'ok') return true
    if (status === 'expired') return false
    await sleep(500)
  }
  return (await fetchDaemonCloudAuthStatus()) === 'ok'
}

/** The daemon is onboarded to the current team — ensure it's actually running with a
 * valid token. Auto-recover (start/restart) and poll until healthy. Returns true if ready. */
async function ensureHealthy(): Promise<boolean> {
  let probe = await probeDaemonHttp()
  if (probe.ok) return true
  // Desktop-managed amuxd: restart the sidecar held by the desktop process
  // (compat command `daemon_install_service` now maps to the same restart).
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('daemon_ensure_running')
  } catch {
    try {
      await invoke('daemon_restart_managed')
    } catch {
      /* fall through to polling */
    }
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
  // Official `~/.amuxd/...` and white-label `~/.amuxd-<brand>/...` are daemon
  // state dirs, not user project workspaces.
  if (!workspacePath || /\/\.amuxd(-[^/]+)?\//.test(workspacePath)) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('register_daemon_workspace', { workspacePath })
  } catch (e) {
    console.warn('[daemon-onboarding] workspace registration failed (non-critical)', e)
  }
}

/** Cloud upsert via `POST /v1/workspaces` needs a live daemon cloud session. */
async function maybeRegisterDefaultWorkspace(teamId: string | null): Promise<void> {
  if (!isTauri() || !teamId) return
  if (useDaemonOnboardingStore.getState().cloudAuthExpired) return
  const auth = await fetchDaemonCloudAuthStatus()
  if (auth !== 'ok') return
  await ensureDefaultWorkspaceRegistered(teamId)
}

export const useDaemonOnboardingStore = create<DaemonOnboardingState>((set, get) => {
  /**
   * Look this machine up in `teamId`, then either bind it silently or park a name
   * prompt. Returns 'bound' | 'prompting'; throws on failure so each caller
   * decides how to report it.
   *
   * Every binding path funnels through here so that "the user is only ever asked
   * on first creation" holds for all three of them: a fresh machine, a machine
   * arriving from another team, and a linked-account switch.
   */
  const bindOrPrompt = async (teamId: string): Promise<'bound' | 'prompting'> => {
    const deviceId = await requireDeviceId()
    const existing = await getBackend().actors.findAgentForDevice({ teamId, deviceId })
    if (!existing.agentId) {
      set({
        pendingName: { teamId, deviceId, suggested: await deviceDisplayName() },
      })
      // Binding resumes in nameDeviceAgent. Nothing is written until then, so
      // abandoning this screen leaves no half-created agent behind.
      return 'prompting'
    }
    // The stored name is passed through only to satisfy the API's create path;
    // ensure-for-device ignores it for an agent that already exists.
    await bindDeviceAgent(teamId, deviceId, existing.displayName || (await deviceDisplayName()))
    return 'bound'
  }

  return {
  status: 'unknown',
  loaded: false,
  busy: false,
  error: null,
  cloudAuthExpired: false,
  healing: false,
  healError: null,
  pendingName: null,

  nameDeviceAgent: async (name) => {
    const pending = get().pendingName
    if (!pending) return
    const displayName = name.trim() || pending.suggested
    set({ status: 'starting', busy: true, error: null, pendingName: null })
    try {
      await bindDeviceAgent(pending.teamId, pending.deviceId, displayName)
    } catch (e) {
      // Put the prompt back: the name the user typed was never applied, so
      // dropping it would leave the retry button creating an unnamed agent.
      set({ status: 'error', error: bindErrorMessage(e), pendingName: pending })
      return
    } finally {
      set({ busy: false })
    }
    await get().refresh()
  },

  refresh: async (opts) => {
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
      // 'unknown' means no current team yet — there is nothing to bind to, and
      // the auth gate lets it through rather than blocking on it.
      if (base === 'unknown' || !currentTeamId) {
        set({ status: base, loaded: true })
        markStartup('daemon-refresh:end')
        return
      }
      // 'needs-onboard' (fresh machine) and 'mismatch' (bound to another team)
      // are the same job: get this machine's agent in the current team and rotate
      // the daemon onto it. amuxd is single-team, so the previous team's agent is
      // left intact — switching back finds it again by device id instead of
      // creating another.
      //
      // Look up before binding. A machine the team already knows is bound with no
      // interaction; a machine it does not gets to ask the user for a name, which
      // can only be applied at creation.
      set({ status: 'starting', loaded: true, busy: true, error: null })
      let outcome: 'bound' | 'prompting'
      try {
        outcome = await bindOrPrompt(currentTeamId)
      } catch (e) {
        set({ status: 'error', loaded: true, error: bindErrorMessage(e) })
        return
      } finally {
        set({ busy: false })
      }
      if (outcome === 'prompting') {
        markStartup('daemon-refresh:end')
        return
      }
      // Re-read daemon.toml and health after init/restart before releasing the
      // auth gate to the chat UI.
      await get().refresh()
      return
    }
    const currentUserId = currentAuthUserId()
    const recorded = readDaemonOnboardingIdentity()
    // Same team does not imply the same daemon authority: a linked-account switch
    // leaves the daemon holding credentials minted by the other account. Re-bind
    // before it publishes commands/workspaces under the wrong authority.
    //
    // Only the recorded identity is consulted. The old code also asked the Cloud
    // API whether this user owned the local actor, to cover installs predating
    // the record; that check is what `ensure-for-device` now does server-side —
    // an agent owned by someone else counts as absent and this account gets its
    // own.
    const identityChanged = !!currentUserId && !!(
      opts?.forceIdentityRebind ||
      (recorded?.teamId === currentTeamId && recorded.userId !== currentUserId)
    )
    if (identityChanged) {
      set({ status: 'starting', loaded: true, busy: true, error: null })
      let outcome: 'bound' | 'prompting'
      try {
        outcome = await bindOrPrompt(currentTeamId!)
      } catch (e) {
        set({ status: 'error', loaded: true, error: bindErrorMessage(e) })
        return
      } finally {
        set({ busy: false })
      }
      // The newly selected account may own no agent for this machine — it names
      // its own rather than inheriting the other account's.
      if (outcome === 'prompting') {
        markStartup('daemon-refresh:end')
        return
      }
    }
    // Onboarded to the current team: also verify running + token valid, auto-recover.
    const first = await probeDaemonHttp()
    markStartup('daemon-refresh:end')
    if (first.ok) {
      set({ status: 'ready', loaded: true })
      // Heal the daemon's cloud session before workspace upsert — otherwise
      // `POST /v1/workspaces` fails with 500 while the refresh token is dead.
      await get().checkCloudSession()
      await maybeRegisterDefaultWorkspace(currentTeamId)
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
            'Failed to start the local daemon. Make sure it can run on this machine, then retry.',
          ),
    })
    if (ok) {
      await get().checkCloudSession()
      await maybeRegisterDefaultWorkspace(currentTeamId)
    }
  },

  forceReset: async () => {
    if (!isTauri()) return
    set({ busy: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('daemon_clear')
      clearDaemonOnboardingIdentity()
      // Verify rather than assume. `amuxd clear` exiting 0 does not prove the
      // binding is gone — the config dir has been resurrected from the legacy
      // dir before, and a live daemon can rewrite the file. Without this check
      // the wizard just re-renders the same "belongs to another team" screen
      // with no error, which reads as a dead button.
      const stillBound = await daemonTeamId()
      if (stillBound) {
        set({
          error: i18n.t(
            'settings.daemonOnboarding.resetIncomplete',
            'Reset did not take effect: this machine is still bound to team {{teamId}}. Check ~/.amuxd/amuxd.managed.log.',
            { teamId: stillBound },
          ),
        })
        return
      }
      // Optimistically clear the mismatch screen while refresh re-resolves.
      set({ status: 'unknown' })
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  checkCloudSession: async (opts?: { allowRetryAfterHealError?: boolean }) => {
    if (!isTauri()) return
    const status = await fetchDaemonCloudAuthStatus()
    if (status !== 'expired') {
      // Healthy / unknown (older daemon or transient) — clear any stale banner.
      if (get().cloudAuthExpired) set({ cloudAuthExpired: false })
      return
    }
    set({ cloudAuthExpired: true })
    if (opts?.allowRetryAfterHealError) set({ healError: null })
    // Auto-heal exactly once. A prior failure (`healError`) or an in-flight heal
    // suppresses further automatic attempts so a non-owner daemon never spins;
    // the banner's retry button drives subsequent attempts explicitly.
    if (!get().healing && (!get().healError || opts?.allowRetryAfterHealError)) {
      await get().autoHealCloudSession()
    }
  },

  autoHealCloudSession: async () => {
    if (!isTauri() || get().healing) return
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    set({ healing: true, healError: null })
    try {
      // Re-bind by device id: the lookup lands on the actor this machine is
      // already running as, and `amuxd init` rotates fresh credentials onto it.
      // No ownership pre-check is needed — that used to be a client-side guess at
      // what create_team_invite enforces. The one case where the lookup comes back
      // empty is a machine now signed in as a different account, and that account
      // names its own agent rather than seeing an error it cannot act on.
      const outcome = await bindOrPrompt(teamId)
      if (outcome === 'prompting') {
        // The naming screen owns the rest; the banner should stop claiming a heal
        // is in flight.
        return
      }
      const authOk = await waitForDaemonCloudAuthOk()
      set({ cloudAuthExpired: !authOk })
      await get().refresh()
    } catch (e) {
      set({ healError: bindErrorMessage(e) })
    } finally {
      set({ healing: false })
    }
  },
  }
})
