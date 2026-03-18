import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Shield,
  Trash2,
  RefreshCw,
  Loader2,
  Terminal,
  FileEdit,
  FileText,
  Check,
  X,
  AlertTriangle,
  Save,
  Database,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useWorkspaceStore } from '@/stores/workspace'
import { cn, isTauri } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingCard, SectionHeader } from './shared'
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs'

type PermissionAction = 'allow' | 'ask' | 'deny'

interface PermissionRule {
  permission: string
  pattern: string
  action: string
}

interface AllowlistRow {
  project_id: string
  rules: PermissionRule[]
  time_created?: number
  time_updated?: number
}

interface PermissionConfig {
  read?: PermissionAction
  glob?: PermissionAction
  grep?: PermissionAction
  list?: PermissionAction
  codesearch?: PermissionAction
  todoread?: PermissionAction
  todowrite?: PermissionAction
  question?: PermissionAction
  webfetch?: PermissionAction
  websearch?: PermissionAction
  edit?: PermissionAction
  write?: PermissionAction
  bash?: PermissionAction
  task?: PermissionAction
  lsp?: PermissionAction
  skill?: PermissionAction
  external_directory?: PermissionAction
  doom_loop?: PermissionAction
}

// TeamClaw defaults: destructive operations require approval, read-only auto-approved.
// These are written to opencode.json on first launch if no permission section exists.
const PERMISSION_DEFAULTS: PermissionConfig = {
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  codesearch: 'allow',
  todoread: 'allow',
  todowrite: 'allow',
  question: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  edit: 'ask',
  write: 'ask',
  bash: 'ask',
  task: 'allow',
  lsp: 'allow',
  skill: 'allow',
  external_directory: 'ask',
  doom_loop: 'ask',
}

const PERMISSION_LABELS: Record<keyof PermissionConfig, { label: string; desc: string; icon: React.ElementType }> = {
  read: { label: 'Read Files', desc: 'Read file contents', icon: FileText },
  glob: { label: 'Glob', desc: 'File pattern matching', icon: FileText },
  grep: { label: 'Grep', desc: 'Search file contents', icon: FileText },
  list: { label: 'List', desc: 'List directory contents', icon: FileText },
  codesearch: { label: 'Code Search', desc: 'Search across codebase', icon: FileText },
  todoread: { label: 'Read Todos', desc: 'Read todo list', icon: FileText },
  todowrite: { label: 'Write Todos', desc: 'Update todo list', icon: FileEdit },
  question: { label: 'Ask Questions', desc: 'Interactive questions', icon: FileText },
  webfetch: { label: 'Web Fetch', desc: 'Fetch web content', icon: FileText },
  websearch: { label: 'Web Search', desc: 'Search the web', icon: FileText },
  edit: { label: 'Edit Files', desc: 'Modify file contents', icon: FileEdit },
  write: { label: 'Write Files', desc: 'Create/write files', icon: FileEdit },
  bash: { label: 'Bash Commands', desc: 'Execute shell commands', icon: Terminal },
  task: { label: 'Subagents', desc: 'Launch subagents', icon: FileText },
  lsp: { label: 'LSP Queries', desc: 'Language Server Protocol', icon: FileText },
  skill: { label: 'Skills', desc: 'Load skills', icon: FileText },
  external_directory: { label: 'External Dirs', desc: 'Access outside workspace', icon: FileText },
  doom_loop: { label: 'Doom Loop Guard', desc: 'Prevent infinite loops', icon: AlertTriangle },
}

