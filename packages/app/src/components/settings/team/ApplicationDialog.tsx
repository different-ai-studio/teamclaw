import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ApplicationDialogProps {
  teamName: string
  onSubmit: (name: string, email: string, note: string) => Promise<void>
  onCancel: () => void
}

export function ApplicationDialog({ teamName, onSubmit, onCancel }: ApplicationDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      await onSubmit(name, email, note)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
        <h3 className="text-base font-semibold">{t('settings.team.applyTitle')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.team.applyDesc', { teamName })}
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {t('settings.team.applyNameLabel')} <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.team.applyNamePlaceholder')}
              className="bg-background/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {t('settings.team.applyEmailLabel')} <span className="text-destructive">*</span>
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('settings.team.applyEmailPlaceholder')}
              className="bg-background/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('settings.team.applyNoteLabel')}</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('settings.team.applyNotePlaceholder')}
              rows={2}
              className="w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || !name || !email}
          >
            {submitting ? t('settings.team.submitting') : t('settings.team.submitApplication')}
          </Button>
        </div>
      </div>
    </div>
  )
}
