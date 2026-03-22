import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTeamOssStore } from '@/stores/team-oss'
import { useWorkspaceStore } from '@/stores/workspace'

function SettingCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 p-4">
      <h4 className="mb-3 text-sm font-medium text-foreground/80">{title}</h4>
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
    connected,
    syncing,
    syncStatus,
    teamInfo,
    error,
    initialize,
    createTeam,
    joinTeam,
    leaveTeam,
    syncNow,
    loadSyncStatus,
    createSnapshot,
    cleanupUpdates,
    cleanup,
  } = useTeamOssStore()

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

  useEffect(() => {
    if (workspacePath) {
      initialize(workspacePath)
    }
    return () => cleanup()
  }, [workspacePath, initialize, cleanup])

  useEffect(() => {
    if (workspacePath && connected) {
      loadSyncStatus(workspacePath)
    }
  }, [workspacePath, connected, loadSyncStatus])

  const handleCreateTeam = useCallback(async () => {
    if (!workspacePath) return
    setCreating(true)
    try {
      await createTeam({ workspacePath, teamName, ownerName, ownerEmail })
      setTeamName('')
      setOwnerName('')
      setOwnerEmail('')
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
      await joinTeam({ workspacePath, teamId: joinTeamId, teamSecret: joinTeamSecret })
      setJoinTeamId('')
      setJoinTeamSecret('')
    } catch {
      // error is set in the store
    } finally {
      setJoining(false)
    }
  }, [workspacePath, joinTeamId, joinTeamSecret, joinTeam])

  const handleLeaveTeam = useCallback(async () => {
    if (!workspacePath) return
    setLeaving(true)
    try {
      await leaveTeam(workspacePath)
    } catch {
      // error is set in the store
    } finally {
      setLeaving(false)
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
      {/* State 1: Disconnected — Create/Join forms */}
      {!connected && (
        <>
          <SettingCard title="创建团队">
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">团队名称</label>
                <Input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="输入团队名称"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">你的名字</label>
                <Input
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="输入你的名字"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">你的邮箱</label>
                <Input
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="输入你的邮箱"
                />
              </div>
              <Button
                onClick={handleCreateTeam}
                disabled={creating || !teamName || !ownerName || !ownerEmail}
              >
                {creating ? '创建中...' : '创建团队'}
              </Button>
            </div>
          </SettingCard>

          <SettingCard title="加入团队">
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">团队 ID</label>
                <Input
                  value={joinTeamId}
                  onChange={(e) => setJoinTeamId(e.target.value)}
                  placeholder="输入团队 ID"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">团队密钥</label>
                <Input
                  type="password"
                  value={joinTeamSecret}
                  onChange={(e) => setJoinTeamSecret(e.target.value)}
                  placeholder="输入团队密钥"
                />
              </div>
              <Button
                onClick={handleJoinTeam}
                disabled={joining || !joinTeamId || !joinTeamSecret}
              >
                {joining ? '加入中...' : '加入团队'}
              </Button>
            </div>
          </SettingCard>
        </>
      )}

      {/* State 2 & 3: Connected */}
      {connected && teamInfo && (
        <>
          <SettingCard title="团队信息">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">团队名称</span>
                <span>{teamInfo.teamName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">团队 ID</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{teamInfo.teamId}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => copyToClipboard(teamInfo.teamId)}
                  >
                    复制
                  </Button>
                </div>
              </div>
              {teamInfo.teamSecret && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">团队密钥</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">
                      {showSecret ? teamInfo.teamSecret : '•••••••••'}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => setShowSecret(!showSecret)}
                    >
                      {showSecret ? '隐藏' : '显示'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => copyToClipboard(teamInfo.teamSecret!)}
                    >
                      复制
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">角色</span>
                <span>{isOwner ? '管理员' : '成员'}</span>
              </div>
            </div>
          </SettingCard>

          <SettingCard title="同步状态">
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
                <span>{connected ? '已连接' : '未连接'}</span>
              </div>
              {syncStatus?.lastSyncAt && (
                <div className="text-muted-foreground">
                  上次同步: {new Date(syncStatus.lastSyncAt).toLocaleString()}
                </div>
              )}
              <div className="pt-2">
                <Button
                  size="sm"
                  onClick={handleSyncNow}
                  disabled={syncing}
                >
                  {syncing ? '同步中...' : '立即同步'}
                </Button>
              </div>
            </div>
          </SettingCard>

          {/* Admin-only section */}
          {isOwner && (
            <SettingCard title="管理员操作">
              <div className="space-y-3">
                <div>
                  <label className="mb-2 block text-xs text-muted-foreground">快照</label>
                  <div className="flex flex-wrap gap-2">
                    {DOC_TYPES.map((dt) => (
                      <Button
                        key={`snapshot-${dt.key}`}
                        size="sm"
                        variant="outline"
                        onClick={() => handleSnapshot(dt.key)}
                        disabled={snapshotLoading === dt.key}
                      >
                        {snapshotLoading === dt.key ? '创建中...' : `${dt.label} 快照`}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-2 block text-xs text-muted-foreground">清理</label>
                  <div className="flex flex-wrap gap-2">
                    {DOC_TYPES.map((dt) => (
                      <Button
                        key={`cleanup-${dt.key}`}
                        size="sm"
                        variant="outline"
                        onClick={() => handleCleanup(dt.key)}
                        disabled={cleanupLoading === dt.key}
                      >
                        {cleanupLoading === dt.key ? '清理中...' : `${dt.label} 清理`}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </SettingCard>
          )}

          <Button
            variant="destructive"
            onClick={handleLeaveTeam}
            disabled={leaving}
          >
            {leaving ? '离开中...' : '离开团队'}
          </Button>
        </>
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
