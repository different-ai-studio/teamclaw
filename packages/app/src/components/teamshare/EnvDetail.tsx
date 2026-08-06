import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Box, Pencil, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useEnvVarsStore } from '@/stores/env-vars'
import { useTeamMembersStore } from '@/stores/team-members'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <span className="w-28 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-foreground">{children}</span>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:border-coral'

/** Same rule as the desktop `validate_key_id` and the server's column check. */
const KEY_ID_RE = /^[a-z0-9_]{1,64}$/

/**
 * Add a new team env key. Lives here rather than in the list column so the
 * create and edit forms stay adjacent — they share the "value is write-only,
 * encrypted before it leaves the machine" contract, and that is easy to break
 * from a distance.
 */
export function EnvCreateForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const setCatalogEntry = useEnvVarsStore((s) => s.setCatalogEntry)
  // Team-scope writes are node-attributed; the Rust command rejects the call
  // outright without it (env_vars.rs: "nodeId is required for team env vars").
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  const [keyId, setKeyId] = React.useState('')
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const keyValid = KEY_ID_RE.test(keyId)
  const canSubmit = keyValid && value.trim().length > 0 && !busy

  const submit = React.useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      await setCatalogEntry('team', keyId, value, {
        description: description.trim() || undefined,
        category: category.trim() || 'custom',
        nodeId: currentNodeId ?? '',
      })
      toast.success(t('teamShare.envDetail.added', 'Added'))
      onDone()
    } catch (e) {
      toast.error(
        t('teamShare.envDetail.saveFailed', 'Save failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [canSubmit, setCatalogEntry, keyId, value, description, category, currentNodeId, t, onDone])

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.key', 'Key')}
        </label>
        <input
          className={cn(inputCls, 'font-mono text-[12.5px]')}
          value={keyId}
          autoFocus
          onChange={(e) => setKeyId(e.target.value)}
          placeholder="team_api_token"
        />
        {keyId && !keyValid && (
          <p className="mt-1.5 text-[12px] text-amber-600">
            {t(
              'teamShare.envDetail.keyRule',
              'Lowercase letters, digits and underscores only, up to 64 characters.',
            )}
          </p>
        )}
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.value', 'Value')}
        </label>
        <input
          className={cn(inputCls, 'font-mono text-[12.5px]')}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          {t(
            'teamShare.envDetail.encryptOnSave',
            'Encrypted with the team key before it leaves this machine. The server only ever stores ciphertext.',
          )}
        </p>
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.description', 'Description')}
        </label>
        <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
          {t('teamShare.envDetail.category', 'Category')}
        </label>
        <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('teamShare.envAddSubmit', 'Add to team')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="h-8 text-[13px]">
          {t('common.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

export function EnvDetail({ keyId }: { keyId: string }) {
  const { t } = useTranslation()
  const item = useEnvVarsStore((s) => s.teamSecrets.find((x) => x.keyId === keyId))
  const setCatalogEntry = useEnvVarsStore((s) => s.setCatalogEntry)
  const deleteCatalogEntry = useEnvVarsStore((s) => s.deleteCatalogEntry)
  const currentNodeId = useTeamMembersStore((s) => s.currentNodeId)
  const select = useTeamShareBrowserStore((s) => s.select)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)

  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const beginEdit = React.useCallback(() => {
    // The value is deliberately not prefilled: it is encrypted with the team key
    // and never fetched back for display. Editing is "replace", not "amend".
    setValue('')
    setDescription(item?.description ?? '')
    setCategory(item?.category ?? '')
    setEditing(true)
  }, [item])

  const save = React.useCallback(async () => {
    if (busy || !value.trim()) return
    setBusy(true)
    try {
      await setCatalogEntry('team', keyId, value, {
        description: description.trim() || undefined,
        category: category.trim() || 'custom',
        nodeId: currentNodeId ?? '',
      })
      setEditing(false)
      setValue('')
      toast.success(t('teamShare.envDetail.saved', 'Saved'))
    } catch (e) {
      toast.error(
        t('teamShare.envDetail.saveFailed', 'Save failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [busy, value, setCatalogEntry, keyId, description, category, currentNodeId, t])

  const remove = React.useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await deleteCatalogEntry('team', keyId, { nodeId: currentNodeId ?? '' })
      select('env', null)
      await loadCounts()
      toast.success(t('teamShare.envDetail.deleted', 'Deleted'))
    } catch (e) {
      toast.error(
        t('teamShare.envDetail.deleteFailed', 'Delete failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [busy, deleteCatalogEntry, keyId, currentNodeId, select, loadCounts, t])

  if (!item) return null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Box className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.env', 'Team Env')}
          </div>
          <div className="truncate font-mono text-[15px] font-bold text-foreground">{item.keyId}</div>
        </div>
        {!editing && (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              onClick={beginEdit}
              className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('teamShare.edit', 'Edit')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void remove()}
              className="h-8 gap-1.5 text-[13px] text-red-600 hover:text-red-700"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-6 px-6 py-5">
        {editing ? (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.newValue', 'New value')}
              </label>
              <input
                className={cn(inputCls, 'font-mono text-[12.5px]')}
                type="password"
                value={value}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                placeholder={t('teamShare.envDetail.valuePlaceholder', 'Enter the replacement value')}
              />
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                {t(
                  'teamShare.envDetail.encryptOnSave',
                  'Encrypted with the team key before it leaves this machine. The server only ever stores ciphertext.',
                )}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.description', 'Description')}
              </label>
              <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.category', 'Category')}
              </label>
              <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                onClick={() => void save()}
                disabled={busy || !value.trim()}
                className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('teamShare.envDetail.save', 'Save')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(false)}
                className="h-8 text-[13px]"
              >
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {item.description && <p className="text-[14px] leading-relaxed text-foreground">{item.description}</p>}

            <section>
              <div className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.value', 'Value')}
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
                <span className="font-mono text-[14px] tracking-widest text-muted-foreground">••••••••</span>
              </div>
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                {t(
                  'teamShare.envDetail.encryptedHint',
                  'Team values are encrypted and not shown here. Use Edit to replace.',
                )}
              </p>
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wide text-faint">
                {t('teamShare.envDetail.details', 'Details')}
              </h3>
              <InfoRow label={t('teamShare.envDetail.key', 'Key')}>
                <span className="font-mono text-[12.5px]">{item.keyId}</span>
              </InfoRow>
              <InfoRow label={t('teamShare.envDetail.category', 'Category')}>
                {item.category || t('teamShare.envDetail.secret', 'Secret')}
              </InfoRow>
              <InfoRow label={t('teamShare.scope.label', 'Scope')}>{t('teamShare.scope.team', 'Team')}</InfoRow>
              <InfoRow label={t('teamShare.envDetail.createdBy', 'Created by')}>{item.createdBy || '—'}</InfoRow>
              <InfoRow label={t('teamShare.envDetail.updatedBy', 'Updated by')}>{item.updatedBy || '—'}</InfoRow>
              <InfoRow label={t('teamShare.envDetail.updatedAt', 'Updated at')}>{item.updatedAt || '—'}</InfoRow>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
