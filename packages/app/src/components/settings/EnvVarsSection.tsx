import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Plus, Eye, EyeOff, Pencil, Trash2, ShieldCheck, AlertCircle, Users, User, Lock, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard, SectionHeader } from './shared'
import { useEnvVarsStore } from '@/stores/env-vars'
import { useTeamMembersStore } from '@/stores/team-members'
import { useTeamPermissions } from '@/lib/team-permissions'
import { encodeWorkspaceId, reloadDaemonRuntime } from '@/lib/daemon-local-client'
import { useWorkspaceStore } from '@/stores/workspace'
import { toast } from 'sonner'
import { listen } from '@tauri-apps/api/event'

// ─── Unified type for the combined list ─────────────────────────────────

type UnifiedEntry =
  | { scope: 'personal'; key: string; description?: string; category?: 'system' | 'system-shared' | null; dirty?: boolean }
  | { scope: 'team'; key: string; description: string; category: string; createdBy: string; updatedBy: string; updatedAt: string; dirty?: boolean }
  // Placeholder shown when a `system-shared` system def exists but the team secret
  // has not yet been set. Edit-saves default to "Share with team".
  | { scope: 'team-placeholder'; key: string; description?: string; category: 'system-shared'; dirty?: boolean }

// ─── Add / Edit Dialog ──────────────────────────────────────────────────

interface EnvVarDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingEntry?: UnifiedEntry | null
  onSave: (key: string, value: string, description: string, shared: boolean) => Promise<void>
}

