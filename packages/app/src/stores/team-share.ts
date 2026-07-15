import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'
import { getFreshAccessToken } from '@/lib/auth/session-store'
import { linkDaemonTeamWorkspace } from '@/lib/daemon-local-client'

// ---------------------------------------------------------------------------
// Types — mirror FC GET /v1/teams/:id/share-mode response (camelCase JSON)
// ---------------------------------------------------------------------------

export type ShareMode = 'oss' | 'managed_git' | 'custom_git' | null

export type LockedShareMode = Exclude<ShareMode, null>

export function isShareModeLocked(
  mode: ShareMode | undefined | null,
): mode is LockedShareMode {
  return mode === 'oss' || mode === 'managed_git' || mode === 'custom_git'
}

/** Match daemon: when FC mode is unset, ignore stray git fields in the payload. */
export function normalizeShareStatus(raw: Partial<ShareStatus>): ShareStatus {
  const mode = (raw?.mode ?? null) as ShareMode
  if (!isShareModeLocked(mode)) {
    return {
      mode: null,
      gitRemoteUrl: null,
      gitAuthKind: null,
      enabledAt: null,
      linkStatus: raw?.linkStatus,
      globalPath: raw?.globalPath ?? null,
    }
  }
  return {
    mode,
    gitRemoteUrl: raw?.gitRemoteUrl ?? null,
    gitAuthKind: raw?.gitAuthKind ?? null,
    enabledAt: raw?.enabledAt ?? null,
    linkStatus: raw?.linkStatus,
    globalPath: raw?.globalPath ?? null,
  }
}

// What the workspace `teamclaw-team` entry currently is, as reported by the
// daemon-aware `team_share_get_status` command.
export type LinkStatus = 'symlink' | 'real_dir' | 'missing'

export interface ShareStatus {
  mode: ShareMode
  gitRemoteUrl?: string | null
  gitAuthKind?: string | null
  enabledAt?: string | null
  // Per-workspace link to the daemon's single global copy, and where that
  // global copy lives on disk (~/.amuxd/teams/<team_id>/teamclaw-team).
  linkStatus?: LinkStatus
  globalPath?: string | null
}

/** Matches Rust `GitEnableInput` (`#[serde(rename_all = "camelCase")]`). */
export interface CustomGitInput {
  remoteUrl: string
  authKind: 'ssh_key' | 'https_token'
  credential: string
  branch?: string
}

