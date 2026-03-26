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
  Link,
  Unlink,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  KeyRound,
  ChevronRight,
  BookOpen,
} from 'lucide-react'
import { cn, isTauri } from '@/lib/utils'
import { ToggleSwitch } from '@/components/settings/shared'
import { buildConfig, TEAM_SYNCED_EVENT, TEAM_REPO_DIR } from '@/lib/build-config'
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

// ─── Types ──────────────────────────────────────────────────────────────────

interface TeamConfig {
  gitUrl: string
  enabled: boolean
  lastSyncAt: string | null
  gitToken?: string | null
}

interface GitCheckResult {
  installed: boolean
  version: string | null
}

interface TeamGitResult {
  success: boolean
  message: string
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
  const [state, setState] = React.useState<ConnectionState>('loading')
  const [teamConfig, setTeamConfig] = React.useState<TeamConfig | null>(null)
  const [gitUrl, setGitUrl] = React.useState('')
  const [gitToken, setGitToken] = React.useState('')
  const [showToken, setShowToken] = React.useState(false)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [connectStep, setConnectStep] = React.useState('')
  const [disconnectDialogOpen, setDisconnectDialogOpen] = React.useState(false)
  const [repoGuideOpen, setRepoGuideOpen] = React.useState(false)

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

      const gitCheck = await tauriInvoke<GitCheckResult>('team_check_git_installed')
      if (!gitCheck.installed) {
        setState('no-git')
        return
      }

      const config = await tauriInvoke<TeamConfig | null>('get_team_config')
      if (config) {
        setTeamConfig(config)
        setGitUrl(config.gitUrl)
        if (config.gitToken) setGitToken(config.gitToken)
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
  }, [])

  React.useEffect(() => {
    initialize()
  }, [initialize])

  // ─── Connect flow ───────────────────────────────────────────────────

  const handleConnect = async () => {
    if (!gitUrl.trim()) return

    setState('connecting')
    setErrorMessage(null)

    try {
      setConnectStep(t('settings.team.initializingRepo', 'Initializing repository...'))
      await tauriInvoke<TeamGitResult>('team_init_repo', {
        gitUrl: gitUrl.trim(),
        gitToken: isHttpsUrl && gitToken.trim() ? gitToken.trim() : null,
        llmBaseUrl: buildConfig.team.llm.baseUrl || null,
        llmModel: buildConfig.team.llm.model || null,
        llmModelName: buildConfig.team.llm.modelName || null,
      })

      setConnectStep(t('settings.team.generatingGitignore', 'Generating .gitignore...'))
      await tauriInvoke<TeamGitResult>('team_generate_gitignore')

      setConnectStep(t('settings.team.savingConfig', 'Saving configuration...'))
      const now = new Date().toISOString()
      const newConfig: TeamConfig = {
        gitUrl: gitUrl.trim(),
        enabled: true,
        lastSyncAt: now,
        ...(isHttpsUrl && gitToken.trim() ? { gitToken: gitToken.trim() } : {}),
      }
      await tauriInvoke('save_team_config', { team: newConfig })

      setTeamConfig(newConfig)
      setState('connected')
    } catch (err) {
      console.error('Team connect error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setState('unconfigured')
    } finally {
      setConnectStep('')
    }
  }

  // ─── Sync flow ─────────────────────────────────────────────────────

  const performSync = async (updateUi = true) => {
    if (updateUi) {
      setState('syncing')
    }
    setErrorMessage(null)

    try {
      const result = await tauriInvoke<TeamGitResult>('team_sync_repo')

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
      await tauriInvoke('save_team_config', { team: updatedConfig })
      setTeamConfig(updatedConfig)

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
      await tauriInvoke<TeamGitResult>('team_disconnect_repo')
      await tauriInvoke('clear_team_config')

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
      await tauriInvoke('save_team_config', { team: updatedConfig })
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
      {/* Deprecation Banner */}
      <SettingCard className="bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 border-amber-200 dark:border-amber-800">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('settings.team.gitDeprecated', 'Git sync is deprecated. Use the P2P tab for decentralized team sync with device identity.')}
            </p>
          </div>
        </div>
      </SettingCard>

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

      {/* Unconfigured State - Setup Form */}
      {(state === 'unconfigured' || state === 'connecting') && (
        <SettingCard>
          <div className="space-y-4">
            {/* Git URL Input */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                {t('settings.team.gitUrl', 'Git Repository URL')}
              </label>
              <div className="flex gap-2">
                <Input
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder={t('settings.team.gitUrlPlaceholder', 'https://github.com/team/shared-workspace.git')}
                  className="h-11"
                  disabled={state === 'connecting'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && gitUrl.trim()) {
                      handleConnect()
                    }
                  }}
                />
                <Button
                  onClick={handleConnect}
                  disabled={state === 'connecting' || !gitUrl.trim()}
                  className="gap-2 shrink-0"
                >
                  {state === 'connecting' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('settings.llm.connecting', 'Connecting...')}
                    </>
                  ) : (
                    <>
                      <Link className="h-4 w-4" />
                      {t('settings.llm.connect', 'Connect')}
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('settings.team.urlHint', 'Supports HTTPS and SSH URLs. SSH uses your system keys automatically.')}
              </p>
            </div>

            {/* Token Input - shown only for HTTPS URLs */}
            {isHttpsUrl && (
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  {t('settings.team.personalToken', 'Personal Access Token')}
                  <span className="text-xs text-muted-foreground font-normal">({t('settings.team.optional', 'optional')})</span>
                </label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    value={gitToken}
                    onChange={(e) => setGitToken(e.target.value)}
                    placeholder={t('settings.team.tokenPlaceholder', 'glpat-xxxxxxxxxxxxxxxxxxxx')}
                    className="h-11 pr-10"
                    disabled={state === 'connecting'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && gitUrl.trim()) {
                        handleConnect()
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 p-0"
                    onClick={() => setShowToken(!showToken)}
                  >
                    {showToken ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('settings.team.tokenHint', 'Required for private HTTPS repositories. For GitLab, use a Personal Access Token with read_repository scope. Token is stored locally and never shared.')}
                </p>
              </div>
            )}

            {/* Connection progress */}
            {state === 'connecting' && connectStep && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {connectStep}
              </div>
            )}
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
