import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTeamOssStore } from '@/stores/team-oss'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamMembersStore } from '@/stores/team-members'
import { DeviceIdDisplay } from '@/components/settings/DeviceIdDisplay'
import { ApplicationDialog } from './ApplicationDialog'
import { HostLlmConfig } from './HostLlmConfig'
import { TeamMemberList } from '@/components/settings/TeamMemberList'
import { VersionHistorySection } from './VersionHistorySection'
import { invoke } from '@tauri-apps/api/core'
import { buildConfig } from '@/lib/build-config'
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
  RotateCcw,
  Shield,
  UserPlus,
  Users,
  Camera,
  Trash2,
  Settings,
  Save,
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
  { key: 'meta', label: '元数据' },
]

export function TeamOSSConfig() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const {
    _initDone: ossInitDone,
    configured,
    connected,
    restoring,
    syncing,
    syncStatus,
    syncProgress,
    teamInfo,
    error,
    createTeam,
    joinTeam,
    leaveTeam,
    syncNow,
    resetSync,
    loadSyncStatus,
    createSnapshot,
    cleanupUpdates,
    applyToTeam,
    pendingApplication,
    loadPendingApplication,
    cancelApplication,
    reconnect,
    updateServiceConfig,
  } = useTeamOssStore()

  const teamMembersStore = useTeamMembersStore()
  const myRole = useTeamMembersStore((s) => s.myRole)

  // Create team form
  const [teamName, setTeamName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const defaultFcEndpoint = buildConfig.s3?.teamEndpoint || ''
  const defaultLlmUrl = buildConfig.team.llm.baseUrl || ''
  const [createFcEndpoint, setCreateFcEndpoint] = useState(defaultFcEndpoint)
  const [createHostLlm, setCreateHostLlm] = useState(!!defaultLlmUrl)
  const [createLlmUrl, setCreateLlmUrl] = useState(defaultLlmUrl)
  const defaultLlmModels = (buildConfig.team.llm.models ?? []).map((m) => ({ id: m.id, name: m.name }))
  const [createLlmModels, setCreateLlmModels] = useState(defaultLlmModels)

  // Join team form
  const [joinTeamId, setJoinTeamId] = useState('')
  const [joinTeamSecret, setJoinTeamSecret] = useState('')
  const [joinFcEndpoint, setJoinFcEndpoint] = useState(defaultFcEndpoint)

  // Service config form (for connected state editing)
  const [cfgFcEndpoint, setCfgFcEndpoint] = useState('')
  const [cfgHostLlm, setCfgHostLlm] = useState(false)
  const [cfgLlmUrl, setCfgLlmUrl] = useState('')
  const [cfgLlmModels, setCfgLlmModels] = useState<Array<{ id: string; name: string }>>([])

  const [cfgSaving, setCfgSaving] = useState(false)
  const [cfgLoaded, setCfgLoaded] = useState(false)

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
      // Load current service config for editing
      if (!cfgLoaded) {
        invoke<{ enabled: boolean; teamId: string; teamEndpoint: string } | null>('oss_get_team_config', { workspacePath })
          .then((config) => {
            if (config) setCfgFcEndpoint(config.teamEndpoint || '')
          })
          .catch(() => {})
        invoke<{ active: boolean; llm?: { baseUrl: string; model?: string; modelName?: string; models?: Array<{ id: string; name: string }> } }>('get_team_status')
          .then((status) => {
            if (status.llm?.baseUrl) {
              setCfgHostLlm(true)
              setCfgLlmUrl(status.llm.baseUrl)
              if (status.llm.models?.length) {
                setCfgLlmModels(status.llm.models)
              } else if (status.llm.model) {
                setCfgLlmModels([{ id: status.llm.model, name: status.llm.modelName || status.llm.model }])
              }
            }
          })
          .catch(() => {})
        setCfgLoaded(true)
      }
    }
  }, [workspacePath, connected, loadSyncStatus, cfgLoaded])

  useEffect(() => {
    if (workspacePath && !connected) {
      loadPendingApplication(workspacePath)
    }
  }, [workspacePath, connected, loadPendingApplication])

  const handleCreateTeam = useCallback(async () => {
    if (!workspacePath) return
    setCreating(true)
    try {
      await createTeam({
        workspacePath,
        teamName,
        ownerName,
        ownerEmail,
        fcEndpoint: createFcEndpoint,
        llmBaseUrl: createHostLlm ? createLlmUrl : undefined,
        llmModel: createHostLlm ? (createLlmModels[0]?.id || undefined) : undefined,
        llmModelName: createHostLlm ? (createLlmModels[0]?.name || undefined) : undefined,
        llmModels: createHostLlm && createLlmModels.length > 0 ? JSON.stringify(createLlmModels) : undefined,
      })
      setTeamName('')
      setOwnerName('')
      setOwnerEmail('')
      setCreateFcEndpoint('')
      setCreateHostLlm(false)
      setCreateLlmUrl('')
      setCreateLlmModels([])
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
  }, [workspacePath, teamName, ownerName, ownerEmail, createFcEndpoint, createHostLlm, createLlmUrl, createLlmModels, createTeam])

  const handleJoinTeam = useCallback(async () => {
    if (!workspacePath) return
    setJoining(true)
    try {
      const result = await joinTeam({
        workspacePath,
        teamId: joinTeamId,
        teamSecret: joinTeamSecret,
        fcEndpoint: joinFcEndpoint,
      })
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
  }, [workspacePath, joinTeamId, joinTeamSecret, joinFcEndpoint, joinTeam, teamMembersStore])

  const handleSubmitApplication = useCallback(async (name: string, email: string, note: string) => {
    if (!workspacePath) return
    await applyToTeam({
      workspacePath,
      teamId: joinTeamId,
      teamSecret: joinTeamSecret,
      fcEndpoint: joinFcEndpoint,
      name,
      email,
      note,
    })
    setShowApplicationDialog(false)
  }, [workspacePath, joinTeamId, joinTeamSecret, joinFcEndpoint, applyToTeam])

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

  const handleSaveServiceConfig = useCallback(async () => {
    if (!workspacePath) return
    setCfgSaving(true)
    try {
      await updateServiceConfig({
        workspacePath,
        teamEndpoint: cfgFcEndpoint || undefined,
        llmBaseUrl: cfgHostLlm ? cfgLlmUrl : undefined,
        llmModel: cfgHostLlm ? (cfgLlmModels[0]?.id || undefined) : undefined,
        llmModelName: cfgHostLlm ? (cfgLlmModels[0]?.name || undefined) : undefined,
        llmModels: cfgHostLlm && cfgLlmModels.length > 0 ? JSON.stringify(cfgLlmModels) : undefined,
      })
    } catch {
      // error is set in the store
    } finally {
      setCfgSaving(false)
    }
  }, [workspacePath, cfgFcEndpoint, cfgHostLlm, cfgLlmUrl, cfgLlmModels, updateServiceConfig])

  const handleSyncNow = useCallback(async () => {
    if (!workspacePath) return
    await syncNow(workspacePath)
  }, [workspacePath, syncNow])

  const handleResetSync = useCallback(async () => {
    if (!workspacePath) return
    await resetSync(workspacePath)
  }, [workspacePath, resetSync])

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

  const isOwner = myRole === 'owner'

  return (
    <div className="space-y-4">
      {/* State 0: Restoring connection or OSS store still initializing */}
      {!connected && (restoring || !ossInitDone) && (
        <SettingCard title="连接中" icon={Cloud}>
          <div className="flex flex-col gap-3 py-4 items-center">
            <div className="flex items-center gap-3 justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">正在连接团队...</p>
            </div>
            {restoring && syncProgress && (
              <div className="rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground w-full">
                <div className="mb-1">正在同步团队数据...</div>
                {syncProgress.phase === 'snapshot' && (
                  <div>下载快照: {syncProgress.docType}</div>
                )}
                {syncProgress.phase === 'updates' && syncProgress.total && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${((syncProgress.current || 0) / syncProgress.total) * 100}%` }}
                      />
                    </div>
                    <span>{syncProgress.docType} ({syncProgress.current}/{syncProgress.total})</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </SettingCard>
      )}

      {/* State 1a: Configured but disconnected — reconnect prompt */}
      {!connected && !restoring && ossInitDone && configured && (
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
      {!connected && !restoring && ossInitDone && !configured && (
        <>
          <SettingCard title="创建团队" icon={Users}>
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">服务端地址 (FC Endpoint)</label>
                <Input
                  value={createFcEndpoint}
                  onChange={(e) => setCreateFcEndpoint(e.target.value)}
                  placeholder="https://your-fc-endpoint.com"
                  className="bg-background/50 font-mono text-xs"
                />
                <p className="mt-1 text-xs text-muted-foreground/60">
                  自部署的 Function Compute 服务地址，OSS 凭证将从此服务获取
                </p>
              </div>
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
              <HostLlmConfig
                enabled={createHostLlm}
                onEnabledChange={setCreateHostLlm}
                baseUrl={createLlmUrl}
                onBaseUrlChange={setCreateLlmUrl}
                models={createLlmModels}
                onModelsChange={setCreateLlmModels}
              />
              <Button
                onClick={handleCreateTeam}
                disabled={creating || !teamName || !ownerName || !ownerEmail || !createFcEndpoint}
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
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">服务端地址 (FC Endpoint)</label>
                <Input
                  value={joinFcEndpoint}
                  onChange={(e) => setJoinFcEndpoint(e.target.value)}
                  placeholder="https://your-fc-endpoint.com"
                  className="bg-background/50 font-mono text-xs"
                />
              </div>
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
                disabled={joining || !joinTeamId || !joinTeamSecret || !joinFcEndpoint}
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
                  <span className="font-medium">
                    {myRole === 'owner' ? '所有者' : myRole === 'manager' ? '管理员' : myRole === 'editor' ? '编辑' : myRole === 'viewer' ? '只读' : '成员'}
                  </span>
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

          {isOwner && (
            <SettingCard title="服务配置" icon={Settings}>
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">服务端地址 (FC Endpoint)</label>
                  <Input
                    value={cfgFcEndpoint}
                    onChange={(e) => setCfgFcEndpoint(e.target.value)}
                    placeholder="https://your-fc-endpoint.com"
                    className="bg-background/50 font-mono text-xs"
                  />
                  <p className="mt-1 text-xs text-muted-foreground/60">
                    OSS 凭证和团队注册服务的地址
                  </p>
                </div>
                <HostLlmConfig
                  enabled={cfgHostLlm}
                  onEnabledChange={setCfgHostLlm}
                  baseUrl={cfgLlmUrl}
                  onBaseUrlChange={setCfgLlmUrl}
                  models={cfgLlmModels}
                  onModelsChange={setCfgLlmModels}
                />
                <Button
                  onClick={handleSaveServiceConfig}
                  disabled={cfgSaving || !cfgFcEndpoint}
                  size="sm"
                  className="gap-1.5"
                >
                  <Save className="h-3.5 w-3.5" />
                  {cfgSaving ? '保存中...' : '保存配置'}
                </Button>
              </div>
            </SettingCard>
          )}

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
                <div className="flex gap-2">
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleResetSync}
                    disabled={syncing}
                    className="h-8 text-orange-600 hover:text-orange-700"
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    重置同步
                  </Button>
                </div>
              </div>
              {/* Sync health indicator */}
              <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs">
                {syncStatus && (
                  <>
                    <span className={`inline-block h-2 w-2 rounded-full ${
                      syncStatus.health === 'healthy' ? 'bg-green-500' :
                      syncStatus.health === 'warning' ? 'bg-yellow-500' :
                      syncStatus.health === 'error' ? 'bg-red-500' :
                      'bg-gray-400'
                    }`} />
                    <span className="text-muted-foreground">
                      {syncStatus.health === 'healthy' && '同步正常'}
                      {syncStatus.health === 'warning' && `同步警告: ${syncStatus.healthMessage || ''}`}
                      {syncStatus.health === 'error' && `同步异常: ${syncStatus.healthMessage || ''}`}
                      {syncStatus.health === 'offline' && '离线'}
                    </span>
                    {syncStatus.lastDataSyncAt && (
                      <span className="ml-auto text-muted-foreground/60">
                        上次同步: {new Date(syncStatus.lastDataSyncAt).toLocaleString()}
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* Skipped files warning */}
              {syncStatus?.skippedFiles && syncStatus.skippedFiles.length > 0 && (
                <div className="rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
                  <div className="font-medium mb-1">以下文件无法同步：</div>
                  {syncStatus.skippedFiles.map((f) => (
                    <div key={f.path} className="ml-2">• {f.path} — {f.reason}</div>
                  ))}
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

      {/* Shared Content Info — only when connected */}
      {connected && (
        <SettingCard title="共享内容" icon={Cloud}>
          <div className="space-y-1.5">
            {[
              { path: 'skills/', desc: '共享 AI 技能' },
              { path: '.mcp/', desc: '共享 MCP 服务配置' },
              { path: 'knowledge/', desc: '共享知识库' },
              { path: '_feedback/', desc: '成员反馈摘要' },
            ].map((item) => (
              <div key={item.path} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">{item.path}</span>
                <span className="text-muted-foreground text-xs">{item.desc}</span>
              </div>
            ))}
          </div>
        </SettingCard>
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
