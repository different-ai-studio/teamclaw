import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { supabase } from '@/lib/supabase-client'
import { cn } from '@/lib/utils'

type InviteKind = 'member' | 'agent'
type TeamRole = 'member' | 'admin'

interface InviteCreated {
  token: string
  expiresAt: string
  deeplink: string
}

interface InviteActorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string | null
}

export function InviteActorDialog({ open, onOpenChange, teamId }: InviteActorDialogProps) {
  const { t } = useTranslation()
  const [kind, setKind] = React.useState<InviteKind>('member')
  const [name, setName] = React.useState('')
  const [teamRole, setTeamRole] = React.useState<TeamRole>('member')
  const [agentKind] = React.useState<string>('daemon')
  const [submitting, setSubmitting] = React.useState(false)
  const [invite, setInvite] = React.useState<InviteCreated | null>(null)

  const reset = React.useCallback(() => {
    setKind('member')
    setName('')
    setTeamRole('member')
    setSubmitting(false)
    setInvite(null)
  }, [])

  React.useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  const trimmed = name.trim()
  const canSubmit = !!trimmed && !!teamId && !submitting && invite == null

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      // Param names must match the SQL function signature exactly
      // (`create_team_invite(p_team_id, p_kind, p_display_name, p_team_role,
      // p_agent_kind, p_ttl_seconds, p_target_actor_id)`); PostgREST overloads
      // by argument name so the `p_` prefix is required.
      const { data, error } = await supabase.rpc('create_team_invite', {
        p_team_id: teamId,
        p_kind: kind,
        p_display_name: trimmed,
        p_team_role: kind === 'member' ? teamRole : null,
        p_agent_kind: kind === 'agent' ? agentKind : null,
        p_ttl_seconds: null,
        p_target_actor_id: null,
      })
      if (error) {
        toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg: error.message }))
        return
      }
      const row = Array.isArray(data) ? data[0] : data
      if (!row) {
        toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg: 'empty response' }))
        return
      }
      setInvite({
        token: row.token,
        expiresAt: row.expires_at,
        deeplink: row.deeplink,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg }))
    } finally {
      setSubmitting(false)
    }
  }

  const copyLink = async () => {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.deeplink)
      toast.success(t('invite.copied', 'Invite link copied'))
    } catch {
      toast.error(t('invite.copyFailed', 'Failed to copy invite link'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('invite.title', 'Invite to team')}</DialogTitle>
          <DialogDescription>
            {invite
              ? t('invite.shareDescription', 'Share this link so they can join the team.')
              : t('invite.description', 'Create an invite link for a new teammate or agent.')}
          </DialogDescription>
        </DialogHeader>

        {!invite ? (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('invite.kindLabel', 'Kind')}
              </label>
              <div className="inline-flex gap-1 rounded-md bg-muted p-1">
                {(['member', 'agent'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn(
                      'rounded px-3 py-1 text-xs font-medium transition-colors',
                      kind === k ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                    disabled={submitting}
                  >
                    {k === 'member' ? t('invite.kindMember', 'Teammate') : t('invite.kindAgent', 'Agent')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('invite.nameLabel', 'Name')}
              </label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('invite.namePlaceholder', 'Display name')}
                disabled={submitting}
              />
            </div>
            {kind === 'member' && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('invite.roleLabel', 'Role')}
                </label>
                <div className="inline-flex gap-1 rounded-md bg-muted p-1">
                  {(['member', 'admin'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setTeamRole(r)}
                      className={cn(
                        'rounded px-3 py-1 text-xs font-medium transition-colors',
                        teamRole === r ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                      disabled={submitting}
                    >
                      {r === 'member' ? t('invite.roleMember', 'Member') : t('invite.roleAdmin', 'Admin')}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('invite.linkLabel', 'Invite link')}
              </label>
              <div className="flex items-center gap-2">
                <Input value={invite.deeplink} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={() => void copyLink()} title={t('invite.copy', 'Copy')}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('invite.expiresAt', 'Expires {{date}}', {
                date: new Date(invite.expiresAt).toLocaleString(),
              })}
            </p>
          </div>
        )}

        <DialogFooter>
          {!invite ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button onClick={() => void submit()} disabled={!canSubmit}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('invite.createButton', 'Create invite')}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>{t('common.done', 'Done')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
