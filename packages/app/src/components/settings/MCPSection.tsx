import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plug,
  Loader2,
  X,
  Plus,
  RefreshCw,
  Trash2,
  Edit2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Lock,
  Shield,
} from 'lucide-react'

import { invoke } from '@tauri-apps/api/core'
import { useMCPStore, type MCPServerConfig } from '@/stores/mcp'
import { useDepsStore } from '@/stores/deps'
import { useWorkspaceStore } from '@/stores/workspace'
import { initOpenCodeClient } from '@/lib/opencode/client'
import type { MCPServerStatus } from '@/lib/opencode/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard, SectionHeader, ToggleSwitch } from './shared'
import { AddMCPDialog } from './AddMCPDialog'

// MCP names that are always auto-injected by TeamClaw and cannot be deleted
const INHERENT_MCP_NAMES = new Set(['playwright', 'autoui'])

// Status indicator component
function StatusDot({ status }: { status?: MCPServerStatus }) {
  const color = !status ? 'bg-gray-400'
    : status === 'connected' ? 'bg-emerald-500'
    : status === 'disabled' ? 'bg-gray-400'
    : status === 'failed' ? 'bg-red-500'
    : status === 'needs_auth' ? 'bg-amber-500'
    : 'bg-amber-500'

  return <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', color)} />
}

// Server initial avatar (like Cursor's letter circle)
function ServerAvatar({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase()
  return (
    <div className="flex items-center justify-center h-10 w-10 rounded-full bg-muted text-muted-foreground text-sm font-semibold shrink-0">
      {initial}
    </div>
  )
}

// Tool chip component
function ToolChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-muted text-xs font-mono text-muted-foreground">
      {name}
    </span>
  )
}

// Server status summary with optional tool count (like Cursor's "7 tools enabled" / "Disabled")
function ServerStatusSummary({
  tools,
  status,
  error,
  expanded,
  onToggle,
}: {
  tools: string[]
  status?: MCPServerStatus
  error?: string
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()

  // For connected servers with tools, show expandable tool count
  if (status === 'connected' && tools.length > 0) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <StatusDot status="connected" />
        <span>{t('settings.mcp.toolsEnabled', { count: tools.length })}</span>
        {expanded ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>
    )
  }

  // For other statuses, show a status label
  const label = !status ? null
    : status === 'connected' ? t('settings.mcp.statusConnected')
    : status === 'disabled' ? t('settings.mcp.statusDisabled')
    : status === 'failed' ? (error || t('settings.mcp.statusNotConnected'))
    : status === 'needs_auth' ? t('settings.mcp.statusNeedsAuth')
    : t('settings.mcp.statusPending')

  if (!label) return null

  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 text-xs',
      status === 'connected' ? 'text-emerald-600 dark:text-emerald-400'
        : status === 'failed' ? 'text-red-500 dark:text-red-400'
        : 'text-muted-foreground'
    )}>
      <StatusDot status={status} />
      {label}
    </span>
  )
}

