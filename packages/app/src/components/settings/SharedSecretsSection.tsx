import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Shield, Plus, Pencil, Trash2, ShieldCheck, Loader2 } from 'lucide-react'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingCard, SectionHeader } from './shared'
import { useSharedSecretsStore, type SecretMeta } from '@/stores/shared-secrets'
import { useTeamMembersStore } from '@/stores/team-members'

// ─── Category options ────────────────────────────────────────────────────

const CATEGORY_OPTIONS = [
  { value: 'ai', label: 'AI' },
  { value: 'platform', label: 'Platform' },
  { value: 'custom', label: 'Custom' },
]

// ─── Add / Edit Dialog ───────────────────────────────────────────────────

interface SecretDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingEntry?: SecretMeta | null
  nodeId: string
  onSave: (keyId: string, value: string, description: string, category: string, nodeId: string) => Promise<void>
}

function SecretDialog({ open, onOpenChange, editingEntry, nodeId, onSave }: SecretDialogProps) {
  const { t } = useTranslation()
  const [keyId, setKeyId] = React.useState('')
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [category, setCategory] = React.useState('custom')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const isEditing = !!editingEntry

  React.useEffect(() => {
    if (open) {
      if (editingEntry) {
        setKeyId(editingEntry.keyId)
        setDescription(editingEntry.description || '')
        setCategory(editingEntry.category || 'custom')
        setValue('')
      } else {
        setKeyId('')
        setValue('')
        setDescription('')
        setCategory('custom')
      }
      setError(null)
    }
  }, [open, editingEntry])

  const handleSave = async () => {
    const trimmedKeyId = keyId.trim()
    if (!trimmedKeyId) {
      setError(t('settings.sharedSecrets.error.keyRequired', 'Key ID is required'))
      return
    }
    if (!value) {
      setError(t('settings.sharedSecrets.error.valueRequired', 'Value is required'))
      return
    }
    if (!/^[a-z0-9_]+$/.test(trimmedKeyId)) {
      setError(t('settings.sharedSecrets.error.invalidKey', 'Key ID must contain only lowercase letters, digits, and underscores'))
      return
    }

    setSaving(true)
    setError(null)
    try {
      await onSave(trimmedKeyId, value, description.trim(), category, nodeId)
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
              ? t('settings.sharedSecrets.editTitle', 'Edit Shared Secret')
              : t('settings.sharedSecrets.addTitle', 'Add Shared Secret')}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t('settings.sharedSecrets.editDescription', 'Update the value for this shared secret. The new value will be synced to all team members.')
              : t('settings.sharedSecrets.addDescription', 'Add a new shared secret that will be encrypted and synced across your team.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('settings.sharedSecrets.keyId', 'Key ID')}
            </label>
            <Input
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="my_api_key"
              disabled={isEditing}
              autoFocus={!isEditing}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('settings.sharedSecrets.value', 'Value')}
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
              {t('settings.sharedSecrets.category', 'Category')}
            </label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('settings.sharedSecrets.description', 'Description')}
              <span className="text-muted-foreground font-normal ml-1">
                ({t('settings.sharedSecrets.optional', 'optional')})
              </span>
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.sharedSecrets.descriptionPlaceholder', 'e.g. OpenAI API key for the team')}
            />
          </div>

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

// ─── Delete Confirmation Dialog ──────────────────────────────────────────

interface DeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  secretKeyId: string
  onConfirm: () => Promise<void>
}

