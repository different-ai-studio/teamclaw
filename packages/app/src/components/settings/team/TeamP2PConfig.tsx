/**
 * TeamP2PConfig - P2P device management: device list, member list, join/invite flow.
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
  KeyRound,
  Copy,
  Share2,
} from 'lucide-react'
import { cn, isTauri, copyToClipboard } from '@/lib/utils'
import { buildConfig } from '@/lib/build-config'
import { useTeamModeStore } from '@/stores/team-mode'
import { useTeamMembersStore } from '@/stores/team-members'
import { useWorkspaceStore } from '@/stores/workspace'
import { DeviceIdDisplay } from '@/components/settings/DeviceIdDisplay'
import { TeamMemberList } from '@/components/settings/TeamMemberList'
import type { DeviceInfo, TeamMember } from '@/lib/git/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('Team feature requires TeamClaw desktop app (Tauri not available)')
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

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

// ─── Team API Key Card ──────────────────────────────────────────────────────

function TeamApiKeyCard() {
  const { t } = useTranslation()
  const teamApiKey = useTeamModeStore((s) => s.teamApiKey)
  const setTeamApiKey = useTeamModeStore((s) => s.setTeamApiKey)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [keyInput, setKeyInput] = React.useState(teamApiKey || '')
  const [saving, setSaving] = React.useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const key = keyInput.trim() || null
      await setTeamApiKey(key, workspacePath || undefined)
      if (!key) setKeyInput('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard>
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-amber-100 dark:bg-amber-900/30">
            <KeyRound className="h-5 w-5 text-amber-700 dark:text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-medium">{t('settings.team.apiKeyTitle', 'API Key')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.team.apiKeyDesc', 'Optional. Leave empty to use Device ID for authentication.')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={t('settings.team.apiKeyPlaceholder', 'Leave empty to use Device ID')}
            className="h-9 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 h-9"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save', 'Save')}
          </Button>
          {teamApiKey && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 h-9 text-xs text-muted-foreground"
              onClick={async () => {
                setKeyInput('')
                await setTeamApiKey(null, workspacePath || undefined)
              }}
            >
              {t('settings.team.useDeviceId', 'Use Device ID')}
            </Button>
          )}
        </div>
      </div>
    </SettingCard>
  )
}

// ─── Main P2P Config Component ──────────────────────────────────────────────

export function TeamP2PConfig() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const teamMembersStore = useTeamMembersStore()

  const [p2pError, setP2pError] = React.useState<string | null>(null)
  const [joinTicketInput, setJoinTicketInput] = React.useState('')
  const [joinLoading, setJoinLoading] = React.useState(false)
  const [createLoading, setCreateLoading] = React.useState(false)
  const [showCreateForm, setShowCreateForm] = React.useState(false)
  const [createTeamName, setCreateTeamName] = React.useState('')
  const [createOwnerName, setCreateOwnerName] = React.useState('')
  const [createOwnerEmail, setCreateOwnerEmail] = React.useState('')
  const [dissolveLoading, setDissolveLoading] = React.useState(false)
  const [confirmDissolve, setConfirmDissolve] = React.useState(false)

  const [seedConfigUrl, setSeedConfigUrl] = React.useState('')
  const [seedConfigSecret, setSeedConfigSecret] = React.useState('')
  const [seedConfigSaving, setSeedConfigSaving] = React.useState(false)
  const [applications, setApplications] = React.useState<Array<{
    nodeId: string; name: string; email: string; note: string;
    platform: string; arch: string; hostname: string; appliedAt: string
  }>>([])
  const [applicationsLoading, setApplicationsLoading] = React.useState(false)
  const [approveRoles, setApproveRoles] = React.useState<Record<string, 'editor' | 'viewer'>>({})
  const [confirmLeave, setConfirmLeave] = React.useState(false)
  const [leaveLoading, setLeaveLoading] = React.useState(false)

  // Seed-based join flow
  const [joinMode, setJoinMode] = React.useState<'seed' | 'ticket'>('seed')
  const [seedUrl, setSeedUrl] = React.useState('')
  const [teamId, setTeamId] = React.useState('')
  const [teamSecret, setTeamSecret] = React.useState('')
  const [rotateLoading, setRotateLoading] = React.useState(false)

  // Sync status from backend
  const [syncStatus, setSyncStatus] = React.useState<{
    connected: boolean
    role: string | null
    docTicket: string | null
    namespaceId: string | null
    lastSyncAt: string | null
    members: TeamMember[]
    ownerNodeId: string | null
    seedUrl: string | null
    teamSecret: string | null
  } | null>(null)

  // Device identity & allowlist state
  const [deviceInfo, setDeviceInfo] = React.useState<DeviceInfo | null>(null)
  const [joinApprovalPending, setJoinApprovalPending] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<'create' | 'join' | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false)

  const allowedMembers = syncStatus?.members ?? []
  const isOwner = syncStatus?.role === 'owner'
  const isConnected = syncStatus?.connected ?? false
  const docTicket = syncStatus?.docTicket ?? null

  // Load device info, sync status, and reconnect on mount
  const loadSyncStatus = React.useCallback(async () => {
    if (!isTauri()) return
    try {
      const status = await tauriInvoke<typeof syncStatus>('p2p_sync_status')
      setSyncStatus(status)
      useTeamModeStore.setState({ myRole: (status?.role as 'owner' | 'editor' | 'viewer') ?? null })
    } catch {
      // may not be available
    }
  }, [])

  React.useEffect(() => {
    if (!isTauri()) return
    ;(async () => {
      try {
        const info = await tauriInvoke<DeviceInfo>('get_device_info')
        setDeviceInfo(info)
      } catch {
        // P2P node may not be running
      }
      // Try to reconnect to existing team doc
      try {
        await tauriInvoke('p2p_reconnect')
      } catch {
        // No team to reconnect or node not ready
      }
      await loadSyncStatus()
    })()
  }, [loadSyncStatus])

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

  // ─── P2P: check existing team dir before create/join ────────────────────

  const checkTeamDirAndConfirm = React.useCallback(async (action: 'create' | 'join') => {
    try {
      const result = await tauriInvoke<{ exists: boolean; hasMembers: boolean }>('p2p_check_team_dir')
      if (result.exists) {
        setConfirmAction(action)
        return
      }
    } catch {
      // If check fails, proceed anyway
    }
    if (action === 'create') doCreateTeam()
    else doJoinTeam()
  }, [])

  const handleConfirmOverwrite = () => {
    const action = confirmAction
    setConfirmAction(null)
    if (action === 'create') doCreateTeam()
    else doJoinTeam()
  }

  // ─── P2P Join flow ──────────────────────────────────────────────────────

  const joinWithTicket = async (ticket: string) => {
    setJoinLoading(true)
    setP2pError(null)
    setJoinApprovalPending(false)

    try {
      await tauriInvoke('p2p_join_drive', { ticket: ticket.trim(), label: '' })
      setJoinTicketInput('')
      setSeedUrl('')
      setTeamId('')
      setTeamSecret('')
      await loadSyncStatus()
      useWorkspaceStore.getState().refreshFileTree()
      await teamMembersStore.loadMembers()
      await teamMembersStore.loadMyRole()
      if (workspacePath) {
        const store = useTeamModeStore.getState()
        await store.loadTeamConfig(workspacePath)
        if (useTeamModeStore.getState().teamMode) {
          await store.applyTeamModelToOpenCode(workspacePath)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not been added') || msg.includes('not authorized') || msg.includes('未被添加')) {
        setJoinApprovalPending(true)
        setP2pError('Your device has not been added to the team. Ask the team Owner to add your Device ID, then try again.')
      } else {
        setP2pError(msg)
      }
    } finally {
      setJoinLoading(false)
    }
  }

  const doJoinTeam = async () => {
    if (joinMode === 'ticket') {
      if (!joinTicketInput.trim()) return
      await joinWithTicket(joinTicketInput.trim())
    } else {
      // Seed-based flow: fetch ticket from seed node, then join
      if (!seedUrl.trim() || !teamId.trim() || !teamSecret.trim()) return
      setJoinLoading(true)
      setP2pError(null)
      setJoinApprovalPending(false)
      try {
        const base = seedUrl.trim().replace(/\/$/, '')
        const resp = await fetch(`${base}/teams/${teamId.trim()}/ticket`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamSecret: teamSecret.trim() }),
        })
        const data = await resp.json()
        if (!resp.ok || !data.ticket) {
          setP2pError(data.error || 'Failed to fetch ticket from seed node')
          setJoinLoading(false)
          return
        }
        await joinWithTicket(data.ticket)
        // Persist seed URL + team secret for future owner operations
        await tauriInvoke('p2p_save_seed_config', { seedUrl: base, teamSecret: teamSecret.trim() || null })
      } catch (err) {
        setP2pError(err instanceof Error ? err.message : 'Failed to connect to seed node')
        setJoinLoading(false)
      }
    }
  }

  const handleJoin = () => checkTeamDirAndConfirm('join')

  const doCreateTeam = async () => {
    if (!createTeamName.trim()) return
    setCreateLoading(true)
    setP2pError(null)
    try {
      await tauriInvoke<string>('p2p_create_team', {
        teamName: createTeamName.trim() || null,
        ownerName: createOwnerName.trim() || null,
        ownerEmail: createOwnerEmail.trim() || null,
        llmBaseUrl: buildConfig.team.llm.baseUrl || null,
        llmModel: buildConfig.team.llm.model || null,
        llmModelName: buildConfig.team.llm.modelName || null,
      })
      await loadSyncStatus()
      // Refresh file tree so the new teamclaw-team directory appears
      useWorkspaceStore.getState().refreshFileTree()
      if (workspacePath) {
        const store = useTeamModeStore.getState()
        await store.loadTeamConfig(workspacePath)
        if (useTeamModeStore.getState().teamMode) {
          await store.applyTeamModelToOpenCode(workspacePath)
        }
      }
    } catch (err) {
      setP2pError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreateLoading(false)
    }
  }

  const handleCreateTeam = () => checkTeamDirAndConfirm('create')

  const handleRotateTicket = async () => {
    setRotateLoading(true)
    setP2pError(null)
    try {
      await tauriInvoke<string>('p2p_rotate_ticket')
      await loadSyncStatus()
    } catch (err) {
      setP2pError(err instanceof Error ? err.message : String(err))
    } finally {
      setRotateLoading(false)
    }
  }

  const fetchApplications = React.useCallback(async () => {
    const sUrl = syncStatus?.seedUrl
    const nsId = syncStatus?.namespaceId
    const secret = syncStatus?.teamSecret
    if (!sUrl || !nsId || !secret) return
    setApplicationsLoading(true)
    try {
      const base = sUrl.replace(/\/$/, '')
      const resp = await fetch(`${base}/teams/${nsId}/applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSecret: secret }),
      })
      if (resp.ok) {
        const data = await resp.json()
        setApplications(data.applications || [])
      }
    } catch { /* ignore */ } finally {
      setApplicationsLoading(false)
    }
  }, [syncStatus?.seedUrl, syncStatus?.namespaceId, syncStatus?.teamSecret])

  React.useEffect(() => {
    if (isOwner && syncStatus?.seedUrl && syncStatus?.namespaceId && syncStatus?.teamSecret) {
      fetchApplications()
    }
  }, [isOwner, syncStatus?.seedUrl, syncStatus?.namespaceId, syncStatus?.teamSecret, fetchApplications])

  const handleSaveSeedConfig = async () => {
    setSeedConfigSaving(true)
    try {
      await tauriInvoke('p2p_save_seed_config', {
        seedUrl: seedConfigUrl.trim() || null,
        teamSecret: seedConfigSecret.trim() || null,
      })
      await loadSyncStatus()
      setSeedConfigUrl('')
      setSeedConfigSecret('')
    } finally {
      setSeedConfigSaving(false)
    }
  }

  const doDissolveTeam = async () => {
    setConfirmDissolve(false)
    setDissolveLoading(true)
    setP2pError(null)
    try {
      await tauriInvoke('p2p_dissolve_team')
      setSyncStatus(null)
      useTeamModeStore.setState({ myRole: null })
      if (workspacePath) {
        const store = useTeamModeStore.getState()
        await store.clearTeamMode(workspacePath)
      }
    } catch (err) {
      setP2pError(err instanceof Error ? err.message : String(err))
    } finally {
      setDissolveLoading(false)
    }
  }

  const handleP2pDisconnect = () => {
    setConfirmDisconnect(true)
  }

  const doDisconnect = async () => {
    setConfirmDisconnect(false)
    setP2pError(null)
    try {
      await tauriInvoke('p2p_disconnect_source')
      setSyncStatus(null)
      useTeamModeStore.setState({ myRole: null })
      if (workspacePath) {
        const store = useTeamModeStore.getState()
        await store.clearTeamMode(workspacePath)
      }
    } catch (err) {
      setP2pError(err instanceof Error ? err.message : String(err))
    }
  }

  const doLeaveTeam = async () => {
    setConfirmLeave(false)
    setLeaveLoading(true)
    setP2pError(null)
    try {
      await tauriInvoke('p2p_leave_team')
      setSyncStatus(null)
      useTeamModeStore.setState({ myRole: null })
      if (workspacePath) {
        const store = useTeamModeStore.getState()
        await store.clearTeamMode(workspacePath)
      }
    } catch (err) {
      setP2pError(err instanceof Error ? err.message : String(err))
    } finally {
      setLeaveLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* P2P Error Banner */}
      {p2pError && (
        <SettingCard className="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-red-700 dark:text-red-300 break-words">{p2pError}</p>
            </div>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setP2pError(null)}>✕</Button>
          </div>
        </SettingCard>
      )}

      {/* ─── Connected State ─────────────────────────────────────────── */}
      {isConnected && (
        <>
          {/* Status Card */}
          <SettingCard>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-green-100 dark:bg-green-900/30">
                    <CheckCircle2 className="h-5 w-5 text-green-700 dark:text-green-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{t('settings.team.p2pSyncing', 'Team Drive Active')}</p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/40 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                        {t('settings.team.syncing', 'Syncing')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {syncStatus?.role === 'owner'
                        ? t('settings.team.roleOwner', 'Owner')
                        : syncStatus?.role === 'viewer'
                          ? t('settings.team.roleViewer', 'Viewer')
                          : t('settings.team.roleEditor', 'Editor')}
                      {syncStatus?.lastSyncAt && ` · ${t('settings.team.lastSync', 'Last sync')}: ${formatLastSync(syncStatus.lastSyncAt)}`}
                    </p>
                  </div>
                </div>
                {isOwner ? (
                  <Button variant="outline" size="sm" className="gap-1 text-destructive hover:text-destructive" onClick={handleP2pDisconnect} disabled={leaveLoading}>
                    <Unlink className="h-3 w-3" />
                    {t('settings.team.disconnect', 'Disconnect')}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="gap-1 text-destructive hover:text-destructive" onClick={() => setConfirmLeave(true)} disabled={leaveLoading}>
                    {leaveLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
                    {t('settings.team.leaveTeam', 'Leave Team')}
                  </Button>
                )}
              </div>
            </div>
          </SettingCard>

          {/* Ticket Card (Owner) */}
          {isOwner && docTicket && (
            <SettingCard>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-violet-100 dark:bg-violet-900/30">
                    <Share2 className="h-5 w-5 text-violet-700 dark:text-violet-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t('settings.team.p2pTicketTitle', 'Team Ticket')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.team.p2pTicketDesc', 'Share this with team members to join')}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-muted rounded-md p-3 text-xs font-mono break-all select-all">
                    {docTicket}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1"
                    onClick={() => copyToClipboard(docTicket, 'Copied')}
                  >
                    <Copy className="h-3 w-3" />
                    {t('common.copy', 'Copy')}
                  </Button>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1 text-xs text-muted-foreground"
                    disabled={rotateLoading}
                    onClick={handleRotateTicket}
                  >
                    {rotateLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    {t('settings.team.regenerateTicket', 'Regenerate Ticket')}
                  </Button>
                  <span className="text-[10px] text-muted-foreground">{t('settings.team.regenerateTicketHint', 'Use if ticket was leaked. All members must re-join.')}</span>
                </div>
              </div>
            </SettingCard>
          )}

          {/* Team ID Card (Owner) */}
          {isOwner && syncStatus?.namespaceId && (
            <SettingCard>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-blue-100 dark:bg-blue-900/30">
                    <GitBranch className="h-5 w-5 text-blue-700 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t('settings.team.teamId', 'Team ID')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.team.teamIdDesc', 'Share with your seed node admin to register this team')}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-muted rounded-md p-3 text-xs font-mono break-all select-all">
                    {syncStatus.namespaceId}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1"
                    onClick={() => copyToClipboard(syncStatus!.namespaceId!, 'Copied')}
                  >
                    <Copy className="h-3 w-3" />
                    {t('common.copy', 'Copy')}
                  </Button>
                </div>
              </div>
            </SettingCard>
          )}

          {/* Seed Connection Card (Owner) */}
          {isOwner && (
            <SettingCard>
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-orange-100 dark:bg-orange-900/30">
                    <Link className="h-5 w-5 text-orange-700 dark:text-orange-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t('settings.team.seedConnection', 'Seed Node')}</p>
                    <p className="text-xs text-muted-foreground">
                      {syncStatus?.seedUrl
                        ? syncStatus.seedUrl
                        : t('settings.team.seedConnectionDesc', 'Connect to seed node to manage join requests')}
                    </p>
                  </div>
                </div>

                {!syncStatus?.seedUrl ? (
                  <div className="space-y-2">
                    <Input
                      value={seedConfigUrl}
                      onChange={(e) => setSeedConfigUrl(e.target.value)}
                      placeholder={t('settings.team.seedUrlPlaceholder', 'Seed node URL (e.g. https://seed.example.com)')}
                      className="h-9 text-sm"
                      disabled={seedConfigSaving}
                    />
                    <Input
                      value={seedConfigSecret}
                      onChange={(e) => setSeedConfigSecret(e.target.value)}
                      placeholder={t('settings.team.teamSecretPlaceholder', 'Team secret')}
                      className="h-9 text-sm"
                      type="password"
                      disabled={seedConfigSaving}
                    />
                    <Button
                      onClick={handleSaveSeedConfig}
                      disabled={seedConfigSaving || !seedConfigUrl.trim() || !seedConfigSecret.trim()}
                      className="gap-2"
                      size="sm"
                    >
                      {seedConfigSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link className="h-3 w-3" />}
                      {t('settings.team.connectSeed', 'Connect')}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* Pending Applications */}
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {t('settings.team.pendingApplications', 'Pending Applications')}
                        {applications.length > 0 && (
                          <span className="ml-2 rounded-full bg-orange-100 dark:bg-orange-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700 dark:text-orange-300">
                            {applications.length}
                          </span>
                        )}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-xs h-6 px-2"
                        onClick={fetchApplications}
                        disabled={applicationsLoading}
                      >
                        {applicationsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      </Button>
                    </div>

                    {applications.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">{t('settings.team.noApplications', 'No pending applications')}</p>
                    ) : (
                      <div className="space-y-2">
                        {applications.map((app) => (
                          <div key={app.nodeId} className="rounded-lg border bg-muted/30 p-3 space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{app.name || app.nodeId}</p>
                                {app.email && <p className="text-xs text-muted-foreground truncate">{app.email}</p>}
                                <p className="text-[10px] text-muted-foreground">{app.platform} · {app.hostname}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Select
                                value={approveRoles[app.nodeId] ?? 'editor'}
                                onValueChange={(v) => setApproveRoles((prev) => ({ ...prev, [app.nodeId]: v as 'editor' | 'viewer' }))}
                              >
                                <SelectTrigger className="h-7 text-xs w-24">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="editor">{t('settings.team.roleEditor', 'Editor')}</SelectItem>
                                  <SelectItem value="viewer">{t('settings.team.roleViewer', 'Viewer')}</SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="flex gap-1 ml-auto">
                                <Button
                                  size="sm"
                                  className="h-7 px-2 text-xs gap-1"
                                  onClick={async () => {
                                    const role = approveRoles[app.nodeId] ?? 'editor'
                                    try {
                                      // 1. Add to P2P team with selected role
                                      const { invoke: inv } = await import('@tauri-apps/api/core')
                                      await inv('unified_team_add_member', {
                                        member: {
                                          nodeId: app.nodeId,
                                          name: app.name,
                                          role,
                                          label: app.hostname,
                                          platform: app.platform,
                                          arch: app.arch,
                                          hostname: app.hostname,
                                          addedAt: new Date().toISOString(),
                                        }
                                      })
                                      // 2. Approve on seed (remove from pending)
                                      const base = syncStatus!.seedUrl!.replace(/\/$/, '')
                                      await fetch(`${base}/teams/${syncStatus!.namespaceId}/applications/${app.nodeId}/approve`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ teamSecret: syncStatus!.teamSecret }),
                                      })
                                      setApproveRoles((prev) => { const n = { ...prev }; delete n[app.nodeId]; return n })
                                      await fetchApplications()
                                      await loadSyncStatus()
                                    } catch (err) {
                                      setP2pError(err instanceof Error ? err.message : String(err))
                                    }
                                  }}
                                >
                                  <CheckCircle2 className="h-3 w-3" />
                                  {t('settings.team.approve', 'Approve')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive"
                                  onClick={async () => {
                                    try {
                                      const base = syncStatus!.seedUrl!.replace(/\/$/, '')
                                      await fetch(`${base}/teams/${syncStatus!.namespaceId}/applications/${app.nodeId}/reject`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ teamSecret: syncStatus!.teamSecret }),
                                      })
                                      await fetchApplications()
                                    } catch (err) {
                                      setP2pError(err instanceof Error ? err.message : String(err))
                                    }
                                  }}
                                >
                                  {t('settings.team.reject', 'Reject')}
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 text-xs text-muted-foreground mt-1"
                      onClick={() => {
                        setSeedConfigUrl(syncStatus?.seedUrl || '')
                        setSeedConfigSecret('')
                        tauriInvoke('p2p_save_seed_config', { seedUrl: null, teamSecret: null }).then(() => loadSyncStatus())
                      }}
                    >
                      {t('settings.team.disconnectSeed', 'Change seed connection')}
                    </Button>
                  </div>
                )}
              </div>
            </SettingCard>
          )}

          {/* Team Members Section */}
          {allowedMembers.length > 0 && (
            <SettingCard>
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-green-100 dark:bg-green-900/30">
                    <Users className="h-5 w-5 text-green-700 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t('settings.team.members', 'Team Members')}</p>
                    <p className="text-xs text-muted-foreground">{allowedMembers.length} {t('settings.team.membersCount', 'members')}</p>
                  </div>
                </div>

                <TeamMemberList />
              </div>
            </SettingCard>
          )}

          {/* Dissolve Team (Owner only) */}
          {isOwner && (
            <SettingCard className="border-red-200 dark:border-red-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">{t('settings.team.dissolveTeam', 'Dissolve Team')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.team.dissolveTeamDesc', 'Permanently dissolve this team. All members will be disconnected.')}</p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={dissolveLoading}
                  onClick={() => setConfirmDissolve(true)}
                >
                  {dissolveLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('settings.team.dissolveTeam', 'Dissolve Team')}
                </Button>
              </div>
            </SettingCard>
          )}

          {/* API Key Override */}
          <TeamApiKeyCard />
        </>
      )}

      {/* ─── Not Connected State ─────────────────────────────────────── */}
      {!isConnected && (
        <>
          {/* Create Team */}
          <SettingCard>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-violet-100 dark:bg-violet-900/30">
                  <Share2 className="h-5 w-5 text-violet-700 dark:text-violet-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">{t('settings.team.createTeam', 'Create Team')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.team.createTeamDesc', 'Start a new team and get an invite code to share')}</p>
                </div>
              </div>

              {!showCreateForm ? (
                <Button onClick={() => setShowCreateForm(true)} className="gap-2">
                  <Share2 className="h-4 w-4" />
                  {t('settings.team.createTeamDrive', 'Create Team')}
                </Button>
              ) : (
                <div className="space-y-3">
                  <Input
                    value={createTeamName}
                    onChange={(e) => setCreateTeamName(e.target.value)}
                    placeholder={t('settings.team.teamNamePlaceholder', 'Team name *')}
                    className="h-9 text-sm"
                    disabled={createLoading}
                  />
                  <Input
                    value={createOwnerName}
                    onChange={(e) => setCreateOwnerName(e.target.value)}
                    placeholder={t('settings.team.ownerNamePlaceholder', 'Your name *')}
                    className="h-9 text-sm"
                    disabled={createLoading}
                  />
                  <Input
                    value={createOwnerEmail}
                    onChange={(e) => setCreateOwnerEmail(e.target.value)}
                    placeholder={t('settings.team.ownerEmailPlaceholder', 'Contact email (optional)')}
                    className="h-9 text-sm"
                    disabled={createLoading}
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={handleCreateTeam}
                      disabled={createLoading || !createTeamName.trim()}
                      className="gap-2"
                    >
                      {createLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {t('settings.team.creating', 'Creating...')}
                        </>
                      ) : (
                        <>
                          <Share2 className="h-4 w-4" />
                          {t('settings.team.createTeamDrive', 'Create Team')}
                        </>
                      )}
                    </Button>
                    <Button variant="outline" onClick={() => setShowCreateForm(false)} disabled={createLoading}>
                      {t('common.cancel', 'Cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </SettingCard>

          {/* Join Team */}
          <SettingCard>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-blue-100 dark:bg-blue-900/30">
                    <Link className="h-5 w-5 text-blue-700 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t('settings.team.p2pJoinTitle', 'Join Team')}</p>
                    <p className="text-xs text-muted-foreground">
                      {joinMode === 'seed'
                        ? t('settings.team.p2pJoinSeedDesc', 'Connect via seed node with invite code')
                        : t('settings.team.p2pJoinDesc', 'Connect to a team drive using a ticket')}
                    </p>
                  </div>
                </div>
                {/* Mode toggle */}
                <button
                  onClick={() => setJoinMode(joinMode === 'seed' ? 'ticket' : 'seed')}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                >
                  {joinMode === 'seed'
                    ? t('settings.team.useTicket', 'Use ticket instead')
                    : t('settings.team.useSeed', 'Use invite code instead')}
                </button>
              </div>

              {joinMode === 'seed' ? (
                <div className="space-y-3">
                  <Input
                    value={seedUrl}
                    onChange={(e) => setSeedUrl(e.target.value)}
                    placeholder={t('settings.team.seedUrlPlaceholder', 'Seed node URL (e.g. https://seed.example.com)')}
                    className="h-9 text-sm"
                    disabled={joinLoading}
                  />
                  <Input
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    placeholder={t('settings.team.teamIdPlaceholder', 'Team ID (namespace ID)')}
                    className="h-9 text-sm font-mono"
                    disabled={joinLoading}
                  />
                  <Input
                    value={teamSecret}
                    onChange={(e) => setTeamSecret(e.target.value)}
                    placeholder={t('settings.team.teamSecretPlaceholder', 'Invite code')}
                    type="password"
                    className="h-9 text-sm"
                    disabled={joinLoading}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && seedUrl.trim() && teamId.trim() && teamSecret.trim()) {
                        handleJoin()
                      }
                    }}
                  />
                  <Button
                    onClick={handleJoin}
                    disabled={joinLoading || !seedUrl.trim() || !teamId.trim() || !teamSecret.trim()}
                    className="gap-2 w-full"
                  >
                    {joinLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('settings.team.joining', 'Joining...')}
                      </>
                    ) : (
                      <>
                        <Link className="h-4 w-4" />
                        {t('settings.team.join', 'Join')}
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    value={joinTicketInput}
                    onChange={(e) => setJoinTicketInput(e.target.value)}
                    placeholder={t('settings.team.p2pJoinPlaceholder', 'Paste a P2P ticket here...')}
                    className="h-11"
                    disabled={joinLoading}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && joinTicketInput.trim()) {
                        handleJoin()
                      }
                    }}
                  />
                  <Button
                    onClick={handleJoin}
                    disabled={joinLoading || !joinTicketInput.trim()}
                    className="gap-2 shrink-0"
                  >
                    {joinLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('settings.team.joining', 'Joining...')}
                      </>
                    ) : (
                      <>
                        <Link className="h-4 w-4" />
                        {t('settings.team.join', 'Join')}
                      </>
                    )}
                  </Button>
                </div>
              )}

              {/* Not authorized -- prompt user to contact owner */}
              {joinApprovalPending && deviceInfo && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                      {t('settings.team.notAuthorized', 'Not authorized to join')}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.team.notAuthorizedDesc', 'Your device is not in the team allowlist. Please send your Device ID below to the team owner, and ask them to add you via "Add Member". Once added, try joining again.')}
                  </p>
                  <DeviceIdDisplay nodeId={deviceInfo.nodeId} />
                </div>
              )}
            </div>
          </SettingCard>
        </>
      )}

      {/* Device ID Section */}
      {deviceInfo && (
        <SettingCard>
          <div className="space-y-3">
            <p className="text-sm font-medium">{t('settings.team.deviceId', 'Device ID')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.team.deviceIdDesc', 'Your unique device identifier for team membership')}</p>
            <DeviceIdDisplay nodeId={deviceInfo.nodeId} />
          </div>
        </SettingCard>
      )}

      {/* Shared Content Info */}
      <SettingCard className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-800">
        <div className="space-y-3">
          <h4 className="font-medium text-blue-900 dark:text-blue-100 flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            {t('settings.team.p2pSharedContent', 'Shared Content')}
          </h4>
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {t('settings.team.p2pSharedContentDesc', 'The following directories are synced via P2P:')}
          </p>
          <div className="space-y-1.5">
            {[
              { path: 'skills/', desc: t('settings.team.sharedSkills', 'Shared AI skills') },
              { path: '.mcp/', desc: t('settings.team.sharedMcp', 'Shared MCP server configs') },
              { path: 'knowledge/', desc: t('settings.team.sharedKnowledge', 'Shared knowledge base') },
              { path: '_feedback/', desc: t('settings.team.sharedFeedback', 'Member feedback summaries') },
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

      {/* Overwrite teamclaw-team Confirmation Dialog */}
      <Dialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {confirmAction === 'create'
                ? t('settings.team.overwriteCreateTitle', 'Existing team directory found')
                : t('settings.team.overwriteJoinTitle', 'Existing team directory found')}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === 'create'
                ? t('settings.team.overwriteCreateDesc', 'A teamclaw-team directory already exists. Existing member configuration will be removed and a new team will be created. The rest of the files will be kept. Continue?')
                : t('settings.team.overwriteJoinDesc', 'A teamclaw-team directory already exists. It will be replaced with the content from the team you are joining. Continue?')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmOverwrite} className="gap-2">
              {t('common.continue', 'Continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Leave Team Confirmation Dialog */}
      <Dialog open={confirmLeave} onOpenChange={(open) => { if (!open) setConfirmLeave(false) }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-red-700 dark:text-red-300">
              {t('settings.team.leaveTeamTitle', 'Leave this team?')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.team.leaveTeamDesc', 'You will be removed from the team. The owner will be notified. Your local team data will be deleted and you will need a new invite to rejoin.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLeave(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={doLeaveTeam} className="gap-2">
              <Unlink className="h-3.5 w-3.5" />
              {t('settings.team.confirmLeave', 'Leave Team')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect Confirmation Dialog */}
      <Dialog open={confirmDisconnect} onOpenChange={(open) => { if (!open) setConfirmDisconnect(false) }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {t('settings.team.disconnectTitle', 'Disconnect from team?')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.team.disconnectDesc', 'This will delete local team data (.teamclaw and teamclaw-team directories). This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={doDisconnect} className="gap-2">
              <Unlink className="h-3.5 w-3.5" />
              {t('settings.team.confirmDisconnect', 'Disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dissolve Team Confirmation Dialog */}
      <Dialog open={confirmDissolve} onOpenChange={(open) => { if (!open) setConfirmDissolve(false) }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-red-700 dark:text-red-300">
              {t('settings.team.dissolveTitle', 'Dissolve team?')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.team.dissolveDesc', 'This will permanently dissolve the team. All members will lose access to shared content. This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDissolve(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={doDissolveTeam}>
              {t('settings.team.confirmDissolve', 'Dissolve Team')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
