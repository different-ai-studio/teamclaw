import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getFreshAccessToken } from '@/lib/auth/session-store'
import { Label } from '@/components/ui/label'

export interface CreateTeamDialogResult {
  team_id: string
  team_slug: string
}

interface Props {
  workspacePath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (result: CreateTeamDialogResult) => void
}

/**
 * Name-only "Create Team" dialog. Invokes the slim Rust
 * `team_share_create` command which only creates the row in
 * `teams`. Share-mode (S3/Git/P2P) and LiteLLM stay disabled
 * and must be opted into separately via:
 *   - 设置 → 团队共享 → 「开启共享」
 *   - LLM 配置 → 团队 LiteLLM
 */
export function CreateTeamDialog({
  workspacePath,
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !busy

  async function handleSubmit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const accessToken = await getFreshAccessToken()
      const r = await invoke<CreateTeamDialogResult>('team_share_create', {
        name: trimmed,
        workspacePath,
        accessToken,
      })
      onCreated?.(r)
      setName('')
      onOpenChange(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('team.createDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('team.createDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="create-team-name">{t('team.createDialog.nameLabel')}</Label>
          <Input
            id="create-team-name"
            value={name}
            placeholder={t('team.createDialog.namePlaceholder')}
            autoFocus
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSubmit()
              }
            }}
          />
          {error && (
            <p className="text-[12px] text-red-500" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