function DeleteDialog({ open, onOpenChange, secretKeyId, onConfirm }: DeleteDialogProps) {
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
          <DialogTitle>{t('settings.sharedSecrets.deleteTitle', 'Delete Shared Secret')}</DialogTitle>
          <DialogDescription>
            {t('settings.sharedSecrets.deleteDescription', 'Are you sure you want to delete "{{key}}"? This will remove the secret from disk and cannot be undone.', { key: secretKeyId })}
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

// ─── Secret Row ──────────────────────────────────────────────────────────

interface SecretRowProps {
  entry: SecretMeta
  onEdit: (entry: SecretMeta) => void
  onDelete: (keyId: string) => void
}

function SecretRow({ entry, onEdit, onDelete }: SecretRowProps) {
  const { t } = useTranslation()

  const shortUpdatedBy = entry.updatedBy ? entry.updatedBy.slice(0, 8) : '—'
  const formattedDate = entry.updatedAt
    ? new Date(entry.updatedAt).toLocaleDateString()
    : '—'

  return (
    <div className="flex items-center justify-between py-3 px-1 group">
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono font-medium bg-muted px-2 py-0.5 rounded">
            {entry.keyId}
          </code>
          {entry.category && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {entry.category}
            </span>
          )}
        </div>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {entry.description}
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-0.5">
          {t('settings.sharedSecrets.updatedBy', 'Updated by')} <code className="font-mono">{shortUpdatedBy}</code> {t('settings.sharedSecrets.on', 'on')} {formattedDate}
        </p>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onEdit(entry)}
          title={t('settings.sharedSecrets.edit', 'Edit')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={() => onDelete(entry.keyId)}
          title={t('settings.sharedSecrets.delete', 'Delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

// ─── Main Section ────────────────────────────────────────────────────────

interface SharedSecretsSectionProps {
  nodeId: string
}

export const SharedSecretsSection = React.memo(function SharedSecretsSection({ nodeId }: SharedSecretsSectionProps) {
  const { t } = useTranslation()
  const { secrets, isLoading, loadSecrets, setSecret, deleteSecret, listenForChanges } = useSharedSecretsStore()

  const [addDialogOpen, setAddDialogOpen] = React.useState(false)
  const [editingEntry, setEditingEntry] = React.useState<SecretMeta | null>(null)
  const [deleteKeyId, setDeleteKeyId] = React.useState<string | null>(null)

  React.useEffect(() => {
    loadSecrets()
    let unlisten: (() => void) | undefined
    listenForChanges().then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [loadSecrets, listenForChanges])

  const handleSave = async (keyId: string, value: string, description: string, category: string, nId: string) => {
    await setSecret(keyId, value, description, category, nId)
  }

  const handleDelete = async () => {
    if (deleteKeyId) {
      await deleteSecret(deleteKeyId)
      setDeleteKeyId(null)
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Shield}
        title={t('settings.sharedSecrets.title', 'Shared Secrets')}
        description={t('settings.sharedSecrets.sectionDescription', 'Encrypted secrets shared across your team — synced via P2P and stored on disk')}
        iconColor="text-blue-500"
      />

      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {secrets.length > 0
            ? t('settings.sharedSecrets.count', '{{count}} secret(s) stored', { count: secrets.length })
            : ''}
        </p>
        <Button size="sm" onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t('settings.sharedSecrets.add', 'Add Secret')}
        </Button>
      </div>

      {/* List or empty state */}
      {isLoading && secrets.length === 0 ? (
        <SettingCard>
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading...')}
          </div>
        </SettingCard>
      ) : secrets.length === 0 ? (
        <SettingCard className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-800">
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <ShieldCheck className="h-10 w-10 text-blue-500 mb-3" />
            <h4 className="font-medium mb-1">
              {t('settings.sharedSecrets.emptyTitle', 'No shared secrets yet')}
            </h4>
            <p className="text-sm text-muted-foreground max-w-sm">
              {t('settings.sharedSecrets.emptyDescription', 'Share encrypted secrets with your team. Values are encrypted using the team key and synced via P2P.')}
            </p>
            <Button size="sm" className="mt-4" onClick={() => setAddDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('settings.sharedSecrets.addFirst', 'Add Your First Secret')}
            </Button>
          </div>
        </SettingCard>
      ) : (
        <SettingCard>
          <div className="divide-y">
            {secrets.map((entry) => (
              <SecretRow
                key={entry.keyId}
                entry={entry}
                onEdit={(e) => setEditingEntry(e)}
                onDelete={(k) => setDeleteKeyId(k)}
              />
            ))}
          </div>
        </SettingCard>
      )}

      {/* Hint */}
      <SettingCard>
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-1">
              {t('settings.sharedSecrets.hintTitle', 'How it works')}
            </p>
            <p>
              {t('settings.sharedSecrets.hintBody', 'Secrets are encrypted using your team\'s shared key and stored as .enc.json files. They are synced to all team members via P2P and OSS. Values are write-only — they cannot be viewed after saving.')}
            </p>
          </div>
        </div>
      </SettingCard>

      {/* Dialogs */}
      <SecretDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        nodeId={nodeId}
        onSave={handleSave}
      />

      <SecretDialog
        open={!!editingEntry}
        onOpenChange={(open) => { if (!open) setEditingEntry(null) }}
        editingEntry={editingEntry}
        nodeId={nodeId}
        onSave={handleSave}
      />

      <DeleteDialog
        open={!!deleteKeyId}
        onOpenChange={(open) => { if (!open) setDeleteKeyId(null) }}
        secretKeyId={deleteKeyId || ''}
        onConfirm={handleDelete}
      />
    </div>
  )
})

// ─── Wrapper (no-prop version for registry) ──────────────────────────────

export const SharedSecretsSectionWrapper = React.memo(function SharedSecretsSectionWrapper() {
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  return <SharedSecretsSection nodeId={currentNodeId ?? ''} />
})