// Result of an enable_* command (matches Rust `EnableShareResult`).
export interface EnableShareResult {
  teamId: string
  shareMode: string
  cloneWarning?: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface TeamShareState {
  status: ShareStatus
  loading: boolean
  lastError: string | null

  refresh(teamId: string, workspacePath: string): Promise<ShareStatus>
  enableOss(
    teamId: string,
    workspacePath: string,
    teamSecretHex?: string,
  ): Promise<EnableShareResult>
  enableManagedGit(
    teamId: string,
    workspacePath: string,
    teamSecretHex?: string,
  ): Promise<EnableShareResult>
  enableCustomGit(
    teamId: string,
    workspacePath: string,
    input: CustomGitInput,
    teamSecretHex?: string,
  ): Promise<EnableShareResult>
  setSecret(
    teamId: string,
    secretHex: string,
    workspacePath: string,
  ): Promise<void>
  /** Read back the locally-stored team secret; `null` when none is saved. */
  getSecret(teamId: string, workspacePath: string): Promise<string | null>
  /** Local teardown + cloud share-mode reset → wizard can run again. */
  disconnect(teamId: string, workspacePath: string): Promise<void>
}

const EMPTY_STATUS: ShareStatus = {
  mode: null,
  gitRemoteUrl: null,
  gitAuthKind: null,
  enabledAt: null,
}

/** Coalesce concurrent refresh calls for the same team + workspace. */
let shareRefreshInflight: Promise<ShareStatus> | null = null
let shareRefreshInflightKey: string | null = null

export const useTeamShareStore = create<TeamShareState>((set, get) => ({
  status: EMPTY_STATUS,
  loading: false,
  lastError: null,

  async refresh(teamId, workspacePath) {
    if (!isTauri()) return { ...EMPTY_STATUS }

    const key = `${teamId}\0${workspacePath}`
    if (shareRefreshInflight && shareRefreshInflightKey === key) {
      return shareRefreshInflight
    }

    shareRefreshInflightKey = key
    shareRefreshInflight = (async () => {
      // Keep the previous status visible while loading — clearing to EMPTY here
      // made TeamSection flip TeamGitConfig ↔ TeamShareSection and spam daemon APIs.
      set({ loading: true, lastError: null })
      try {
        const accessToken = await getFreshAccessToken()
        const raw = await invoke<ShareStatus>('team_share_get_status', {
          teamId,
          workspacePath,
          accessToken,
        })
        const next = normalizeShareStatus({
          mode: (raw?.mode ?? null) as ShareMode,
          gitRemoteUrl: raw?.gitRemoteUrl ?? null,
          gitAuthKind: raw?.gitAuthKind ?? null,
          enabledAt: raw?.enabledAt ?? null,
          linkStatus: raw?.linkStatus,
          globalPath: raw?.globalPath ?? null,
        })
        set({ status: next })
        return next
      } catch (e) {
        set({ lastError: String(e), status: { ...EMPTY_STATUS } })
        return { ...EMPTY_STATUS }
      } finally {
        set({ loading: false })
        shareRefreshInflight = null
        shareRefreshInflightKey = null
      }
    })()

    return shareRefreshInflight
  },

  async enableOss(teamId, workspacePath, teamSecretHex) {
    const accessToken = await getFreshAccessToken()
    const res = await invoke<EnableShareResult>('team_share_enable_oss', {
      teamId,
      workspacePath,
      accessToken,
      teamSecretHex: teamSecretHex?.trim() || null,
    })
    // Materialize the daemon's global dir + workspace symlink now (best-effort)
    // so the synced directory exists immediately instead of after a restart.
    await linkDaemonTeamWorkspace(workspacePath)
    await get().refresh(teamId, workspacePath)
    return res
  },

  async enableManagedGit(teamId, workspacePath, teamSecretHex) {
    const accessToken = await getFreshAccessToken()
    const res = await invoke<EnableShareResult>(
      'team_share_enable_managed_git',
      {
        teamId,
        workspacePath,
        accessToken,
        teamSecretHex: teamSecretHex?.trim() || null,
      },
    )
    await linkDaemonTeamWorkspace(workspacePath)
    await get().refresh(teamId, workspacePath)
    return res
  },

  async enableCustomGit(teamId, workspacePath, input, teamSecretHex) {
    const accessToken = await getFreshAccessToken()
    const res = await invoke<EnableShareResult>(
      'team_share_enable_custom_git',
      {
        teamId,
        workspacePath,
        input,
        accessToken,
        teamSecretHex: teamSecretHex?.trim() || null,
      },
    )
    await linkDaemonTeamWorkspace(workspacePath)
    await get().refresh(teamId, workspacePath)
    return res
  },

  async setSecret(teamId, secretHex, workspacePath) {
    await invoke<void>('team_share_set_team_secret', {
      teamId,
      secretHex,
      workspacePath,
    })
  },

  async getSecret(teamId, workspacePath) {
    if (!isTauri()) return null
    try {
      const secret = await invoke<string | null>('team_share_get_team_secret', {
        teamId,
        workspacePath,
      })
      return secret ?? null
    } catch {
      return null
    }
  },

  async disconnect(teamId, workspacePath) {
    if (!isTauri()) {
      throw new Error('Team share disconnect requires the desktop app')
    }
    const accessToken = await getFreshAccessToken()
    await invoke<{ success: boolean; message: string }>('team_disconnect_repo', {
      teamId,
      workspacePath,
      accessToken,
    })
    set({ status: { ...EMPTY_STATUS }, lastError: null })
    try {
      const { useTeamModeStore } = await import('@/stores/team-mode')
      await useTeamModeStore.getState().clearTeamMode(workspacePath)
    } catch {
      // Best-effort: legacy team_mode cleared on disk by the Rust command.
    }
  },
}))
