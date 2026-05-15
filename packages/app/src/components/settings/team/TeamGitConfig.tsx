/**
 * TeamGitConfig - Git repository configuration UI.
 * Extracted from TeamSection.tsx.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users,
  GitBranch,
  Loader2,
  AlertCircle,
  RefreshCw,
  Unlink,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  KeyRound,
  ChevronRight,
  BookOpen,
  Settings,
  Save,
  Copy,
  Link,
} from 'lucide-react'
import { cn, isTauri, copyToClipboard } from '@/lib/utils'
import { ToggleSwitch } from '@/components/settings/shared'
import { TeamMemberList } from '@/components/settings/TeamMemberList'
import { DeviceIdDisplay } from '@/components/settings/DeviceIdDisplay'
import { HostLlmConfig } from './HostLlmConfig'
import { useTeamMembersStore } from '@/stores/team-members'
import { useWorkspaceStore } from '@/stores/workspace'
import { buildConfig, TEAM_SYNCED_EVENT, TEAM_REPO_DIR } from '@/lib/build-config'
import {
  buildTeamProviderConfig,
  loadTeamProviderFormState,
  removeTeamProviderFile,
  saveTeamProviderFile,
} from '@/lib/team-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { formatBytes, type SyncPrecheckFile } from './syncPrecheck'
import { supabase } from '@/lib/supabase-client'
import { upsertTeamWorkspaceConfig } from '@/lib/team-workspace-config'

// ─── Types ──────────────────────────────────────────────────────────────────

interface TeamConfig {
  gitUrl: string
  enabled: boolean
  lastSyncAt: string | null
  gitToken?: string | null
  gitBranch?: string | null
  teamId?: string | null
  fcEndpoint?: string | null
}

interface GitCheckResult {
  installed: boolean
  version: string | null
}

interface TeamGitResult {
  success: boolean
  message: string
  needsConfirmation?: boolean
  newFiles?: SyncPrecheckFile[]
  totalBytes?: number
}

type ConnectionState =
  | 'loading'
  | 'no-git'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'syncing'

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`Team feature requires ${buildConfig.app.name} desktop app (Tauri not available)`)
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// ─── Supabase create-team flow ──────────────────────────────────────────────

async function createTeam(args: {
  teamName: string
  gitUrl: string
  gitBranch?: string
  gitToken?: string
  aiGatewayEndpoint?: string
}): Promise<{ teamId: string; deeplink: string }> {
  // 1. Create team. Backend trigger inserts the owner actor + team_members row.
  const { data: created, error: createErr } = await supabase
    .rpc('create_team', { p_name: args.teamName })
    .single()
  if (createErr) throw new Error(createErr.message)
  const teamId = (created as { id: string }).id

  // 2. Insert workspace config.
  await upsertTeamWorkspaceConfig({
    teamId,
    gitUrl:            args.gitUrl,
    gitBranch:         args.gitBranch ?? 'main',
    gitToken:          args.gitToken ?? null,
    aiGatewayEndpoint: args.aiGatewayEndpoint ?? null,
    enabled:           true,
    updatedAt:         new Date().toISOString(),
  })

  // 3. First invite (admin role).
  const { data: invite, error: invErr } = await supabase.rpc('create_team_invite', {
    p_team_id:       teamId,
    p_kind:          'member',
    p_display_name:  'New Member',
    p_team_role:     'admin',
    p_ttl_seconds:   604800,
  })
  if (invErr) throw new Error(invErr.message)
  const deeplink = ((invite as { deeplink: string }).deeplink).replace(/^amux:/, 'teamclaw:')
  return { teamId, deeplink }
}

// ─── Reusable Components (local to git config) ─────────────────────────────

function SettingCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      "rounded-xl border bg-card p-5 transition-all",
      className
    )}>
      {children}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamGitConfig() {
  const { t } = useTranslation()
  const teamMembersStore = useTeamMembersStore()
  const myRole = useTeamMembersStore((s) => s.myRole)
  const canManageServiceConfig = myRole === 'owner' || myRole === 'manager'
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const workspaceReady = !!workspacePath
  const workspaceArgs = React.useMemo<{ workspacePath?: string }>(
    () => (workspacePath ? { workspacePath } : {}),
    [workspacePath],
  )
  const [deviceInfo, setDeviceInfo] = React.useState<{ nodeId: string } | null>(null)
  const [state, setState] = React.useState<ConnectionState>('loading')
  const [teamConfig, setTeamConfig] = React.useState<TeamConfig | null>(null)
  const [gitUrl, setGitUrl] = React.useState('')
  const [gitBranch, setGitBranch] = React.useState('')
  const [gitToken, setGitToken] = React.useState('')
  const [showToken, setShowToken] = React.useState(false)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [connectStep, setConnectStep] = React.useState('')
  const [disconnectDialogOpen, setDisconnectDialogOpen] = React.useState(false)
  const [repoGuideOpen, setRepoGuideOpen] = React.useState(false)
  const [precheckDialog, setPrecheckDialog] = React.useState<
    | null
    | { newFiles: SyncPrecheckFile[]; totalBytes: number }
  >(null)
  const [pendingUpdateUi, setPendingUpdateUi] = React.useState(true)

  // Create form state
  const [teamName, setTeamName] = React.useState('')

  // After creation: deeplink invite to share
  const [createdTeamId, setCreatedTeamId] = React.useState('')
  const [createdInviteDeeplink, setCreatedInviteDeeplink] = React.useState('')

  // Generate additional invite (connected state)
  const [additionalInviteDeeplink, setAdditionalInviteDeeplink] = React.useState('')
  const [generatingInvite, setGeneratingInvite] = React.useState(false)

  // LLM hosting (create form + connected editing share same state)
  const defaultLlmUrl = buildConfig.team.llm.baseUrl || ''
  const [hostLlm, setHostLlm] = React.useState(!!defaultLlmUrl)
  const [llmUrl, setLlmUrl] = React.useState(defaultLlmUrl)
  const defaultLlmModels = (buildConfig.team.llm.models ?? []).map((m) => ({ id: m.id, name: m.name }))
  const [llmModels, setLlmModels] = React.useState(defaultLlmModels)
  const [llmSaving, setLlmSaving] = React.useState(false)
  const [llmLoaded, setLlmLoaded] = React.useState(false)

  // Detect if current URL is HTTPS (needs token auth)
  const isHttpsUrl = gitUrl.trim().startsWith('https://') || gitUrl.trim().startsWith('http://')

  // ─── Initialize: check git + load config ─────────────────────────────────

  const initialize = React.useCallback(async () => {
    setState('loading')
    setErrorMessage(null)

    try {
      if (!isTauri()) {
        setState('unconfigured')
        return
      }

      // Wait for the workspace to be registered in backend state.
      // Otherwise get_team_config races startup and throws "No workspace path set".
      if (!workspacePath || !workspaceReady) {
        return
      }

      const gitCheck = await tauriInvoke<GitCheckResult>('team_check_git_installed')
      if (!gitCheck.installed) {
        setState('no-git')
        return
      }

      const config = await tauriInvoke<TeamConfig | null>('get_team_config', workspaceArgs)
      if (config) {
        setTeamConfig(config)
        setGitUrl(config.gitUrl)
        if (config.gitToken) setGitToken(config.gitToken)

        // Init shared secrets if team_id exists
        if (config.teamId) {
          try {
            await tauriInvoke('init_git_team_secrets', {
              teamId: config.teamId,
              ...workspaceArgs,
            })
          } catch (err) {
            console.warn('Failed to init shared secrets:', err)
          }
        }

        setState('connected')

        if (config.enabled) {
          performSync(false)
        }
      } else {
        setState('unconfigured')
      }
    } catch (err) {
      console.error('Team init error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [workspacePath, workspaceReady, workspaceArgs])

  React.useEffect(() => {
    initialize()
  }, [initialize])

  // Load current LLM config when connected
  React.useEffect(() => {
    if ((state === 'connected' || state === 'syncing') && !llmLoaded && isTauri()) {
      loadTeamProviderFormState(workspacePath!)
        .then((providerState) => {
          if (providerState) {
            setHostLlm(providerState.enabled)
            setLlmUrl(providerState.baseUrl)
            setLlmModels(providerState.models)
            return
          }
          return tauriInvoke<{ active: boolean; llm?: { baseUrl: string; model?: string; modelName?: string; models?: Array<{ id: string; name: string }> } }>('get_team_status', workspaceArgs)
            .then((status) => {
              if (status.llm?.baseUrl) {
                setHostLlm(true)
                setLlmUrl(status.llm.baseUrl)
                if (status.llm.models?.length) {
                  setLlmModels(status.llm.models)
                } else if (status.llm.model) {
                  setLlmModels([{ id: status.llm.model, name: status.llm.modelName || status.llm.model }])
                }
              }
            })
        })
        .catch(() => {})
      setLlmLoaded(true)
    }
  }, [state, llmLoaded, workspaceArgs])

  // Load members and device info when connected
  React.useEffect(() => {
    if ((state === 'connected' || state === 'syncing') && isTauri()) {
      teamMembersStore.loadMembers()
      teamMembersStore.loadMyRole()
      tauriInvoke<{ nodeId: string }>('get_device_info').then(setDeviceInfo).catch(() => {})
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveLlmConfig = async () => {
    setLlmSaving(true)
    setErrorMessage(null)
    try {
      await tauriInvoke('update_team_llm_config', {
        llmBaseUrl: hostLlm ? (llmUrl || null) : null,
        llmModel: hostLlm ? (llmModels[0]?.id || null) : null,
        llmModelName: hostLlm ? (llmModels[0]?.name || null) : null,
        llmModels: hostLlm && llmModels.length > 0 ? JSON.stringify(llmModels) : null,
        ...workspaceArgs,
      })
      if (workspacePath) {
        const providerConfig = buildTeamProviderConfig(hostLlm, llmUrl, llmModels)
        if (providerConfig) {
          await saveTeamProviderFile(workspacePath, providerConfig, llmModels[0]?.id)
        } else if (!hostLlm) {
          // Owner / manager explicitly turned off the team's shared LLM.
          // This is the ONLY path that should remove the shared provider
          // file — saveTeamProviderFile no longer auto-deletes on null.
          await removeTeamProviderFile(workspacePath)
        }
        // Otherwise: hostLlm=true but URL/models incomplete → leave the
        // existing provider.json intact instead of silently deleting it.
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLlmSaving(false)
    }
  }

  // ─── Create team flow (Supabase) ─────────────────────────────────────

  const handleCreate = async () => {
    if (!teamName.trim() || !gitUrl.trim()) return
    setState('connecting')
    setErrorMessage(null)
    try {
      setConnectStep(t('settings.team.creatingTeam', 'Creating team...'))
      const { teamId, deeplink } = await createTeam({
        teamName: teamName.trim(),
        gitUrl:   gitUrl.trim(),
        gitBranch: gitBranch.trim() || undefined,
        gitToken:  isHttpsUrl && gitToken.trim() ? gitToken.trim() : undefined,
      })

      setConnectStep(t('settings.team.initializingRepo', 'Initializing repository...'))
      const now = new Date().toISOString()
      const newConfig: TeamConfig = {
        gitUrl: gitUrl.trim(),
        enabled: true,
        lastSyncAt: now,
        teamId,
        ...(isHttpsUrl && gitToken.trim() ? { gitToken: gitToken.trim() } : {}),
        ...(gitBranch.trim() ? { gitBranch: gitBranch.trim() } : {}),
      }
      await tauriInvoke('save_team_config', { team: newConfig, ...workspaceArgs })
      if (workspacePath) {
        await saveTeamProviderFile(workspacePath, buildTeamProviderConfig(hostLlm, llmUrl, llmModels), hostLlm ? llmModels[0]?.id : undefined)
      }

      setTeamConfig(newConfig)
      setCreatedTeamId(teamId)
      setCreatedInviteDeeplink(deeplink)
      setState('connected')

    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setState('unconfigured')
    } finally {
      setConnectStep('')
    }
  }

  // ─── Generate additional invite ──────────────────────────────────────

  const handleGenerateInvite = async (teamId: string) => {
    setGeneratingInvite(true)
    setErrorMessage(null)
    try {
      const { data: invite, error: invErr } = await supabase.rpc('create_team_invite', {
        p_team_id:       teamId,
        p_kind:          'member',
        p_display_name:  'New Member',
        p_team_role:     'admin',
        p_ttl_seconds:   604800,
      })
      if (invErr) throw new Error(invErr.message)
      const deeplink = ((invite as { deeplink: string }).deeplink).replace(/^amux:/, 'teamclaw:')
      setAdditionalInviteDeeplink(deeplink)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setGeneratingInvite(false)
    }
  }

  // ─── Sync flow ─────────────────────────────────────────────────────

  const performSync = async (updateUi = true, force = false) => {
    if (updateUi) {
      setState('syncing')
    }
    setErrorMessage(null)

    try {
      const result = await tauriInvoke<TeamGitResult>('team_sync_repo', { force, ...workspaceArgs })

      if (result.needsConfirmation) {
        setPendingUpdateUi(updateUi)
        setPrecheckDialog({
          newFiles: result.newFiles ?? [],
          totalBytes: result.totalBytes ?? 0,
        })
        if (updateUi) {
          setState('connected')
        }
        return
      }

      if (!result.success) {
        console.warn('Team sync skipped:', result.message)
        if (updateUi) {
          setErrorMessage(result.message)
          setState('connected')
        }
        return
      }

      window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))

      const now = new Date().toISOString()
      const updatedConfig: TeamConfig = {
        ...teamConfig!,
        lastSyncAt: now,
      }
      await tauriInvoke('save_team_config', { team: updatedConfig, ...workspaceArgs })
      setTeamConfig(updatedConfig)
      const { useTeamModeStore } = await import('@/stores/team-mode')
      useTeamModeStore.setState({ teamGitLastSyncAt: now })

      if (updateUi) {
        setState('connected')
      }
    } catch (err) {
      console.error('Team sync error:', err)
      if (updateUi) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
        setState('connected')
      }
    }
  }

  // ─── Disconnect flow ───────────────────────────────────────────────

  const handleDisconnect = async () => {
    setDisconnectDialogOpen(false)
    setErrorMessage(null)

    try {
      await tauriInvoke<TeamGitResult>('team_disconnect_repo', workspaceArgs)
      await tauriInvoke('clear_team_config', workspaceArgs)

      setTeamConfig(null)
      setGitUrl('')
      setGitToken('')
      setState('unconfigured')
    } catch (err) {
      console.error('Team disconnect error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  // ─── Toggle enabled ──────────────────────────────────────────────────────

  const handleToggleEnabled = async (enabled: boolean) => {
    if (!teamConfig) return

    try {
      const updatedConfig: TeamConfig = { ...teamConfig, enabled }
      await tauriInvoke('save_team_config', { team: updatedConfig, ...workspaceArgs })
      setTeamConfig(updatedConfig)
    } catch (err) {
      console.error('Toggle error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  // ─── Format last sync time ───────────────────────────────────────────────

  const formatLastSync = (isoString: string | null) => {
    if (!isoString) return t('settings.team.never', 'Never')
    try {
      const date = new Date(isoString)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMins = Math.floor(diffMs / 60000)

      if (diffMins < 1) return t('settings.team.justNow', 'Just now')
      if (diffMins < 60) return t('settings.team.minutesAgo', { count: diffMins, defaultValue: `${diffMins}m ago` })
      const diffHours = Math.floor(diffMins / 60)
      if (diffHours < 24) return t('settings.team.hoursAgo', { count: diffHours, defaultValue: `${diffHours}h ago` })
      const diffDays = Math.floor(diffHours / 24)
      return t('settings.team.daysAgo', { count: diffDays, defaultValue: `${diffDays}d ago` })
    } catch {
      return isoString
    }
  }

  return (
    <>
      {/* Error Banner */}
      {errorMessage && (
        <SettingCard className="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-red-900 dark:text-red-100">{t('common.error', 'Error')}</p>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1 break-words">
                {errorMessage}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => setErrorMessage(null)}
            >
              ✕
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Loading State */}
      {state === 'loading' && (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      )}

      {/* Git Not Installed */}
      {state === 'no-git' && (
        <SettingCard>
          <div className="space-y-3">
            <h4 className="font-medium flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-yellow-500" />
              {t('settings.git.notAvailable', 'Git Not Available')}
            </h4>
            <p className="text-sm text-muted-foreground">
              {t('settings.team.gitInstallHint', 'Git CLI is not installed or not in PATH. Install git to enable team repository sharing:')}
            </p>
            <div className="bg-muted rounded-md p-3 font-mono text-xs">
              brew install git
            </div>
            <Button variant="outline" size="sm" onClick={initialize} className="gap-2">
              <RefreshCw className="h-3 w-3" />
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Unconfigured State - Create Team */}
      {(state === 'unconfigured' || state === 'connecting') && (
        <SettingCard>
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold text-foreground/90">{t('settings.team.createTeam', 'Create Team')}</h4>
          </div>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('settings.team.teamName', 'Team Name')}</label>
              <Input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="My Team"
                className="bg-background/50"
                disabled={state === 'connecting'}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('settings.team.gitUrl', 'Git Repository URL')}</label>
                <Input
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/team/shared-workspace.git"
                  className="bg-background/50 font-mono text-xs"
                  disabled={state === 'connecting'}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  {t('settings.team.gitBranch', 'Branch')}
                  <span className="text-muted-foreground/60 font-normal ml-1">({t('settings.team.optional', 'optional')})</span>
                </label>
                <Input
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                  placeholder="main"
                  className="bg-background/50"
                  disabled={state === 'connecting'}
                />
              </div>
            </div>
            {isHttpsUrl && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  {t('settings.team.personalToken', 'Personal Access Token')}
                  <span className="text-muted-foreground/60 font-normal ml-1">({t('settings.team.optional', 'optional')})</span>
                </label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    value={gitToken}
                    onChange={(e) => setGitToken(e.target.value)}
                    placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
                    className="bg-background/50 pr-10"
                    disabled={state === 'connecting'}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 p-0"
                    onClick={() => setShowToken(!showToken)}
                  >
                    {showToken ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('settings.team.urlHint', 'Supports HTTPS and SSH URLs. SSH uses your system keys automatically.')}
                </p>
              </div>
            )}
            <HostLlmConfig
              enabled={hostLlm}
              onEnabledChange={setHostLlm}
              baseUrl={llmUrl}
              onBaseUrlChange={setLlmUrl}
              models={llmModels}
              onModelsChange={setLlmModels}
              disabled={state === 'connecting'}
            />
            {state === 'connecting' && connectStep && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {connectStep}
              </div>
            )}
            <Button
              onClick={handleCreate}
              disabled={state === 'connecting' || !teamName.trim() || !gitUrl.trim()}
              className="w-full"
            >
              <Users className="mr-2 h-4 w-4" />
              {state === 'connecting' ? t('settings.team.creating', 'Creating...') : t('settings.team.createTeam', 'Create Team')}
            </Button>
            <p className="text-xs text-muted-foreground/70 text-center">
              {t('settings.team.joinHint', 'To join a team, open the invite link shared by your team admin.')}
            </p>
          </div>
        </SettingCard>
      )}

      {/* Connected State */}
      {(state === 'connected' || state === 'syncing') && teamConfig && (
        <>
          {/* Status Card */}
          <SettingCard className={cn(
            teamConfig.enabled
              ? "border-violet-200 dark:border-violet-800 bg-gradient-to-br from-violet-50/50 to-purple-50/50 dark:from-violet-950/20 dark:to-purple-950/20"
              : ""
          )}>
            <div className="space-y-4">
              {/* Header with status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-9 w-9 rounded-lg flex items-center justify-center",
                    teamConfig.enabled
                      ? "bg-violet-100 dark:bg-violet-900/30"
                      : "bg-muted"
                  )}>
                    <Users className={cn(
                      "h-5 w-5",
                      teamConfig.enabled
                        ? "text-violet-700 dark:text-violet-400"
                        : "text-muted-foreground"
                    )} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{t('settings.team.teamRepo', 'Team Repository')}</p>
                      <span className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                        teamConfig.enabled
                          ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                      )}>
                        <CheckCircle2 className="h-3 w-3" />
                        {teamConfig.enabled ? t('settings.llm.connected', 'Connected') : t('settings.team.disabled', 'Disabled')}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">
                        {teamConfig.gitUrl}
                      </p>
                      {teamConfig.gitToken && (
                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                          <KeyRound className="h-2.5 w-2.5" />
                          {t('settings.team.token', 'Token')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <ToggleSwitch
                  enabled={teamConfig.enabled}
                  onChange={handleToggleEnabled}
                />
              </div>

              {/* Last sync info */}
              <div className="flex items-center justify-between pt-2 border-t">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {t('settings.team.lastSynced', 'Last synced')}: {formatLastSync(teamConfig.lastSyncAt)}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => performSync(true)}
                    disabled={state === 'syncing' || !teamConfig.enabled}
                    className="gap-2"
                  >
                    <RefreshCw className={cn("h-3 w-3", state === 'syncing' && "animate-spin")} />
                    {state === 'syncing' ? t('settings.team.syncing', 'Syncing...') : t('settings.team.syncNow', 'Sync Now')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDisconnectDialogOpen(true)}
                    className="gap-2 text-destructive hover:text-destructive"
                  >
                    <Unlink className="h-3 w-3" />
                    {t('settings.team.disconnect', 'Disconnect')}
                  </Button>
                </div>
              </div>
            </div>
          </SettingCard>

          {/* Invite Link — share with new members */}
          {teamConfig.teamId && (
            <SettingCard>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-blue-100 dark:bg-blue-900/30">
                    <Link className="h-5 w-5 text-blue-700 dark:text-blue-400" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{t('settings.team.inviteLink', 'Invite Link')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.team.inviteLinkDesc', 'Share this link with teammates — they open it to join')}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto gap-1.5 text-xs shrink-0"
                    onClick={() => handleGenerateInvite(teamConfig.teamId!)}
                    disabled={generatingInvite}
                  >
                    {generatingInvite
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Link className="h-3 w-3" />}
                    {t('settings.team.generateInvite', 'Generate Invite')}
                  </Button>
                </div>
                {additionalInviteDeeplink && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <code className="flex-1 min-w-0 rounded-md bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 px-3 py-2 text-xs font-mono break-all select-all">
                        {additionalInviteDeeplink}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 h-9 w-9 p-0"
                        onClick={() => copyToClipboard(additionalInviteDeeplink, t('common.copied', 'Copied!'))}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('settings.team.inviteLinkExpiry', 'Valid for 7 days. Generate a new one if it expires.')}</p>
                  </div>
                )}
              </div>
            </SettingCard>
          )}

          {/* LLM Service Config — owner / manager only */}
          {canManageServiceConfig && (
            <SettingCard>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-900/30">
                    <Settings className="h-5 w-5 text-slate-700 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t('settings.team.serviceConfig', 'Service Config')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.team.serviceConfigDesc', 'LLM hosting settings for this team')}</p>
                  </div>
                </div>
                <HostLlmConfig
                  enabled={hostLlm}
                  onEnabledChange={setHostLlm}
                  baseUrl={llmUrl}
                  onBaseUrlChange={setLlmUrl}
                  models={llmModels}
                  onModelsChange={setLlmModels}
                />
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={handleSaveLlmConfig}
                  disabled={llmSaving}
                >
                  {llmSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {llmSaving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
                </Button>
              </div>
            </SettingCard>
          )}

          {/* Team Members */}
          <SettingCard>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-green-100 dark:bg-green-900/30">
                  <Users className="h-5 w-5 text-green-700 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">{t('settings.team.members', 'Team Members')}</p>
                </div>
              </div>
              <TeamMemberList />
              {deviceInfo && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground mb-1.5">{t('settings.team.myDeviceId', 'My Device ID')}</p>
                  <DeviceIdDisplay nodeId={deviceInfo.nodeId} />
                </div>
              )}
            </div>
          </SettingCard>

          {/* Shared Layer Info */}
          <SettingCard className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-800">
            <div className="space-y-3">
              <h4 className="font-medium text-blue-900 dark:text-blue-100 flex items-center gap-2">
                <GitBranch className="h-4 w-4" />
                {t('settings.team.sharedContent', 'Shared Content')}
              </h4>
              <p className="text-sm text-blue-700 dark:text-blue-300">
                {t('settings.team.sharedContentDesc', 'The following directories are synced from the team repository:')}
              </p>
              <div className="space-y-1.5">
                {[
                  { path: 'skills/', desc: t('settings.team.sharedSkills', 'Shared AI skills') },
                  { path: '.mcp/', desc: t('settings.team.sharedMcp', 'Shared MCP server configs') },
                  { path: 'knowledge/', desc: t('settings.team.sharedKnowledge', 'Shared knowledge base') },
                ].map((item) => (
                  <div key={item.path} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-xs bg-blue-100 dark:bg-blue-900/50 px-2 py-0.5 rounded text-blue-800 dark:text-blue-200">
                      {item.path}
                    </span>
                    <span className="text-blue-600 dark:text-blue-400 text-xs">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </SettingCard>
        </>
      )}

      {/* Error state with retry */}
      {state === 'error' && !errorMessage && (
        <SettingCard>
          <div className="text-center py-6">
            <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground mb-3">{t('settings.team.somethingWrong', 'Something went wrong')}</p>
            <Button variant="outline" onClick={initialize} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Team Created — Invite Deeplink Dialog */}
      <Dialog open={!!(createdTeamId && createdInviteDeeplink)} onOpenChange={(open) => {
        if (!open) {
          setCreatedTeamId('')
          setCreatedInviteDeeplink('')
        }
      }}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t('settings.team.teamCreatedTitle', 'Team Created Successfully')}</DialogTitle>
            <DialogDescription>
              {t('settings.team.teamCreatedDescInvite', 'Share the invite link below with your team members — they open it to join.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('settings.team.inviteLink', 'Invite Link')}</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 rounded-md bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 px-3 py-2 text-xs font-mono break-all max-h-20 overflow-y-auto select-all">
                  {createdInviteDeeplink}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 h-9 w-9 p-0"
                  onClick={() => copyToClipboard(createdInviteDeeplink, t('common.copied', 'Copied!'))}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.team.inviteLinkExpiry', 'Valid for 7 days. Generate a new one if it expires.')}</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('settings.team.teamId', 'Team ID')}</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 rounded-md bg-muted px-3 py-2 text-sm font-mono break-all">
                  {createdTeamId}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 h-9 w-9 p-0"
                  onClick={() => copyToClipboard(createdTeamId, t('common.copied', 'Copied!'))}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setCreatedTeamId('')
              setCreatedInviteDeeplink('')
            }}>
              {t('common.close', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Confirmation Dialog */}
      <Dialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('settings.team.disconnectTitle', 'Disconnect Team Repository')}</DialogTitle>
            <DialogDescription>
              {t('settings.team.disconnectConfirm', { defaultValue: 'Are you sure you want to disconnect the team repository? The {{teamRepoDir}} directory and all its content will be permanently deleted.', teamRepoDir: TEAM_REPO_DIR })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDisconnect} className="gap-2">
              <Unlink className="h-4 w-4" />
              {t('settings.team.disconnect', 'Disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-sync warning for too many / too large new files */}
      <Dialog
        open={precheckDialog !== null}
        onOpenChange={(open) => {
          if (!open) setPrecheckDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              {t('settings.team.syncPrecheckTitle', '检测到较多新文件')}
            </DialogTitle>
            <DialogDescription>
              {precheckDialog &&
                t('settings.team.syncPrecheckDesc', {
                  defaultValue: '即将同步 {{count}} 个新文件，共 {{size}}。请确认是否继续。',
                  count: precheckDialog.newFiles.length,
                  size: formatBytes(precheckDialog.totalBytes),
                })}
            </DialogDescription>
          </DialogHeader>
          {precheckDialog && (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2">
              <ul className="space-y-1 text-sm font-mono">
                {[...precheckDialog.newFiles]
                  .sort((a, b) => b.sizeBytes - a.sizeBytes)
                  .slice(0, 10)
                  .map((file) => (
                    <li key={file.path} className="flex items-center justify-between gap-3">
                      <span className="truncate" title={file.path}>
                        {file.path}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatBytes(file.sizeBytes)}
                      </span>
                    </li>
                  ))}
                {precheckDialog.newFiles.length > 10 && (
                  <li className="text-xs text-muted-foreground pt-1">
                    {t('settings.team.syncPrecheckMore', {
                      defaultValue: '… 及另外 {{count}} 个文件',
                      count: precheckDialog.newFiles.length - 10,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrecheckDialog(null)}>
              {t('common.cancel', '取消')}
            </Button>
            <Button
              onClick={() => {
                const updateUi = pendingUpdateUi
                setPrecheckDialog(null)
                void performSync(updateUi, true)
              }}
            >
              {t('settings.team.syncAnyway', '仍然同步')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Repo setup guide */}
      <Collapsible open={repoGuideOpen} onOpenChange={setRepoGuideOpen}>
        <SettingCard className="bg-muted/30 border-dashed">
          <CollapsibleTrigger className="flex w-full items-center gap-3 text-left hover:opacity-80 transition-opacity">
            <BookOpen className="h-5 w-5 text-violet-500 shrink-0" />
            <span className="font-medium text-sm">
              {t('settings.team.repoGuide.title', 'How to set up a team repository')}
            </span>
            <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", repoGuideOpen && "rotate-90")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-4 pt-4 border-t space-y-4 text-sm text-muted-foreground">
              <p>
                {t('settings.team.repoGuide.intro', { defaultValue: 'A shared repository for your team to centrally manage Agent Skills, MCP configurations, and knowledge documents. Use the structure below so {{appName}} can sync correctly.', appName: buildConfig.app.name })}
              </p>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.structureTitle', 'Repository structure')}
                </h5>
                <pre className="bg-muted rounded-md p-3 font-mono text-xs overflow-x-auto whitespace-pre">
                  {t('settings.team.repoGuide.structureTree', '.\n├── skills/\n├── .mcp/\n├── knowledge/\n├── .gitignore\n└── README.md')}
                </pre>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.dirDetailsTitle', 'Directory details')}
                </h5>
                <ul className="space-y-2">
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirSkillsTitle', 'skills/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirSkills', 'Shared Agent Skill definitions (SKILL.md).')}</span>
                  </li>
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirMcpTitle', '.mcp/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirMcp', 'Shared MCP Server config files.')}</span>
                  </li>
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirKnowledgeTitle', 'knowledge/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirKnowledge', 'Shared knowledge documents.')}</span>
                  </li>
                </ul>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.usageTitle', 'Usage')}
                </h5>
                <ol className="list-decimal list-inside space-y-1">
                  <li>{t('settings.team.repoGuide.usage1', { defaultValue: 'Clone the repo; {{appName}} will create a {{teamRepoDir}} folder in your workspace.', appName: buildConfig.app.name, teamRepoDir: TEAM_REPO_DIR })}</li>
                  <li>{t('settings.team.repoGuide.usage2', 'Whitelist .gitignore: only the three directories are tracked.')}</li>
                  <li>{t('settings.team.repoGuide.usage3', 'In Cursor, use @ to reference Skills and Knowledge.')}</li>
                </ol>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.contributingTitle', 'Contributing')}
                </h5>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{t('settings.team.repoGuide.contributingSkills', 'Add Skill: subdirectory under skills/ with SKILL.md.')}</li>
                  <li>{t('settings.team.repoGuide.contributingMcp', 'Add MCP: <server-name>.json under .mcp/.')}</li>
                  <li>{t('settings.team.repoGuide.contributingKnowledge', 'Add knowledge: files in knowledge/, Markdown recommended.')}</li>
                  <li>{t('settings.team.repoGuide.contributingSecurity', 'No sensitive data (keys, credentials) in commits.')}</li>
                </ul>
              </div>
            </div>
          </CollapsibleContent>
        </SettingCard>
      </Collapsible>
    </>
  )
}
