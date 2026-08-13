import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTeamShareStore } from '@/stores/team-share'
import { humanizeFcError } from '@/lib/fc-error'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  workspacePath: string
  onSuccess?: () => void
}

/**
 * Confirmation dialog for locking a team into OSS share mode.
 *
 * It used to be a three-way picker (OSS / managed git / self-hosted git). Git
 * share is gone, so the only remaining decision is whether to enable at all —
 * and that decision is irreversible, which is what this dialog is now for.
 */
export function EnableShareWizard({
  open,
  onOpenChange,
  teamId,
  workspacePath,
  onSuccess,
}: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enableOss = useTeamShareStore((s) => s.enableOss)

  async function handleSubmit() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      // Team encryption key is configured under Daemon → General, not here.
      // Pass undefined so enable mints/auto-generates when needed.
      const res = await enableOss(teamId, workspacePath)
      // Share is on server-side, so the wizard is done and closes — but the
      // daemon may not have taken the secret, which leaves shared env vars
      // dead. Hold the toast open: this needs a retry, not a glance.
      if (res.cloneWarning) {
        toast.warning(t('settings.teamShare.daemonDeliveryFailed'), {
          description: res.cloneWarning,
          duration: Infinity,
          closeButton: true,
        })
      }
      onSuccess?.()
      setError(null)
      onOpenChange(false)
    } catch (e) {
      setError(humanizeFcError(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!submitting) onOpenChange(v)
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('settings.teamShare.enableTitle')}</DialogTitle>
          <DialogDescription>
            {t('settings.teamShare.enableDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
          <p className="text-[13px] text-muted-foreground">
            {t('settings.teamShare.modeOssDesc')}
          </p>

          <p className="text-[12px] text-amber-600">
            {t('settings.teamShare.lockWarning')}
          </p>

          {error && <p className="text-[12px] text-red-500">{error}</p>}
        </div>

        <DialogFooter className="shrink-0 border-t border-border-soft pt-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('settings.teamShare.confirmEnable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
