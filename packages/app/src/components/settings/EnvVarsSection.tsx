import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Plus, Eye, EyeOff, Pencil, Trash2, ShieldCheck, AlertCircle, RefreshCw, Loader2, Users, User } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
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
import { useEnvVarsStore, type EnvVarEntry } from '@/stores/env-vars'
import { useSharedSecretsStore, type SecretMeta } from '@/stores/shared-secrets'
import { useTeamMembersStore } from '@/stores/team-members'
import { useWorkspaceStore } from '@/stores/workspace'
import { initOpenCodeClient } from '@/lib/opencode/client'

// ─── Unified type for the combined list ─────────────────────────────────

type UnifiedEntry =
  | { scope: 'personal'; key: string; description?: string }
  | { scope: 'team'; key: string; description: string; category: string; updatedBy: string; updatedAt: string }

// ─── Add / Edit Dialog ──────────────────────────────────────────────────

interface EnvVarDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingEntry?: UnifiedEntry | null
  onSave: (key: string, value: string, description: string, shared: boolean) => Promise<void>
}

function EnvVarDialog({ open, onOpenChange, editingEntry, onSave }: EnvVarDialogProps) {
  const { t } = useTranslation()
  const [key, setKey] = React.useState('')
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [shared, setShared] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const isEditing = !!editingEntry

  React.useEffect(() => {
    if (open) {
      if (editingEntry) {
        setKey(editingEntry.key)
        setDescription(editingEntry.description || '')
        setShared(editingEntry.scope === 'team')
        setValue('')
      } else {
        setKey('')
        setValue('')
        setDescription('')
        setShared(false)
      }
      setError(null)
    }
  }, [open, editingEntry])

  const handleSave = async () => {
    const trimmedKey = key.trim()
    if (!trimmedKey) {
      setError(t('settings.envVars.error.keyRequired', 'Key is required'))
      return
    }
    if (!value && !isEditing) {
      setError(t('settings.envVars.error.valueRequired', 'Value is required'))
      return
    }
    if (!value && isEditing) {
      setError(t('settings.envVars.error.valueRequired', 'Please enter the new value'))
      return
    }
    if (shared) {
      if (!/^[a-z0-9_]+$/.test(trimmedKey) || trimmedKey.length > 64) {
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
      await onSave(trimmedKey, value, description.trim() || '', shared)
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
            <label className="text-sm font-medium">
              {t('settings.envVars.key', 'Key')}
            </label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={shared ? 'openai_api_key' : 'MY_API_KEY'}
              disabled={isEditing}
              autoFocus={!isEditing}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('settings.envVars.value', 'Value')}
            </label>
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isEditing ? '••••••••' : 'sk-...'}
              autoFocus={isEditing}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
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

          {/* Share with team checkbox */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="shared"
              checked={shared}
              onCheckedChange={(checked) => setShared(checked === true)}
              disabled={isEditing}
            />
            <label htmlFor="shared" className="text-sm font-medium cursor-pointer select-none flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-blue-500" />
              {t('settings.envVars.shareWithTeam', 'Share with team')}
            </label>
          </div>
          {shared && !isEditing && (
            <p className="text-xs text-muted-foreground ml-6">
              {t('settings.envVars.shareHint', 'This variable will be encrypted and synced to all team members.')}
            </p>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
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
  onEdit: (entry: UnifiedEntry) => void
  onDelete: (key: string) => void
}

function EnvVarRow({ entry, onEdit, onDelete }: EnvVarRowProps) {
  const { t } = useTranslation()
  const [revealed, setRevealed] = React.useState(false)
  const [revealedValue, setRevealedValue] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const { getEnvVarValue } = useEnvVarsStore()

  const isPersonal = entry.scope === 'personal'

  const handleReveal = async () => {
    if (!isPersonal) return // Team secrets cannot be revealed
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
          <code className="text-sm font-mono font-medium bg-muted px-2 py-0.5 rounded">
            {entry.key}
          </code>
          {isPersonal ? (
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
        </div>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {entry.description}
          </p>
        )}
        {isPersonal && revealed && revealedValue !== null && (
          <p className="text-xs font-mono text-muted-foreground mt-1 bg-muted/50 px-2 py-1 rounded break-all">
            {revealedValue}
          </p>
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
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={() => onDelete(entry.key)}
          title={t('settings.envVars.delete', 'Delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ─── Main Section ───────────────────────────────────────────────────────

export const EnvVarsSection = React.memo(function EnvVarsSection() {
  const { t } = useTranslation()
  const { envVars, isLoading: envLoading, loadEnvVars, setEnvVar, deleteEnvVar, hasChanges, setHasChanges } = useEnvVarsStore()
  const { secrets, isLoading: secretsLoading, loadSecrets, setSecret, deleteSecret, listenForChanges } = useSharedSecretsStore()
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const [addDialogOpen, setAddDialogOpen] = React.useState(false)
  const [editingEntry, setEditingEntry] = React.useState<UnifiedEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<UnifiedEntry | null>(null)
  const [isRestarting, setIsRestarting] = React.useState(false)
  const [restartError, setRestartError] = React.useState<string | null>(null)

  const isLoading = envLoading || secretsLoading

  React.useEffect(() => {
    loadEnvVars()
    loadSecrets()
    let unlisten: (() => void) | undefined
    listenForChanges().then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [loadEnvVars, loadSecrets, listenForChanges])

  // Build unified list: personal env vars + team secrets
  const unifiedEntries: UnifiedEntry[] = React.useMemo(() => {
    const personal: UnifiedEntry[] = envVars.map((e) => ({
      scope: 'personal' as const,
      key: e.key,
      description: e.description,
    }))
    const team: UnifiedEntry[] = secrets.map((s) => ({
      scope: 'team' as const,
      key: s.keyId,
      description: s.description,
      category: s.category,
      updatedBy: s.updatedBy,
      updatedAt: s.updatedAt,
    }))
    return [...team, ...personal]
  }, [envVars, secrets])

  const handleSave = async (key: string, value: string, description: string, shared: boolean) => {
    if (shared) {
      await setSecret(key, value, description, 'custom', currentNodeId ?? '')
    } else {
      await setEnvVar(key, value, description || undefined)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    if (deleteTarget.scope === 'team') {
      await deleteSecret(deleteTarget.key)
    } else {
      await deleteEnvVar(deleteTarget.key)
    }
    setDeleteTarget(null)
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
    } catch (err) {
      console.error('Failed to restart OpenCode:', err)
      setRestartError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRestarting(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={KeyRound}
        title={t('settings.envVars.title', 'Environment Variables')}
        description={t('settings.envVars.sectionDescription', 'Securely store API keys, passwords, and other secrets in your system keychain')}
        iconColor="text-emerald-500"
      />

      {/* Restart Warning */}
      {hasChanges && (
        <SettingCard className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                {t('settings.envVars.configChanged', 'Environment Variables Changed')}
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                {t('settings.envVars.restartToApply', 'Restart OpenCode to apply the new environment variables to MCP servers.')}
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

      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {unifiedEntries.length > 0
            ? t('settings.envVars.count', '{{count}} variable(s) stored', { count: unifiedEntries.length })
            : ''}
        </p>
        <Button size="sm" onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t('settings.envVars.add', 'Add Variable')}
        </Button>
      </div>

      {/* List or empty state */}
      {isLoading && unifiedEntries.length === 0 ? (
        <SettingCard>
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
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
            <p className="text-sm text-muted-foreground max-w-sm">
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
          <div className="text-sm text-muted-foreground">
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
