import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, User as UserIcon, Sparkles } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { supabase } from '@/lib/supabase-client'
import { cn } from '@/lib/utils'

type Candidate = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
}

export interface PickedActor {
  id: string
  displayName: string
}

export interface NewSessionActorPickerProps {
  open: boolean
  onCancel: () => void  // user closes / cancels — abort send
  onConfirm: (picks: { members: PickedActor[]; agents: PickedActor[] }) => void
  teamId: string
  /** Current user's actor_id — excluded from the member list. */
  selfActorId: string | null
}

export function NewSessionActorPicker({ open, onCancel, onConfirm, teamId, selfActorId }: NewSessionActorPickerProps) {
  const { t } = useTranslation()
  const [candidates, setCandidates] = React.useState<Candidate[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [picked, setPicked] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    if (!open || !teamId) { setCandidates([]); setPicked(new Set()); return }
    let cancelled = false
    setLoading(true); setError(false); setPicked(new Set())
    void (async () => {
      const { data, error: err } = await supabase
        .from('actors')
        .select('id, actor_type, display_name')
        .eq('team_id', teamId)
        .in('actor_type', ['member', 'agent'])
      if (cancelled) return
      if (err) {
        console.error('[NewSessionActorPicker] fetch failed', err)
        setError(true)
        setLoading(false)
        return
      }
      const filtered = (data ?? []).filter((c: Candidate) => c.id !== selfActorId)
      setCandidates(filtered as Candidate[])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [open, teamId, selfActorId])

  const members = candidates.filter(c => c.actor_type === 'member')
  const agents = candidates.filter(c => c.actor_type === 'agent')

  function toggle(id: string) {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function send(includePicks: boolean) {
    const ids = includePicks ? Array.from(picked) : []
    const memberPicks: PickedActor[] = members
      .filter(m => ids.includes(m.id))
      .map(m => ({ id: m.id, displayName: m.display_name }))
    const agentPicks: PickedActor[] = agents
      .filter(a => ids.includes(a.id))
      .map(a => ({ id: a.id, displayName: a.display_name }))
    onConfirm({ members: memberPicks, agents: agentPicks })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat.newSessionPicker.title', 'Pick collaborators')}</DialogTitle>
          <DialogDescription>
            {t('chat.newSessionPicker.desc', 'Select members and agents to add to this session, or skip to start alone.')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[200px] max-h-[400px] overflow-y-auto -mx-6 px-6">
          {loading && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('chat.newSessionPicker.loading', 'Loading...')}
            </div>
          )}
          {error && (
            <div className="py-4 text-sm text-destructive">
              {t('chat.newSessionPicker.error', 'Failed to load actors')}
            </div>
          )}
          {!loading && !error && candidates.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t('chat.newSessionPicker.empty', 'No team members or agents available')}
            </div>
          )}
          {!loading && !error && members.length > 0 && (
            <>
              <div className="px-1 pb-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                {t('chat.mentionGroupMembers', 'Members')}
              </div>
              {members.map(m => (
                <CandidateRow key={m.id} candidate={m} checked={picked.has(m.id)} onToggle={() => toggle(m.id)} />
              ))}
            </>
          )}
          {!loading && !error && agents.length > 0 && (
            <>
              <div className="px-1 pb-2 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                {t('chat.mentionGroupAgents', 'Agents')}
              </div>
              {agents.map(a => (
                <CandidateRow key={a.id} candidate={a} checked={picked.has(a.id)} onToggle={() => toggle(a.id)} />
              ))}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => send(false)}>
            {t('chat.newSessionPicker.skip', 'Skip')}
          </Button>
          <Button onClick={() => send(true)} disabled={loading}>
            {t('chat.newSessionPicker.send', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CandidateRow({ candidate, checked, onToggle }: { candidate: Candidate; checked: boolean; onToggle: () => void }) {
  const isAgent = candidate.actor_type === 'agent'
  const initials = candidate.display_name?.slice(0, 2).toUpperCase() || ''
  return (
    <label className="flex items-center gap-3 py-2 cursor-pointer hover:bg-muted/40 rounded-md px-2 -mx-2">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <div className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center bg-muted text-xs font-medium text-muted-foreground',
        isAgent ? 'rounded-md' : 'rounded-full',
      )}>
        {initials || (isAgent ? <Sparkles className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />)}
      </div>
      <span className="text-sm font-medium truncate">{candidate.display_name}</span>
    </label>
  )
}
