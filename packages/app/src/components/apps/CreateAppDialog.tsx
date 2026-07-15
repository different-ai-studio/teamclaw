import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ChevronRight, Loader2, Save } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAppsStore } from '@/stores/apps-store'

/** The single app type currently supported by the platform. */
const APP_TYPE = 'fullstack_tanstack_postgres'

type Visibility = 'personal' | 'team'

interface CreateAppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
}

export function CreateAppDialog({ open, onOpenChange, teamId }: CreateAppDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [visibility, setVisibility] = React.useState<Visibility>('personal')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setName('')
      setVisibility('personal')
      setSubmitting(false)
      setError(null)
    }
  }, [open])

  const trimmed = name.trim()
  const canSubmit = !!trimmed && !!teamId && !submitting

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await useAppsStore.getState().create({
        teamId,
        name: trimmed,
        type: APP_TYPE,
        visibility,
      })
      onOpenChange(false)
      setName('')
      setVisibility('personal')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('apps.createError', 'Failed to create app'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[min(520px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden border-border bg-background p-0 shadow-xl">
        <DialogHeader className="border-b border-border-soft bg-paper px-5 py-4">
          <div className="flex items-center gap-3 pr-8">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-coral-soft bg-coral/5 px-2.5 text-[12.5px] font-semibold text-coral">
              <AppWindow className="h-3.5 w-3.5" />
              App
            </span>
            <ChevronRight className="h-4 w-4 text-faint" />
            <DialogTitle className="text-[15px] font-bold text-foreground">
              {t('apps.createTitle', 'Create App')}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t('apps.createTitle', 'Create App')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 py-6">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-app-name" className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.nameLabel', 'Name')}
            </label>
            <Input
              id="create-app-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apps.namePlaceholder', 'My app')}
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.typeLabel', 'Type')}
            </span>
            <div className="rounded-[9px] border border-border-soft bg-paper px-3 py-2.5 text-[13px] text-ink-2">
              {t('apps.typeFullstack', 'Full-stack (TanStack + Postgres)')}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.visibilityLabel', 'Visibility')}
            </span>
            <div className="flex gap-2">
              {(['personal', 'team'] as const).map((v) => (
                <label
                  key={v}
                  className={cn(
                    'flex flex-1 cursor-pointer items-center gap-2 rounded-[9px] border px-3 py-2.5 text-[13px] transition-colors',
                    visibility === v
                      ? 'border-coral bg-coral/5 text-foreground'
                      : 'border-border-soft bg-paper text-ink-2 hover:bg-selected/30',
                  )}
                >
                  <input
                    type="radio"
                    name="create-app-visibility"
                    value={v}
                    checked={visibility === v}
                    onChange={() => setVisibility(v)}
                    disabled={submitting}
                    className="h-3.5 w-3.5 accent-coral"
                  />
                  {v === 'personal'
                    ? t('apps.visibilityPersonal', 'Personal')
                    : t('apps.visibilityTeam', 'Team')}
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-[9px] border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-700">
              {t('apps.createError', 'Failed to create app')}: {error}
            </div>
          )}
        </div>

        <div className="border-t border-border-soft bg-paper px-5 py-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="h-9 rounded-[9px]"
          >
            {t('apps.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="float-right h-9 rounded-[9px] bg-coral px-5 text-white hover:bg-coral/90"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('apps.submit', 'Create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
