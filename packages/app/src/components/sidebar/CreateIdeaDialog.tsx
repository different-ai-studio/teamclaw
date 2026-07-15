import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronRight, Circle, Loader2, Save } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { getBackend } from '@/lib/backend'

interface CreateIdeaDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string | null
  /** Called after a successful create so callers can refetch the ideas list. */
  onCreated?: () => void
}

export function CreateIdeaDialog({ open, onOpenChange, teamId, onCreated }: CreateIdeaDialogProps) {
  const { t } = useTranslation()
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setTitle('')
      setDescription('')
      setSubmitting(false)
    }
  }, [open])

  const trimmed = title.trim()
  const canSubmit = !!trimmed && !!teamId && !submitting

  const submit = async () => {
    if (!canSubmit) return
    const activeTeamId = teamId
    if (!activeTeamId) return
    setSubmitting(true)
    try {
      await getBackend().ideas.createIdea({
        teamId: activeTeamId,
        title: trimmed,
        workspaceId: null,
        body: description.trim() || null,
      })
      toast.success(t('ideas.created', 'Idea created'))
      onCreated?.()
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.createFailed', 'Failed to create idea: {{msg}}', { msg }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] w-[min(860px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden border-border bg-background p-0 shadow-xl">
        <DialogHeader className="border-b border-border-soft bg-paper px-5 py-4">
          <div className="flex items-center gap-3 pr-8">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-coral-soft bg-coral/5 px-2.5 text-[12.5px] font-semibold text-coral">
              <Circle className="h-2.5 w-2.5 fill-current" />
              Idea
            </span>
            <ChevronRight className="h-4 w-4 text-faint" />
            <DialogTitle className="text-[15px] font-bold text-foreground">
              {t('ideas.newIdea', 'New idea')}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t('ideas.newIdeaDescription', 'Capture an idea, problem, or proposal for the team.')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <section>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('ideas.titlePlaceholder', 'Idea title')}
              disabled={submitting}
              className="h-auto border-0 bg-transparent px-0 py-0 text-[24px] font-bold leading-tight shadow-none outline-none placeholder:text-faint focus-visible:ring-0"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('ideas.descriptionPlaceholder', "What's the constraint, what's the win?")}
              disabled={submitting}
              rows={8}
              className="mt-5 min-h-[220px] resize-none border-0 bg-transparent px-0 py-0 text-[15px] leading-7 text-ink-2 shadow-none outline-none placeholder:text-faint focus-visible:ring-0"
            />
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-ink-2">
                <span className="h-2 w-2 rounded-full bg-faint" />
                {t('ideas.contextMenu.statusOpen', 'Open')}
              </span>
              <span className="rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-muted-foreground">
                {t('ideas.newIdeaDescription', 'Capture an idea, problem, or proposal for the team.')}
              </span>
            </div>
          </section>
        </div>

        <div className="border-t border-border-soft bg-paper px-5 py-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="h-9 rounded-[9px]"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="float-right h-9 rounded-[9px] bg-coral px-5 text-white hover:bg-coral/90"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('ideas.createButton', 'Create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