function EnvVarDialog({ open, onOpenChange, editingEntry, onSave }: EnvVarDialogProps) {
  const { t } = useTranslation()
  const { role } = useTeamPermissions()
  const teamAvailable = role !== null
  const [key, setKey] = React.useState('')
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [shared, setShared] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [showValue, setShowValue] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const isEditing = !!editingEntry
  // `system-shared` placeholders haven't been saved yet; treat the dialog as a
  // first-time create so a value is required and the key+description are seeded
  // from the system definition.
  const isPlaceholder = editingEntry?.scope === 'team-placeholder'
  const isFirstSave = !isEditing || isPlaceholder
  // Lock the key for system / system-shared / placeholder rows so the user can't
  // rename a system-managed entry into something else.
  const lockedKey =
    isPlaceholder ||
    (editingEntry?.scope === 'personal' && editingEntry.category === 'system') ||
    editingEntry?.scope === 'team'

  React.useEffect(() => {
    if (open) {
      setShowValue(false)
      if (editingEntry) {
        setKey(editingEntry.key)
        setDescription(editingEntry.description || '')
        // Default-share when editing a team secret OR a system-shared placeholder,
        // but only if a team is actually available.
        setShared(
          teamAvailable &&
            (editingEntry.scope === 'team' || editingEntry.scope === 'team-placeholder'),
        )
        setValue('')
      } else {
        setKey('')
        setValue('')
        setDescription('')
        setShared(false)
      }
      setError(null)
    }
  }, [open, editingEntry, teamAvailable])

  const handleSave = async () => {
    const trimmedKey = key.trim()
    if (!trimmedKey) {
      setError(t('settings.envVars.error.keyRequired', 'Key is required'))
      return
    }
    if (!value && isFirstSave) {
      setError(t('settings.envVars.error.valueRequired', 'Value is required'))
      return
    }
    if (!value && isEditing && !isPlaceholder) {
      setError(t('settings.envVars.error.valueRequired', 'Please enter the new value'))
      return
    }
    // shared team keys must be lowercase server-side. For system-shared
    // placeholder rows the displayed key is uppercase (matches the env-var name
    // autoui-mcp reads), but the dialog stores the lowercase form transparently
    // — so we accept either case here and let `onSave` normalize.
    if (shared) {
      const probe = isPlaceholder ? trimmedKey.toLowerCase() : trimmedKey
      if (!/^[a-z0-9_]+$/.test(probe) || probe.length > 64) {
        setError(t('settings.envVars.error.invalidKeyShared', 'Shared key must be lowercase letters, digits, underscores (max 64 chars)'))
        return
      }
    } else {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
        setError(t('settings.envVars.error.invalidKey', 'Key must contain only letters, digits, and underscores'))
        return
      }
    }

    setSaving(true)
    setError(null)
    try {
      // Lowercase the key when saving a system-shared placeholder as a team
      // secret — the displayed name is uppercase (env-var convention) but
      // Team keys are stored lowercase; the agent injects both cases at startup.
      const outboundKey = isPlaceholder && shared ? trimmedKey.toLowerCase() : trimmedKey
      await onSave(outboundKey, value, description.trim() || '', shared)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('settings.envVars.editTitle', 'Edit Environment Variable')
              : t('settings.envVars.addTitle', 'Add Environment Variable')}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t('settings.envVars.editDescription', 'Update the value for this environment variable.')
              : t('settings.envVars.addDescription', 'Add a new secret that will be stored securely.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-[13px] font-medium">
              {t('settings.envVars.key', 'Key')}
            </label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={shared ? 'openai_api_key' : 'MY_API_KEY'}
              disabled={lockedKey}
              autoFocus={!lockedKey}
            />
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">
              {t('settings.envVars.value', 'Value')}
            </label>
            <div className="relative">
              <Input
                type={showValue ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={isEditing ? '••••••••' : 'sk-...'}
                autoFocus={isEditing}
                className="pr-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => setShowValue((v) => !v)}
                tabIndex={-1}
                title={showValue ? t('settings.envVars.hideValue', 'Hide value') : t('settings.envVars.showValue', 'Show value')}
              >
                {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">
              {t('settings.envVars.description', 'Description')}
              <span className="text-muted-foreground font-normal ml-1">
                ({t('settings.envVars.optional', 'optional')})
              </span>
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.envVars.descriptionPlaceholder', 'e.g. OpenAI API key for production')}
            />
          </div>

          {/* Share with team checkbox — locked for system-shared placeholders
              (always team-shared) and existing team secrets (scope is fixed).
              Hidden entirely when the user has not joined a team. */}
          {teamAvailable && (
            <>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="shared"
                  checked={shared}
                  onCheckedChange={(checked) => setShared(checked === true)}
                  disabled={isEditing || isPlaceholder}
                />
                <label htmlFor="shared" className="text-[13px] font-medium cursor-pointer select-none flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-blue-500" />
                  {t('settings.envVars.shareWithTeam', 'Share with team')}
                </label>
              </div>
              {shared && isFirstSave && (
                <p className="text-xs text-muted-foreground ml-6">
                  {t('settings.envVars.shareHint', 'This variable will be encrypted and synced to all team members.')}
                </p>
              )}
            </>
          )}

          {error && (
            <p className="text-[13px] text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? t('common.saving', 'Saving...')
              : t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Delete Confirmation Dialog ─────────────────────────────────────────

interface DeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  envVarKey: string
  onConfirm: () => Promise<void>
}

function DeleteDialog({ open, onOpenChange, envVarKey, onConfirm }: DeleteDialogProps) {
  const { t } = useTranslation()
  const [deleting, setDeleting] = React.useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.envVars.deleteTitle', 'Delete Environment Variable')}</DialogTitle>
          <DialogDescription>
            {t('settings.envVars.deleteDescription', 'Are you sure you want to delete "{{key}}"? This will remove the secret and cannot be undone.', { key: envVarKey })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? t('common.deleting', 'Deleting...') : t('common.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Env Var Row ────────────────────────────────────────────────────────

interface EnvVarRowProps {
  entry: UnifiedEntry
  canDelete: boolean
  onEdit: (entry: UnifiedEntry) => void
  onDelete: (key: string) => void
}

function EnvVarRow({ entry, canDelete, onEdit, onDelete }: EnvVarRowProps) {
  const { t } = useTranslation()
  const [revealed, setRevealed] = React.useState(false)
  const [revealedValue, setRevealedValue] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const { getEnvVarValue } = useEnvVarsStore()

  const isSystem = entry.scope === 'personal' && entry.category === 'system'
  const isSystemShared = entry.category === 'system-shared'
  const isPersonal = entry.scope === 'personal'
  const isPlaceholder = entry.scope === 'team-placeholder'

  const handleReveal = async () => {
    if (!isPersonal) return // Team secrets / placeholders cannot be revealed
    if (revealed) {
      setRevealed(false)
      setRevealedValue(null)
      return
    }
    setLoading(true)
    try {
      const value = await getEnvVarValue(entry.key)
      setRevealedValue(value)
      setRevealed(true)
      setTimeout(() => {
        setRevealed(false)
        setRevealedValue(null)
      }, 5000)
    } catch {
      setRevealedValue(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-between py-3 px-1 group">
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <code className="text-[13px] font-mono font-medium bg-muted px-2 py-0.5 rounded">
            {entry.key}
          </code>
          {isSystemShared ? (
            // System-managed key whose value is team-shared: show both badges so
            // the user knows it's auto-registered AND syncs across the team.
            <>
              <span className="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
                <Lock className="h-3 w-3" />
                {t('settings.envVars.scopeSystem', 'System')}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded">
                <Users className="h-3 w-3" />
                {t('settings.envVars.scopeTeam', 'Team')}
              </span>
            </>
          ) : isSystem ? (
            <span className="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
              <Lock className="h-3 w-3" />
              {t('settings.envVars.scopeSystem', 'System')}
            </span>
          ) : isPersonal ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              <User className="h-3 w-3" />
              {t('settings.envVars.scopePersonal', 'Personal')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded">
              <Users className="h-3 w-3" />
              {t('settings.envVars.scopeTeam', 'Team')}
            </span>
          )}
          {isPlaceholder && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
              <AlertCircle className="h-3 w-3" />
              {t('settings.envVars.notConfigured', 'Not configured')}
            </span>
          )}
          {entry.dirty && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
              <AlertCircle className="h-3 w-3" />
              {t('settings.envVars.needRestart', 'Need restart')}
            </span>
          )}
        </div>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {entry.description}
          </p>
        )}
        {isPersonal && revealed && revealedValue !== null && (
          <div className="flex items-center gap-1 mt-1">
            <p className="text-xs font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded break-all flex-1 min-w-0">
              {revealedValue}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={async () => {
                await navigator.clipboard.writeText(revealedValue)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              title={t('common.copy', 'Copy')}
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {isPersonal && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleReveal}
            disabled={loading}
            title={revealed
              ? t('settings.envVars.hide', 'Hide value')
              : t('settings.envVars.reveal', 'Reveal value')}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onEdit(entry)}
          title={t('settings.envVars.edit', 'Edit')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {canDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => onDelete(entry.key)}
            title={t('settings.envVars.delete', 'Delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Main Section ───────────────────────────────────────────────────────

export const EnvVarsSection = React.memo(function EnvVarsSection() {
  const { t } = useTranslation()
  const { envVars, teamSecrets, isLoading: envLoading, loadEnvCatalog, setCatalogEntry, deleteCatalogEntry } = useEnvVarsStore()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  // currentNodeId is hydrated here (and via useAppInit) since the Team panel no longer owns it.
  const loadCurrentNodeId = useTeamMembersStore((s) => s.loadCurrentNodeId)
  const { isOwner } = useTeamPermissions()

  const [addDialogOpen, setAddDialogOpen] = React.useState(false)
  const [editingEntry, setEditingEntry] = React.useState<UnifiedEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<UnifiedEntry | null>(null)
  const [dirtyKeys, setDirtyKeys] = React.useState<Set<string>>(new Set())

  const isLoading = envLoading

  React.useEffect(() => {
    if (!workspacePath) return

    void (async () => {
      await loadEnvCatalog()
      const err = useEnvVarsStore.getState().error
      if (err) {
        toast.error(t('settings.envVars.loadFailed', 'Failed to load environment variables'), {
          description: err,
        })
      }
    })()

    loadCurrentNodeId()
    let unlistenSync: (() => void) | undefined
    listen<void>('secrets-changed', () => {
      void (async () => {
        await loadEnvCatalog()
        const err = useEnvVarsStore.getState().error
        if (err) {
          toast.error(t('settings.envVars.loadFailed', 'Failed to load environment variables'), {
            description: err,
          })
        }
      })()
      setDirtyKeys((prev) => {
        const next = new Set(prev)
        next.add('__team_sync__')
        return next
      })
    }).then((fn) => { unlistenSync = fn })
    return () => {
      unlistenSync?.()
    }
  }, [loadEnvCatalog, loadCurrentNodeId, workspacePath, t])

  // Build unified list: personal env vars + team secrets, with `system-shared`
  // system defs surfaced as either the matching team secret (uppercase key) or
  // a placeholder row when no value has been set yet.
  const hasSyncDirty = dirtyKeys.has('__team_sync__')
  const unifiedEntries: UnifiedEntry[] = React.useMemo(() => {
    const sharedSystemDefs = envVars.filter((e) => e.category === 'system-shared')
    // lowercase(secretKey) -> matching system-shared def (so we can promote the
    // team secret's display key to the canonical uppercase name)
    const sharedSystemByLower = new Map(
      sharedSystemDefs.map((d) => [d.key.toLowerCase(), d] as const),
    )
    // Track which lowercase secret keys have been satisfied so we can suppress
    // the placeholder when a value already exists.
    const satisfiedLowerKeys = new Set<string>()

    const team: UnifiedEntry[] = teamSecrets.map((s) => {
      const lower = s.keyId.toLowerCase()
      const matched = sharedSystemByLower.get(lower)
      if (matched) {
        satisfiedLowerKeys.add(lower)
      }
      return {
        scope: 'team' as const,
        key: matched ? matched.key : s.keyId,
        description: matched?.description || s.description,
        category: matched ? 'system-shared' : s.category,
        createdBy: s.createdBy,
        updatedBy: s.updatedBy,
        updatedAt: s.updatedAt,
        dirty: dirtyKeys.has(s.keyId) || hasSyncDirty,
      }
    })

    const personal: UnifiedEntry[] = envVars
      // Drop `system-shared` defs from the personal bucket — they're either
      // promoted into `team` above or rendered as a `team-placeholder` below.
      .filter((e) => e.category !== 'system-shared')
      .map((e) => ({
        scope: 'personal' as const,
        key: e.key,
        description: e.description,
        category: e.category,
        dirty: dirtyKeys.has(e.key),
      }))

    const placeholders: UnifiedEntry[] = sharedSystemDefs
      .filter((d) => !satisfiedLowerKeys.has(d.key.toLowerCase()))
      .map((d) => ({
        scope: 'team-placeholder' as const,
        key: d.key,
        description: d.description,
        category: 'system-shared' as const,
        dirty: dirtyKeys.has(d.key),
      }))

    const all = [...team, ...placeholders, ...personal]
    // System entries (locally seeded) first, then everything else alphabetical.
    all.sort((a, b) => {
      const aIsSystem = a.scope === 'personal' && a.category === 'system'
      const bIsSystem = b.scope === 'personal' && b.category === 'system'
      if (aIsSystem && !bIsSystem) return -1
      if (!aIsSystem && bIsSystem) return 1
      return a.key.localeCompare(b.key)
    })
    return all
  }, [envVars, teamSecrets, dirtyKeys, hasSyncDirty])

  async function reloadRuntimeAfterEnvChange(key: string) {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) return
    try {
      await reloadDaemonRuntime(encodeWorkspaceId(workspacePath))
      setDirtyKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        next.delete('__team_sync__')
        return next
      })
    } catch (err) {
      toast.warning('环境变量已保存，但 Agent 运行时重载失败', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleSave = async (key: string, value: string, description: string, shared: boolean) => {
    if (shared) {
      await setCatalogEntry('team', key, value, {
        description,
        category: 'custom',
        nodeId: currentNodeId ?? '',
      })
    } else {
      await setCatalogEntry('personal', key, value, { description: description || undefined })
    }
    await reloadRuntimeAfterEnvChange(key)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const deletedKey = deleteTarget.key
    if (deleteTarget.scope === 'team') {
      await deleteCatalogEntry('team', deleteTarget.key, {
        nodeId: currentNodeId ?? '',
        role: isOwner ? 'owner' : 'member',
      })
    } else if (deleteTarget.scope === 'personal') {
      await deleteCatalogEntry('personal', deleteTarget.key)
    }
    // Placeholders have no backing storage to delete.
    setDeleteTarget(null)
    await reloadRuntimeAfterEnvChange(deletedKey)
  }

  // env_catalog_delete enforces the system-var guard server-side for personal scope.
  const canDeleteEntry = (entry: UnifiedEntry): boolean => {
    if (entry.scope === 'team-placeholder') return false
    if (entry.scope === 'personal' && (entry.category === 'system' || entry.category === 'system-shared')) return false
    if (entry.scope === 'personal') return true
    if (entry.scope === 'team' && entry.category === 'system-shared') return false
    if (isOwner) return true
    if (entry.scope === 'team' && entry.createdBy === currentNodeId) return true
    return false
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={KeyRound}
        title={t('settings.envVars.title', 'Environment Variables')}
        description={t('settings.envVars.sectionDescription', 'Securely store API keys, passwords, and other secrets in your system keychain')}
        iconColor="text-emerald-500"
      />

      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">
          {unifiedEntries.length > 0
            ? t('settings.envVars.count', '{{count}} variable(s) stored', { count: unifiedEntries.length })
            : ''}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setAddDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            {t('settings.envVars.add', 'Add Variable')}
          </Button>
        </div>
      </div>

      {/* List or empty state */}
      {isLoading && unifiedEntries.length === 0 ? (
        <SettingCard>
          <div className="flex items-center justify-center py-8 text-muted-foreground text-[13px]">
            {t('common.loading', 'Loading...')}
          </div>
        </SettingCard>
      ) : unifiedEntries.length === 0 ? (
        <SettingCard className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 border-emerald-200 dark:border-emerald-800">
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <ShieldCheck className="h-10 w-10 text-emerald-500 mb-3" />
            <h4 className="font-medium mb-1">
              {t('settings.envVars.emptyTitle', 'No environment variables yet')}
            </h4>
            <p className="text-[13px] text-muted-foreground max-w-sm">
              {t('settings.envVars.emptyDescription', 'Store your API keys and passwords securely. Values are encrypted using your system keychain (macOS Keychain / Windows Credential Manager).')}
            </p>
            <Button size="sm" className="mt-4" onClick={() => setAddDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('settings.envVars.addFirst', 'Add Your First Variable')}
            </Button>
          </div>
        </SettingCard>
      ) : (
        <SettingCard>
          <div className="divide-y">
            {unifiedEntries.map((entry) => (
              <EnvVarRow
                key={`${entry.scope}-${entry.key}`}
                entry={entry}
                canDelete={canDeleteEntry(entry)}
                onEdit={(e) => setEditingEntry(e)}
                onDelete={() => setDeleteTarget(entry)}
              />
            ))}
          </div>
        </SettingCard>
      )}

      {/* Hint */}
      <SettingCard>
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-emerald-500 mt-0.5 shrink-0" />
          <div className="text-[13px] text-muted-foreground">
            <p className="font-medium text-foreground mb-1">
              {t('settings.envVars.hintTitle', 'How it works')}
            </p>
            <p>
              {t('settings.envVars.hintBody', 'Values are stored in your operating system\'s native keychain, not in config files. Use ${KEY_NAME} syntax in MCP server environment variables or other configs to reference these secrets.')}
            </p>
            <p className="mt-1">
              {t('settings.envVars.hintTeam', 'Team variables are encrypted and synced to all team members. They cannot be viewed after saving.')}
            </p>
          </div>
        </div>
      </SettingCard>

      {/* Dialogs */}
      <EnvVarDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onSave={handleSave}
      />

      <EnvVarDialog
        open={!!editingEntry}
        onOpenChange={(open) => { if (!open) setEditingEntry(null) }}
        editingEntry={editingEntry}
        onSave={handleSave}
      />

      <DeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        envVarKey={deleteTarget?.key || ''}
        onConfirm={handleDelete}
      />
    </div>
  )
})
