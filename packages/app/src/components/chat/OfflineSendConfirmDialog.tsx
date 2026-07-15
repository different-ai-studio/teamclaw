import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: EngagedAgentUiEntry[]
  onConfirm: () => void
  dismissForSession: boolean
  onDismissForSessionChange: (checked: boolean) => void
}

export function OfflineSendConfirmDialog({
  open,
  onOpenChange,
  entries,
  onConfirm,
  dismissForSession,
  onDismissForSessionChange,
}: Props) {
  const { t } = useTranslation()
  const names = entries
    .filter((e) => e.uiState !== 'ready')
    .map((e) => e.agent.displayName)
    .join('、')

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('chat.sessionAgent.sendConfirmTitle', {
              name: names || t('chat.sessionAgent.sendConfirmTitleFallback'),
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('chat.sessionAgent.sendConfirmBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2 py-1">
          <Checkbox
            id="offline-send-dismiss"
            checked={dismissForSession}
            onCheckedChange={(v) => onDismissForSessionChange(v === true)}
          />
          <Label htmlFor="offline-send-dismiss" className="text-xs font-normal text-muted-foreground">
            {t('chat.sessionAgent.sendConfirmDismiss')}
          </Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('chat.sessionAgent.sendConfirmAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
