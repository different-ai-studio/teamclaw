import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'

/**
 * Shown after sign-in when the server found invites addressed to the user's
 * verified email or phone. Accepting is an explicit choice: an inviter knowing
 * someone's address is not consent to join their team, so an invite waits here
 * rather than adding the user to the team on their behalf.
 *
 * The token path (an invite link the user opened) does not come through here —
 * opening the link IS the choice, and AuthGate claims it directly.
 */
export function PendingInvitesDialog() {
  const { t } = useTranslation()
  const invites = useAuthStore((s) => s.pendingInvites)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  // Closing must not re-prompt on every render while the list is still
  // populated; the invites stay pending server-side and reappear next sign-in.
  const [dismissed, setDismissed] = React.useState(false)

  const open = invites.length > 0 && !dismissed

  const accept = async (inviteId: string) => {
    setBusyId(inviteId)
    const result = await useAuthStore.getState().acceptPendingInvite(inviteId)
    setBusyId(null)
    if (!result) {
      const msg = useAuthStore.getState().errorMessage
      toast.error(t('pendingInvite.acceptFailed', 'Failed to join team: {{msg}}', { msg: msg ?? '' }))
      return
    }
    toast.success(t('pendingInvite.accepted', 'Joined the team'))
  }

  const decline = async (inviteId: string) => {
    setBusyId(inviteId)
    const ok = await useAuthStore.getState().declinePendingInvite(inviteId)
    setBusyId(null)
    if (!ok) {
      const msg = useAuthStore.getState().errorMessage
      toast.error(t('pendingInvite.declineFailed', 'Failed to decline: {{msg}}', { msg: msg ?? '' }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setDismissed(true)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pendingInvite.title', '你有团队邀请')}</DialogTitle>
          <DialogDescription>
            {t('pendingInvite.description', '以下团队邀请你加入。你可以选择接受或拒绝。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {invites.map((invite) => (
            <div key={invite.inviteId} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="text-sm font-medium text-foreground">
                {invite.teamName ?? t('pendingInvite.unnamedTeam', 'Untitled team')}
              </div>
              <div className="text-xs text-muted-foreground">
                {invite.invitedByDisplayName
                  ? t('pendingInvite.invitedBy', '{{name}} 邀请你以 {{role}} 身份加入', {
                      name: invite.invitedByDisplayName,
                      role: invite.teamRole ?? 'member',
                    })
                  : t('pendingInvite.invitedAs', '邀请你以 {{role}} 身份加入', {
                      role: invite.teamRole ?? 'member',
                    })}
              </div>
              {invite.expiresAt && (
                <div className="text-[11px] text-muted-foreground">
                  {t('pendingInvite.expiresAt', 'Expires {{date}}', {
                    date: new Date(invite.expiresAt).toLocaleString(),
                  })}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void decline(invite.inviteId)}
                  disabled={busyId != null}
                >
                  {t('pendingInvite.decline', '拒绝')}
                </Button>
                <Button size="sm" onClick={() => void accept(invite.inviteId)} disabled={busyId != null}>
                  {busyId === invite.inviteId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('pendingInvite.accept', '接受邀请')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