export const PermissionManagementSection = React.memo(function PermissionManagementSection() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  // DB allowlist state
  const [allowlistRows, setAllowlistRows] = React.useState<AllowlistRow[]>([])
  const [loadingAllowlist, setLoadingAllowlist] = React.useState(false)
  const [currentProjectId, setCurrentProjectId] = React.useState<string | null>(null)

  // Permission config state
  const [permissionConfig, setPermissionConfig] = React.useState<PermissionConfig>({})
  const [loadingConfig, setLoadingConfig] = React.useState(false)
  const [savingConfig, setSavingConfig] = React.useState(false)
  const [configModified, setConfigModified] = React.useState(false)

  // Look up project_id from the DB project table based on workspace path
  const fetchProjectId = React.useCallback(async () => {
    if (!workspacePath || !isTauri()) return
    try {
      const pid = await invoke<string>('get_opencode_project_id', { workspacePath })
      setCurrentProjectId(pid)
    } catch (error) {
      console.error('[PermissionManagement] Failed to fetch project ID:', error)
      setCurrentProjectId('global')
    }
  }, [workspacePath])

  // Load allowlist from opencode.db via Tauri command
  const loadAllowlist = React.useCallback(async () => {
    if (!isTauri()) return

    setLoadingAllowlist(true)
    try {
      const rows = await invoke<AllowlistRow[]>('read_opencode_allowlist')
      setAllowlistRows(rows)
    } catch (error) {
      console.error('[PermissionManagement] Failed to load allowlist from DB:', error)
      setAllowlistRows([])
    } finally {
      setLoadingAllowlist(false)
    }
  }, [])

  // Remove a single rule
  const removeRule = React.useCallback(async (projectId: string, ruleIndex: number) => {
    const row = allowlistRows.find((r) => r.project_id === projectId)
    if (!row) return

    try {
      const updatedRules = row.rules.filter((_, i) => i !== ruleIndex)
      await invoke('write_opencode_allowlist', {
        projectId,
        rules: updatedRules,
      })
      await loadAllowlist()
    } catch (error) {
      console.error('[PermissionManagement] Failed to remove rule:', error)
    }
  }, [allowlistRows, loadAllowlist])

  // Load permission config from opencode.json
  const loadPermissionConfig = React.useCallback(async () => {
    if (!workspacePath) return

    setLoadingConfig(true)
    try {
      const configPath = `${workspacePath}/opencode.json`
      if (!(await exists(configPath))) {
        setPermissionConfig({})
        return
      }

      const content = await readTextFile(configPath)
      const config = JSON.parse(content)

      if (config.permission && typeof config.permission === 'object') {
        setPermissionConfig(config.permission as PermissionConfig)
      } else {
        setPermissionConfig({})
      }
    } catch (error) {
      console.error('[PermissionManagement] Failed to load config:', error)
    } finally {
      setLoadingConfig(false)
    }
  }, [workspacePath])

  // Save permission config to opencode.json and restart OpenCode to apply
  const savePermissionConfig = React.useCallback(async () => {
    if (!workspacePath) return

    setSavingConfig(true)
    try {
      const configPath = `${workspacePath}/opencode.json`

      let config: Record<string, unknown> = {}
      if (await exists(configPath)) {
        const content = await readTextFile(configPath)
        config = JSON.parse(content)
      }

      config.permission = permissionConfig

      await writeTextFile(configPath, JSON.stringify(config, null, 2))
      setConfigModified(false)

      // Restart OpenCode so the new permission config takes effect immediately
      try {
        await invoke('stop_opencode')
        await new Promise((resolve) => setTimeout(resolve, 500))
        await invoke('start_opencode', {
          config: { workspace_path: workspacePath },
        })
        console.log('[PermissionManagement] OpenCode restarted with new permissions')
      } catch (restartErr) {
        console.error('[PermissionManagement] Failed to restart OpenCode:', restartErr)
      }
    } catch (error) {
      console.error('[PermissionManagement] Failed to save config:', error)
    } finally {
      setSavingConfig(false)
    }
  }, [workspacePath, permissionConfig])

  // Update a single permission
  const updatePermission = React.useCallback((key: keyof PermissionConfig, value: PermissionAction) => {
    setPermissionConfig((prev) => ({ ...prev, [key]: value }))
    setConfigModified(true)
  }, [])

  // Load data on mount
  React.useEffect(() => {
    fetchProjectId()
    loadAllowlist()
    loadPermissionConfig()
  }, [fetchProjectId, loadAllowlist, loadPermissionConfig])

  // Only show rules for the current workspace project (and global), deduplicated.
  // Project-specific rules take precedence over global ones.
  const allRules = React.useMemo(() => {
    const result: Array<{ projectId: string; rule: PermissionRule; index: number }> = []
    const seen = new Set<string>()

    // Add project-specific rules first (higher priority)
    for (const row of allowlistRows) {
      if (row.project_id === 'global') continue
      if (currentProjectId && row.project_id !== currentProjectId) continue
      row.rules.forEach((rule, idx) => {
        const key = `${rule.permission}|${rule.pattern}|${rule.action}`
        if (!seen.has(key)) {
          seen.add(key)
          result.push({ projectId: row.project_id, rule, index: idx })
        }
      })
    }

    // Then add global rules that aren't already covered
    for (const row of allowlistRows) {
      if (row.project_id !== 'global') continue
      row.rules.forEach((rule, idx) => {
        const key = `${rule.permission}|${rule.pattern}|${rule.action}`
        if (!seen.has(key)) {
          seen.add(key)
          result.push({ projectId: row.project_id, rule, index: idx })
        }
      })
    }

    return result
  }, [allowlistRows, currentProjectId])

  if (!workspacePath) {
    return (
      <div>
        <SectionHeader
          icon={Shield}
          title={t('settings.permissions.title', 'Permission Management')}
          description={t('settings.permissions.desc', 'Manage agent permissions and command allowlist')}
          iconColor="text-emerald-500"
        />
        <SettingCard>
          <p className="text-sm text-muted-foreground">
            {t('settings.permissions.noWorkspace', 'No workspace selected. Please select a workspace first.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Shield}
        title={t('settings.permissions.title', 'Permission Management')}
        description={t('settings.permissions.desc', 'Manage agent permissions and command allowlist')}
        iconColor="text-emerald-500"
      />

      {/* Allowlist Section */}
      <SettingCard>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-amber-500" />
              {t('settings.permissions.allowlist', 'Command Allowlist')}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.permissions.allowlistDesc', 'Commands marked as "Always Allow". Takes effect after agent restart.')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadAllowlist}
            disabled={loadingAllowlist}
          >
            {loadingAllowlist ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>

        {loadingAllowlist ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : allRules.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            {t('settings.permissions.noAllowlist', 'No commands have been allowlisted yet')}
          </div>
        ) : (
          <div className="space-y-2">
            {allRules.map((entry) => (
              <div
                key={`${entry.projectId}-${entry.index}`}
                className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30"
              >
                <Terminal className="h-4 w-4 text-amber-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <code className="text-sm font-mono">{entry.rule.permission}: {entry.rule.pattern}</code>
                </div>
                <Badge
                  variant={entry.rule.action === 'allow' ? 'default' : 'destructive'}
                  className={cn(
                    'text-xs shrink-0',
                    entry.rule.action === 'allow' && 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20'
                  )}
                >
                  {entry.rule.action}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeRule(entry.projectId, entry.index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

      </SettingCard>

      {/* Permission Config Section */}
      <SettingCard>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-emerald-500" />
              {t('settings.permissions.config', 'Permission Configuration')}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.permissions.configDesc', 'Configure default permission policies for agent tools')}
            </p>
          </div>
          <div className="flex gap-2">
            {configModified && (
              <Button
                variant="default"
                size="sm"
                onClick={savePermissionConfig}
                disabled={savingConfig}
              >
                {savingConfig ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Save className="h-4 w-4 mr-1" />
                )}
                {savingConfig
                  ? t('settings.permissions.saving', 'Applying...')
                  : t('settings.permissions.saveAndApply', 'Save & Apply')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={loadPermissionConfig}
              disabled={loadingConfig}
            >
              {loadingConfig ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {loadingConfig ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {(Object.keys(PERMISSION_LABELS) as Array<keyof PermissionConfig>).map((key) => {
              const { label, desc, icon: Icon } = PERMISSION_LABELS[key]
              const value = permissionConfig[key] || PERMISSION_DEFAULTS[key] || 'allow'

              return (
                <div
                  key={key}
                  className="flex items-center gap-4 p-3 rounded-lg border bg-muted/20"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                  </div>
                  <Select
                    value={value}
                    onValueChange={(v) => updatePermission(key, v as PermissionAction)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">
                        <div className="flex items-center gap-2">
                          <Check className="h-3 w-3 text-green-500" />
                          {t('settings.permissions.allow', 'Allow')}
                        </div>
                      </SelectItem>
                      <SelectItem value="ask">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                          {t('settings.permissions.ask', 'Ask')}
                        </div>
                      </SelectItem>
                      <SelectItem value="deny">
                        <div className="flex items-center gap-2">
                          <X className="h-3 w-3 text-red-500" />
                          {t('settings.permissions.deny', 'Deny')}
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )
            })}
          </div>
        )}

        <div className="mt-4 pt-4 border-t">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Shield className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
            <div className="text-xs text-blue-600 dark:text-blue-400">
              <p className="font-medium mb-1">
                {t('settings.permissions.configInfo', 'Permission Actions')}
              </p>
              <ul className="space-y-1 list-disc list-inside">
                <li>
                  <strong>Allow</strong>: {t('settings.permissions.allowDesc', 'Auto-approve without prompting')}
                </li>
                <li>
                  <strong>Ask</strong>: {t('settings.permissions.askDesc', 'Prompt for approval each time')}
                </li>
                <li>
                  <strong>Deny</strong>: {t('settings.permissions.denyDesc', 'Block the action')}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </SettingCard>
    </div>
  )
})
