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
import { useTeamModeStore } from '@/stores/team-mode'
import { useWorkspaceStore } from '@/stores/workspace'
import { DeviceIdDisplay } from '@/components/settings/DeviceIdDisplay'
import { TeamMemberList } from '@/components/settings/TeamMemberList'
import { AddMemberInput } from '@/components/settings/AddMemberInput'
import type { DeviceInfo, TeamMember } from '@/lib/git/types'
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

  const [p2pError, setP2pError] = React.useState<string | null>(null)
  const [joinTicketInput, setJoinTicketInput] = React.useState('')
  const [joinLoading, setJoinLoading] = React.useState(false)
  const [createLoading, setCreateLoading] = React.useState(false)
  const [rotateLoading, setRotateLoading] = React.useState(false)

  // Sync status from backend
  const [syncStatus, setSyncStatus] = React.useState<{
    connected: boolean
    role: string | null
    docTicket: string | null
    namespaceId: string | null
    lastSyncAt: string | null
    members: TeamMember[]
  } | null>(null)

  // Device identity & allowlist state
  const [deviceInfo, setDeviceInfo] = React.useState<DeviceInfo | null>(null)
  const [addMemberError, setAddMemberError] = React.useState<string | null>(null)
  const [joinApprovalPending, setJoinApprovalPending] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<'create' | 'join' | null>(null)

  const ownerNodeId = syncStatus?.members?.[0]?.nodeId ?? null
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

  const doJoinTeam = async () => {
    if (!joinTicketInput.trim()) return

    setJoinLoading(true)
    setP2pError(null)
    setJoinApprovalPending(false)

    try {
      await tauriInvoke('p2p_join_drive', { ticket: joinTicketInput.trim(), label: '' })
      setJoinTicketInput('')
      await loadSyncStatus()
      // Reload team config so LLM section switches to team mode
      if (workspacePath) {
        const store = useTeamModeStore.getState()
        await store.loadTeamConfig(workspacePath)
        if (useTeamModeStore.getState().teamMode) {
          await store.applyTeamModelToOpenCode(workspacePath)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('not authorized')) {
        setJoinApprovalPending(true)
      } else {
        setP2pError(msg)
      }
    } finally {
      setJoinLoading(false)
    }
  }

  const handleJoin = () => checkTeamDirAndConfirm('join')

  const doCreateTeam = async () => {
    setCreateLoading(true)
    setP2pError(null)
    try {
      await tauriInvoke<string>('p2p_create_team')
      await loadSyncStatus()
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

  const handleP2pDisconnect = async () => {
    setP2pError(null)
    try {
      await tauriInvoke('p2p_disconnect_source')
      setSyncStatus(null)
    } catch (err) {
      setP2pError(err instanceof Error ? err.message : String(err))
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
                      {isOwner ? t('settings.team.roleOwner', 'Owner') : t('settings.team.roleMember', 'Member')}
                      {syncStatus?.lastSyncAt && ` · ${t('settings.team.lastSync', 'Last sync')}: ${formatLastSync(syncStatus.lastSyncAt)}`}
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="gap-1 text-destructive hover:text-destructive" onClick={handleP2pDisconnect}>
                  <Unlink className="h-3 w-3" />
                  {t('settings.team.disconnect', 'Disconnect')}
                </Button>
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

                <TeamMemberList
                  members={allowedMembers}
                  ownerNodeId={ownerNodeId ?? ''}
                  isOwner={isOwner}
                  onRemove={async (nodeId) => {
                    try {
                      await tauriInvoke('team_remove_member', { nodeId })
                      await loadSyncStatus()
                    } catch (err) {
                      setP2pError(err instanceof Error ? err.message : String(err))
                    }
                  }}
                />

                {isOwner && (
                  <div className="pt-2 border-t">
                    <p className="text-xs font-medium text-muted-foreground mb-2">{t('settings.team.addMember', 'Add Member')}</p>
                    <AddMemberInput
                      onAdd={async (nodeId, name) => {
                        setAddMemberError(null)
                        try {
                          await tauriInvoke('team_add_member', { nodeId, name })
                          await loadSyncStatus()
                        } catch (err) {
                          setAddMemberError(err instanceof Error ? err.message : String(err))
                        }
                      }}
                      error={addMemberError}
                    />
                  </div>
                )}
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
                  <p className="text-xs text-muted-foreground">{t('settings.team.createTeamDesc', 'Start a new team drive and get a ticket to share with others')}</p>
                </div>
              </div>

              <Button
                onClick={handleCreateTeam}
                disabled={createLoading}
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
                    {t('settings.team.createTeamDrive', 'Create Team Drive')}
                  </>
                )}
              </Button>
            </div>
          </SettingCard>

          {/* Join Team */}
          <SettingCard>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-blue-100 dark:bg-blue-900/30">
                  <Link className="h-5 w-5 text-blue-700 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">{t('settings.team.p2pJoinTitle', 'Join Team')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.team.p2pJoinDesc', 'Connect to a team drive using a ticket')}</p>
                </div>
              </div>

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
                    {t('settings.team.notAuthorizedDesc', 'Your device is not in the team allowlist. Please send your Device ID below to the team owner, and ask them to add you via "Add Member". Once added, enter the Ticket again to join.')}
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
    </div>
  )
}
