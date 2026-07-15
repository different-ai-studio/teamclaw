import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { renameIdea } from '@/lib/idea-mutations'

interface Props {
  ideaId: string | null
  initialTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRenamed?: () => void
}

export function RenameIdeaDialog({ ideaId, initialTitle, open, onOpenChange, onRenamed }: Props) {
  const { t } = useTranslation()
  const [title, setTitle] = React.useState(initialTitle)
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setTitle(initialTitle)
      setSubmitting(false)
    }
  }, [open, initialTitle])

  const trimmed = title.trim()
  const changed = trimmed !== initialTitle.trim()
  const canSubmit = !!trimmed && !!ideaId && !submitting && changed

  const submit = async () => {
    if (!canSubmit || !ideaId) return
    setSubmitting(true)
    try {
      await renameIdea(ideaId, trimmed)
      toast.success(t('ideas.renamed', 'Idea renamed'))
      onRenamed?.()
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.renameFailed', 'Rename failed: {{msg}}', { msg }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ideas.renameDialog.title', 'Rename idea')}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('ideas.renameDialog.placeholder', 'Idea title')}
          disabled={submitting}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('ideas.renameDialog.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
