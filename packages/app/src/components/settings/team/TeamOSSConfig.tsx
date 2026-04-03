import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTeamOssStore } from '@/stores/team-oss'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamMembersStore } from '@/stores/team-members'
import { DeviceIdDisplay } from '@/components/settings/DeviceIdDisplay'
import { ApplicationDialog } from './ApplicationDialog'
import { TeamMemberList } from '@/components/settings/TeamMemberList'
import { VersionHistorySection } from './VersionHistorySection'
import { invoke } from '@tauri-apps/api/core'
import type { DeviceInfo } from '@/lib/git/types'
import { useTeamModeStore } from '@/stores/team-mode'
import { useProviderStore } from '@/stores/provider'
import {
  Cloud,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  LogOut,
  RefreshCw,
  Shield,
  UserPlus,
  Users,
  Camera,
  Trash2,
} from 'lucide-react'

function SettingCard({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon?: React.ElementType
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-card/30 p-5 backdrop-blur-sm">
      <div className="mb-4 flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <h4 className="text-sm font-semibold text-foreground/90">{title}</h4>
      </div>
      {children}
    </div>
  )
}


const DOC_TYPES = [
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP' },
  { key: 'knowledge', label: '知识库' },
]

export function TeamOSSConfig() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const {
    configured,
    connected,
    restoring,
    syncing,
    syncStatus,
    teamInfo,
    error,
    createTeam,
    joinTeam,
    leaveTeam,
    syncNow,
    loadSyncStatus,
    createSnapshot,
    cleanupUpdates,
    applyToTeam,
    pendingApplication,
    loadPendingApplication,
    cancelApplication,
    reconnect,
  } = useTeamOssStore()

  const teamMembersStore = useTeamMembersStore()

  // Create team form
  const [teamName, setTeamName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')

  // Join team form
  const [joinTeamId, setJoinTeamId] = useState('')
  const [joinTeamSecret, setJoinTeamSecret] = useState('')

  // UI state
  const [creating, setCreating] = useState(false)
  const [joining, setJoining] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [snapshotLoading, setSnapshotLoading] = useState<string | null>(null)
  const [cleanupLoading, setCleanupLoading] = useState<string | null>(null)
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
  const [showApplicationDialog, setShowApplicationDialog] = useState(false)
  const [applicationTeamName, setApplicationTeamName] = useState('')

  // NOTE: Do NOT call initialize/cleanup here. The OSS sync lifecycle is
  // managed at the app level by useOssSyncInit (in useAppInit.ts).
  // Previously this component called cleanup() on unmount, which killed
  // the OSS connection whenever the user switched away from the S3 tab.

  useEffect(() => {
    invoke<DeviceInfo>('get_device_info').then(setDeviceInfo).catch(() => {})
  }, [])

  useEffect(() => {
    if (workspacePath && connected) {
      loadSyncStatus(workspacePath)
    }
  }, [workspacePath, connected, loadSyncStatus])

  useEffect(() => {
    if (workspacePath && !connected) {
      loadPendingApplication(workspacePath)
    }
  }, [workspacePath, connected, loadPendingApplication])

  const handleCreateTeam = useCallback(async () => {
    if (!workspacePath) return
    setCreating(true)
    try {
      await createTeam({ workspacePath, teamName, ownerName, ownerEmail })
      setTeamName('')
      setOwnerName('')
      setOwnerEmail('')
      // Load team config and apply LLM provider
      const store = useTeamModeStore.getState()
      await store.loadTeamConfig(workspacePath)
      if (useTeamModeStore.getState().teamMode) {
        await store.applyTeamModelToOpenCode(workspacePath)
      }
      await useProviderStore.getState().initAll()
    } catch {
      // error is set in the store
    } finally {
      setCreating(false)
    }
  }, [workspacePath, teamName, ownerName, ownerEmail, createTeam])

  const handleJoinTeam = useCallback(async () => {
    if (!workspacePath) return
    setJoining(true)
    try {
      const result = await joinTeam({ workspacePath, teamId: joinTeamId, teamSecret: joinTeamSecret })
      if (result?.status === 'not_member') {
        // Show application dialog
        setApplicationTeamName(result.teamName || 'Unknown Team')
        setShowApplicationDialog(true)
      } else {
        // Joined successfully
        setJoinTeamId('')
        setJoinTeamSecret('')
        await teamMembersStore.loadMembers()
        await teamMembersStore.loadMyRole()
        // Load team config and apply LLM provider
        const store = useTeamModeStore.getState()
        await store.loadTeamConfig(workspacePath)
        if (useTeamModeStore.getState().teamMode) {
          await store.applyTeamModelToOpenCode(workspacePath)
        }
        await useProviderStore.getState().initAll()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useTeamOssStore.setState({ error: msg || 'Invalid ticket, please check and try again' })
    } finally {
      setJoining(false)
    }
  }, [workspacePath, joinTeamId, joinTeamSecret, joinTeam, teamMembersStore])

  const handleSubmitApplication = useCallback(async (name: string, email: string, note: string) => {
    if (!workspacePath) return
    await applyToTeam({
      workspacePath,
      teamId: joinTeamId,
      teamSecret: joinTeamSecret,
      name,
      email,
      note,
    })
    setShowApplicationDialog(false)
  }, [workspacePath, joinTeamId, joinTeamSecret, applyToTeam])

  const handleCancelApplication = useCallback(async () => {
    if (!workspacePath) return
    await cancelApplication(workspacePath)
  }, [workspacePath, cancelApplication])

  useEffect(() => {
    if (pendingApplication && !connected) {
      setJoinTeamId(pendingApplication.teamId)
    }
  }, [pendingApplication, connected])

  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  const handleLeaveTeam = useCallback(async () => {
    if (!workspacePath) return
    setLeaving(true)
    try {
      await leaveTeam(workspacePath)
    } catch {
      // error is set in the store
    } finally {
      setLeaving(false)
      setShowLeaveConfirm(false)
    }
  }, [workspacePath, leaveTeam])

  const handleSyncNow = useCallback(async () => {
    if (!workspacePath) return
    await syncNow(workspacePath)
  }, [workspacePath, syncNow])

  const handleSnapshot = useCallback(async (docType: string) => {
    if (!workspacePath) return
    setSnapshotLoading(docType)
    try {
      await createSnapshot(workspacePath, docType)
    } catch {
      // error is set in the store
    } finally {
      setSnapshotLoading(null)
    }
  }, [workspacePath, createSnapshot])

  const handleCleanup = useCallback(async (docType: string) => {
    if (!workspacePath) return
    setCleanupLoading(docType)
    try {
      await cleanupUpdates(workspacePath, docType)
    } catch {
      // error is set in the store
    } finally {
      setCleanupLoading(null)
    }
  }, [workspacePath, cleanupUpdates])

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
  }, [])

  const isOwner = teamInfo?.role === 'owner' || teamInfo?.role === 'admin'

  return (
    <div className="space-y-4">
      {/* State 0: Restoring connection */}
      {!connected && restoring && (
        <SettingCard title="连接中" icon={Cloud}>
          <div className="flex items-center gap-3 py-4 justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">正在连接团队...</p>
          </div>
        </SettingCard>
      )}

      {/* State 1a: Configured but disconnected — reconnect prompt */}
      {!connected && !restoring && configured && (
        <SettingCard title="团队未连接" icon={Cloud}>
          <div className="flex flex-col items-center gap-3 py-4">
            <p className="text-sm text-muted-foreground">
              已检测到团队配置，但连接失败。可能是网络问题或 S3 服务不可用。
            </p>
            {error && (
              <p className="text-xs text-destructive text-center">{error}</p>
            )}
            <Button
              onClick={() => workspacePath && reconnect(workspacePath)}
              disabled={restoring}
              variant="outline"
            >
              {restoring ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />重新连接中...</>
              ) : (
                <><RefreshCw className="mr-2 h-4 w-4" />重新连接</>
              )}
            </Button>
          </div>
        </SettingCard>
      )}

      {/* State 1b: Not configured — Create/Join forms */}
      {!connected && !restoring && !configured && (
        <>
          <SettingCard title="创建团队" icon={Users}>
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">团队名称</label>
                <Input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="输入团队名称"
                  className="bg-background/50"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">你的名字</label>
                  <Input
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="输入你的名字"
                    className="bg-background/50"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">你的邮箱</label>
                  <Input
                    value={ownerEmail}
                    onChange={(e) => setOwnerEmail(e.target.value)}
                    placeholder="输入你的邮箱"
                    className="bg-background/50"
                  />
                </div>
              </div>
              <Button
                onClick={handleCreateTeam}
                disabled={creating || !teamName || !ownerName || !ownerEmail}
                className="w-full"
              >
                <Cloud className="mr-2 h-4 w-4" />
                {creating ? '创建中...' : '创建团队'}
              </Button>
            </div>
          </SettingCard>

          <div className="relative flex items-center py-1">
            <div className="flex-1 border-t border-border/40" />
            <span className="px-3 text-xs text-muted-foreground">或</span>
            <div className="flex-1 border-t border-border/40" />
          </div>

          <SettingCard title="加入团队" icon={UserPlus}>
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">团队 ID</label>
                <Input
                  value={joinTeamId}
                  onChange={(e) => setJoinTeamId(e.target.value)}
                  placeholder="输入团队 ID"
                  className="font-mono bg-background/50"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">团队密钥</label>
                <Input
                  type="password"
                  value={joinTeamSecret}
                  onChange={(e) => setJoinTeamSecret(e.target.value)}
                  placeholder="输入团队密钥"
                  className="bg-background/50"
                />
              </div>
              {pendingApplication && (
                <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 flex items-start gap-2">
                  <span className="text-base leading-none mt-0.5">⏳</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-green-600 dark:text-green-400">
                      申请已提交，等待 Owner 审批
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      点击「加入团队」可重新检查审批状态
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 h-7 text-xs text-muted-foreground"
                    onClick={handleCancelApplication}
                  >
                    取消申请
                  </Button>
                </div>
              )}
              <Button
                onClick={handleJoinTeam}
                disabled={joining || !joinTeamId || !joinTeamSecret}
                variant="outline"
                className="w-full"
              >
                <UserPlus className="mr-2 h-4 w-4" />
                {joining ? '加入中...' : '加入团队'}
              </Button>
              {deviceInfo && (
                <div className="pt-1">
                  <label className="mb-1 block text-xs text-muted-foreground">我的设备 ID（分享给团队 Owner 以加入团队）</label>
                  <DeviceIdDisplay nodeId={deviceInfo.nodeId} />
                </div>
              )}
            </div>
          </SettingCard>
        </>
      )}

      {/* State 2 & 3: Connected */}
      {connected && teamInfo && (
        <>
          <SettingCard title="团队信息" icon={Users}>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
                <span className="text-muted-foreground">团队名称</span>
                <span className="font-medium">{teamInfo.teamName}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
                <span className="text-muted-foreground">团队 ID</span>
                <div className="flex items-center gap-1.5">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{teamInfo.teamId}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => copyToClipboard(teamInfo.teamId)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              {teamInfo.teamSecret && (
                <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
                  <span className="shrink-0 text-muted-foreground">团队密钥</span>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs max-w-[180px]">
                      {showSecret ? teamInfo.teamSecret : '••••••••••••'}
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      onClick={() => setShowSecret(!showSecret)}
                    >
                      {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      onClick={() => copyToClipboard(teamInfo.teamSecret!)}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
                <span className="text-muted-foreground">角色</span>
                <div className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{isOwner ? '管理员' : '成员'}</span>
                </div>
              </div>
              {deviceInfo && (
                <div className="pt-1">
                  <label className="mb-1 block text-xs text-muted-foreground">我的设备 ID</label>
                  <DeviceIdDisplay nodeId={deviceInfo.nodeId} />
                </div>
              )}
            </div>
          </SettingCard>

          <SettingCard title="团队成员">
            <TeamMemberList />
          </SettingCard>

          <SettingCard title="同步状态" icon={RefreshCw}>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ring-2 ${connected ? 'bg-green-500 ring-green-500/20' : 'bg-red-500 ring-red-500/20'}`} />
                  <span className="font-medium">{connected ? '已连接' : '未连接'}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSyncNow}
                  disabled={syncing}
                  className="h-8"
                >
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? '同步中...' : '立即同步'}
                </Button>
              </div>
              {syncStatus?.lastSyncAt && (
                <div className="rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  上次同步: {new Date(syncStatus.lastSyncAt).toLocaleString()}
                </div>
              )}
            </div>
          </SettingCard>

          {/* Admin-only section */}
          {isOwner && (
            <SettingCard title="管理员操作" icon={Shield}>
              <div className="space-y-4">
                <div>
                  <label className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Camera className="h-3 w-3" />
                    快照
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {DOC_TYPES.map((dt) => (
                      <Button
                        key={`snapshot-${dt.key}`}
                        size="sm"
                        variant="outline"
                        onClick={() => handleSnapshot(dt.key)}
                        disabled={snapshotLoading === dt.key}
                        className="h-8"
                      >
                        {snapshotLoading === dt.key ? '创建中...' : `${dt.label} 快照`}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Trash2 className="h-3 w-3" />
                    清理
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {DOC_TYPES.map((dt) => (
                      <Button
                        key={`cleanup-${dt.key}`}
                        size="sm"
                        variant="outline"
                        onClick={() => handleCleanup(dt.key)}
                        disabled={cleanupLoading === dt.key}
                        className="h-8"
                      >
                        {cleanupLoading === dt.key ? '清理中...' : `${dt.label} 清理`}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </SettingCard>
          )}

          <VersionHistorySection />

          <div className="pt-1">
            {!showLeaveConfirm ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowLeaveConfirm(true)}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <LogOut className="mr-1.5 h-3.5 w-3.5" />
                离开团队
              </Button>
            ) : (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
                <p className="text-sm text-destructive">确定要离开团队吗？本地团队配置将被清除。</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleLeaveTeam}
                    disabled={leaving}
                  >
                    {leaving ? '离开中...' : '确认离开'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowLeaveConfirm(false)}
                    disabled={leaving}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {showApplicationDialog && (
        <ApplicationDialog
          teamName={applicationTeamName}
          onSubmit={handleSubmitApplication}
          onCancel={() => setShowApplicationDialog(false)}
        />
      )}

      {/* Error display */}
      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  )
}
