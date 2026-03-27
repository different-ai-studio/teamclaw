import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Sentry from '@sentry/react'
import { toast } from 'sonner'
import { ImagePlus, X, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

interface Screenshot {
  file: File
  previewUrl: string
}

interface FeedbackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const { t } = useTranslation()
  const [message, setMessage] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [screenshots, setScreenshots] = React.useState<Screenshot[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const resetForm = React.useCallback(() => {
    setMessage('')
    setEmail('')
    setScreenshots(prev => {
      prev.forEach(s => URL.revokeObjectURL(s.previewUrl))
      return []
    })
  }, [])

  const addFiles = React.useCallback((files: FileList | File[]) => {
    const validFiles: Screenshot[] = []
    for (const file of Array.from(files)) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        toast.error(t('settings.feedback.invalidFileType', 'Only image files are accepted'))
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        toast.error(t('settings.feedback.fileTooLarge', 'Image must be under 5MB'))
        continue
      }
      validFiles.push({ file, previewUrl: URL.createObjectURL(file) })
    }
    if (validFiles.length > 0) {
      setScreenshots(prev => [...prev, ...validFiles])
    }
  }, [t])

  const removeScreenshot = React.useCallback((index: number) => {
    setScreenshots(prev => {
      const next = [...prev]
      URL.revokeObjectURL(next[index].previewUrl)
      next.splice(index, 1)
      return next
    })
  }, [])

  // Paste handler
  React.useEffect(() => {
    if (!open) return
    const handlePaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter(f =>
        ACCEPTED_TYPES.includes(f.type),
      )
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [open, addFiles])

  // Keep a ref to current screenshots for unmount cleanup
  const screenshotsRef = React.useRef(screenshots)
  screenshotsRef.current = screenshots

  React.useEffect(() => {
    return () => {
      screenshotsRef.current.forEach(s => URL.revokeObjectURL(s.previewUrl))
    }
  }, [])

  const handleSubmit = async () => {
    if (!message.trim()) return
    setSubmitting(true)

    try {
      // Read screenshot files as Uint8Array for Sentry attachments
      const attachments = await Promise.all(
        screenshots.map(async (s) => {
          const buffer = await s.file.arrayBuffer()
          return {
            filename: s.file.name,
            data: new Uint8Array(buffer),
            contentType: s.file.type,
          }
        }),
      )

      Sentry.captureFeedback(
        {
          message: message.trim(),
          email: email.trim() || undefined,
          source: 'settings-dialog',
        },
        { attachments },
      )

      toast.success(t('settings.feedback.success', 'Thank you for your feedback!'))
      resetForm()
      onOpenChange(false)
    } catch {
      toast.error(t('settings.feedback.error', 'Failed to send feedback. Please try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!v) resetForm()
      onOpenChange(v)
    }}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('settings.feedback.title', 'Send Feedback')}</DialogTitle>
          <DialogDescription>
            {t('settings.feedback.description', 'Help us improve by sharing your feedback')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Feedback message */}
          <Textarea
            placeholder={t('settings.feedback.messagePlaceholder', 'Describe your issue or suggestion...')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="min-h-[120px] resize-none"
          />

          {/* Screenshot attachments */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('settings.feedback.screenshotsLabel', 'Screenshots')}{' '}
              <span className="text-muted-foreground font-normal">({t('common.optional', 'Optional')})</span>
            </label>

            {/* Thumbnails */}
            {screenshots.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {screenshots.map((s, i) => (
                  <div key={s.previewUrl} className="relative group">
                    <img
                      src={s.previewUrl}
                      alt=""
                      className="h-16 w-16 rounded-md object-cover border"
                    />
                    <button
                      type="button"
                      onClick={() => removeScreenshot(i)}
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Drop zone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              className="flex items-center justify-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground cursor-pointer hover:border-primary/50 hover:text-foreground transition-colors"
            >
              <ImagePlus className="h-4 w-4" />
              {t('settings.feedback.screenshotsDrop', 'Paste, drag & drop, or click to add images')}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          {/* Contact email */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('settings.feedback.contactLabel', 'Contact Info')}{' '}
              <span className="text-muted-foreground font-normal">({t('common.optional', 'Optional')})</span>
            </label>
            <Input
              type="text"
              placeholder={t('settings.feedback.contactPlaceholder', 'Email or phone number')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={!message.trim() || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('settings.feedback.submitting', 'Submitting...')}
              </>
            ) : (
              t('settings.feedback.submit', 'Submit Feedback')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