// Single MCP server row
function MCPServerRow({
  name,
  config,
  runtimeStatus,
  runtimeError,
  tools,
  nodeInstalled,
  isInherent,
  onToggle,
  onEdit,
  onDelete,
}: {
  name: string
  config: MCPServerConfig
  runtimeStatus?: MCPServerStatus
  runtimeError?: string
  tools: string[]
  nodeInstalled: boolean
  isInherent?: boolean
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const enabled = config.enabled !== false

  const requiresNode = (): boolean => {
    if (config.type !== 'local' || !config.command) return false
    const cmd = config.command[0]?.toLowerCase() || ''
    return cmd === 'npx' || cmd === 'node' || cmd === 'npm'
  }

  const getDescription = () => {
    if (config.type === 'local') {
      return config.command?.join(' ') || t('settings.mcp.localServer')
    }
    return config.url || t('settings.mcp.remoteServer')
  }

  // Determine effective status for display
  const effectiveStatus = runtimeStatus || (enabled ? undefined : 'disabled' as MCPServerStatus)

  return (
    <SettingCard
      className={cn(
        'transition-all',
        isInherent ? 'border-blue-200/60 dark:border-blue-800/40 bg-blue-50/30 dark:bg-blue-950/10' : '',
        !isInherent && enabled && runtimeStatus === 'connected' ? 'border-primary/20' : ''
      )}
    >
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <ServerAvatar name={name} />

        {/* Server info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{name}</span>
            {isInherent && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 border border-blue-200/60 dark:border-blue-700/50">
                <Shield className="h-2.5 w-2.5" />
                {t('settings.mcp.inherent')}
              </span>
            )}
          </div>
          {/* Description: command/URL */}
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {getDescription()}
          </p>
          {/* Node.js warning */}
          {!nodeInstalled && requiresNode() && (
            <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 mt-1">
              <AlertCircle className="h-3 w-3" />
              <span>{t('settings.mcp.nodeNotInstalled')}</span>
            </div>
          )}
          {/* Status summary with optional tool count */}
          <div className="mt-1">
            <ServerStatusSummary
              tools={tools}
              status={effectiveStatus}
              error={runtimeError}
              expanded={expanded}
              onToggle={() => setExpanded(!expanded)}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onEdit}
          >
            <Edit2 className="h-4 w-4" />
          </Button>
          {isInherent ? (
            <div
              className="h-8 w-8 flex items-center justify-center text-blue-400/60 dark:text-blue-500/50 cursor-not-allowed"
              title={t('settings.mcp.inherentCannotDelete')}
            >
              <Lock className="h-3.5 w-3.5" />
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <ToggleSwitch
            enabled={enabled}
            onChange={onToggle}
          />
        </div>
      </div>

      {/* Expanded tool list */}
      {expanded && tools.length > 0 && (
        <div className="mt-3 pt-3 border-t flex flex-wrap gap-1.5">
          {tools.map((tool) => (
            <ToolChip key={tool} name={tool} />
          ))}
        </div>
      )}
    </SettingCard>
  )
}

export const MCPSection = React.memo(function MCPSection() {
  const { t } = useTranslation()
  const servers = useMCPStore((s) => s.servers)
  const runtimeStatus = useMCPStore((s) => s.runtimeStatus)
  const serverTools = useMCPStore((s) => s.serverTools)
  const isLoading = useMCPStore((s) => s.isLoading)
  const error = useMCPStore((s) => s.error)
  const hasChanges = useMCPStore((s) => s.hasChanges)
  const loadConfig = useMCPStore((s) => s.loadConfig)
  const loadRuntimeStatus = useMCPStore((s) => s.loadRuntimeStatus)
  const loadTools = useMCPStore((s) => s.loadTools)
  const addServer = useMCPStore((s) => s.addServer)
  const updateServer = useMCPStore((s) => s.updateServer)
  const removeServer = useMCPStore((s) => s.removeServer)
  const toggleServer = useMCPStore((s) => s.toggleServer)
  const setHasChanges = useMCPStore((s) => s.setHasChanges)
  const clearError = useMCPStore((s) => s.clearError)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingServer, setEditingServer] = React.useState<{ name: string; config: MCPServerConfig } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null)
  const [isRestarting, setIsRestarting] = React.useState(false)
  const [restartError, setRestartError] = React.useState<string | null>(null)

  // Load config on mount
  React.useEffect(() => {
    loadConfig()
  }, [loadConfig])

  // Load runtime status and tools after config is loaded
  React.useEffect(() => {
    if (Object.keys(servers).length > 0) {
      loadRuntimeStatus()
      loadTools()
    }
  }, [servers, loadRuntimeStatus, loadTools])

  // Poll runtime status periodically (tools are cached, no need to re-query often)
  React.useEffect(() => {
    const interval = setInterval(() => {
      loadRuntimeStatus()
    }, 10000) // Every 10 seconds
    return () => clearInterval(interval)
  }, [loadRuntimeStatus])

  const handleAddServer = async (name: string, config: MCPServerConfig) => {
    await addServer(name, config)
  }

  const handleUpdateServer = async (name: string, config: MCPServerConfig) => {
    await updateServer(name, config)
    setEditingServer(null)
  }

  const handleDeleteServer = async (name: string) => {
    await removeServer(name)
    setDeleteConfirm(null)
  }

  const handleToggleServer = async (name: string, enabled: boolean) => {
    await toggleServer(name, enabled)
  }

  const handleRestartOpenCode = async () => {
    if (!workspacePath) {
      setRestartError(t('settings.mcp.noWorkspace', 'No workspace selected'))
      return
    }

    setIsRestarting(true)
    setRestartError(null)
    try {
      await invoke('stop_opencode')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const status = await invoke<{ url: string }>('start_opencode', {
        config: { workspace_path: workspacePath },
      })
      initOpenCodeClient({ baseUrl: status.url })
      setHasChanges(false)
      // Reload runtime status and tools after restart
      setTimeout(() => {
        loadRuntimeStatus()
        loadTools()
      }, 3000)
    } catch (err) {
      console.error('Failed to restart OpenCode:', err)
      setRestartError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRestarting(false)
    }
  }

  const allEntries = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))
  const inherentEntries = allEntries.filter(([name]) => INHERENT_MCP_NAMES.has(name))
  const customEntries = allEntries.filter(([name]) => !INHERENT_MCP_NAMES.has(name))
  const nodeInstalled = useDepsStore((s) => s.isInstalled('node'))

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Plug}
        title={t('settings.mcp.title', 'MCP Servers')}
        description={t('settings.mcp.description', 'Manage Model Context Protocol server connections')}
        iconColor="text-orange-500"
      />

      {/* Restart Warning */}
      {hasChanges && (
        <SettingCard className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                {t('settings.mcp.configChanged', 'Configuration Changed')}
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                {t('settings.mcp.restartToApply', 'Restart OpenCode to apply the new MCP configuration.')}
              </p>
              {restartError && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-2">
                  {t('common.error', 'Error')}: {restartError}
                </p>
              )}
            </div>
            <Button
              size="sm"
              onClick={handleRestartOpenCode}
              disabled={isRestarting || !workspacePath}
              className="gap-2"
            >
              {isRestarting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('settings.mcp.restarting', 'Restarting...')}
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3" />
                  {t('settings.mcp.restart', 'Restart')}
                </>
              )}
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Error Message */}
      {error && (
        <SettingCard className="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-red-900 dark:text-red-100">{t('common.error', 'Error')}</p>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1">{error}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={clearError}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Loading State */}
      {isLoading && allEntries.length === 0 && (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      )}

      {/* Empty State */}
      {!isLoading && allEntries.length === 0 && (
        <SettingCard>
          <div className="text-center py-8">
            <Plug className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground mb-2">{t('settings.mcp.noServers', 'No MCP servers configured')}</p>
            <p className="text-sm text-muted-foreground">
              {t('settings.mcp.addServerHint', "Add an MCP server to extend OpenCode's capabilities")}
            </p>
          </div>
        </SettingCard>
      )}

      {/* Inherent MCP Servers */}
      {inherentEntries.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Shield className="h-3.5 w-3.5 text-blue-500" />
            <span className="text-xs font-medium text-blue-600 dark:text-blue-400 uppercase tracking-wide">
              {t('settings.mcp.inherentMCP')}
            </span>
            <div className="flex-1 h-px bg-blue-200/60 dark:bg-blue-800/40" />
            <span className="text-xs text-muted-foreground">{t('settings.mcp.managedByTeamClaw')}</span>
          </div>
          {inherentEntries.map(([name, config]) => {
            const runtime = runtimeStatus[name]
            const tools = serverTools[name] || []
            return (
              <MCPServerRow
                key={name}
                name={name}
                config={config}
                runtimeStatus={runtime?.status}
                runtimeError={runtime?.error}
                tools={tools}
                nodeInstalled={nodeInstalled}
                isInherent
                onToggle={(enabled) => handleToggleServer(name, enabled)}
                onEdit={() => {
                  setEditingServer({ name, config })
                  setDialogOpen(true)
                }}
                onDelete={() => setDeleteConfirm(name)}
              />
            )
          })}
        </div>
      )}

      {/* Custom MCP Servers */}
      {customEntries.length > 0 && (
        <div className="space-y-3">
          {inherentEntries.length > 0 && (
            <div className="flex items-center gap-2">
              <Plug className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('settings.mcp.customMCP')}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}
          {customEntries.map(([name, config]) => {
            const runtime = runtimeStatus[name]
            const tools = serverTools[name] || []
            return (
              <MCPServerRow
                key={name}
                name={name}
                config={config}
                runtimeStatus={runtime?.status}
                runtimeError={runtime?.error}
                tools={tools}
                nodeInstalled={nodeInstalled}
                onToggle={(enabled) => handleToggleServer(name, enabled)}
                onEdit={() => {
                  setEditingServer({ name, config })
                  setDialogOpen(true)
                }}
                onDelete={() => setDeleteConfirm(name)}
              />
            )
          })}
        </div>
      )}

      {/* Add Server Button */}
      <Button
        variant="outline"
        className="w-full h-11 gap-2 border-dashed"
        onClick={() => {
          setEditingServer(null)
          setDialogOpen(true)
        }}
      >
        <Plus className="h-4 w-4" />
        {t('settings.mcp.addServer', 'Add MCP Server')}
      </Button>

      {/* Add/Edit Dialog */}
      <AddMCPDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditingServer(null)
        }}
        editingServer={editingServer}
        onSave={editingServer ? handleUpdateServer : handleAddServer}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.deleteTitle', 'Delete MCP Server')}</DialogTitle>
            <DialogDescription>
              {t('settings.mcp.deleteConfirm', { name: deleteConfirm, defaultValue: `Are you sure you want to delete "${deleteConfirm}"? This action cannot be undone.` })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && handleDeleteServer(deleteConfirm)}
            >
              {t('fileExplorer.delete', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
