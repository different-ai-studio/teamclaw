import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, Users, User as UserIcon, Sparkles, X } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
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
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase-client'
import { cn } from '@/lib/utils'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'

// ── Types ──────────────────────────────────────────────────────────────────

type Row = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
  member_status: string | null
  agent_status: string | null
  agent_kind: string | null
  last_active_at: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isOnline(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false
  const t = Date.parse(lastActiveAt)
  if (Number.isNaN(t)) return false
  return Date.now() - t < 5 * 60 * 1000
}

function computeDotStateAndAnimation(
  actor: Row,
  runtimeInfo: RuntimeInfo | undefined,
): { color: string; breathing: boolean } {
  if (actor.actor_type === 'member') {
    return {
      color: isOnline(actor.last_active_at) ? 'bg-emerald-500' : 'bg-muted-foreground/40',
      breathing: false,
    }
  }
  // Agent
  if (!runtimeInfo) {
    return { color: 'bg-muted-foreground/40', breathing: false }
  }
  switch (runtimeInfo.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', breathing: false }
    case RuntimeLifecycle.STARTING:
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
      return { color: 'bg-muted-foreground/40', breathing: false }
    case RuntimeLifecycle.ACTIVE:
      switch (runtimeInfo.status) {
        case AgentStatus.ACTIVE:
          return { color: 'bg-emerald-500', breathing: true }
        case AgentStatus.IDLE:
          return { color: 'bg-emerald-500', breathing: false }
        case AgentStatus.ERROR:
          return { color: 'bg-red-500', breathing: false }
        default:
          return { color: 'bg-muted-foreground/40', breathing: false }
      }
    default:
      return { color: 'bg-muted-foreground/40', breathing: false }
  }
}

// ── ActorRowView ───────────────────────────────────────────────────────────

function ActorRowView({
  actor,
  runtimeInfo,
  canRemove,
  onRemove,
}: {
  actor: Row
  runtimeInfo?: RuntimeInfo
  canRemove: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const initials = actor.display_name?.slice(0, 2).toUpperCase() || ''
  const { color: dotColor, breathing } = computeDotStateAndAnimation(actor, runtimeInfo)
  const modelName = isAgent ? (runtimeInfo?.currentModel || null) : null
  const subline = isAgent ? (modelName || actor.agent_kind || '') : (actor.member_status || '')

  return (
    <div className="group relative flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
      <div
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center bg-muted text-xs font-medium text-muted-foreground',
          isAgent ? 'rounded-md' : 'rounded-full',
        )}
      >
        {initials || (isAgent ? <Sparkles className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />)}
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background',
            dotColor,
            breathing && 'animate-pulse',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{actor.display_name}</div>
        {subline && (
          <div className="truncate text-[11px] text-muted-foreground">{subline}</div>
        )}
      </div>
      {canRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={t('chat.actorSheet.removeAria', 'Remove')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

// ── SessionActorSheet ──────────────────────────────────────────────────────

export interface SessionActorSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string | null
  teamId: string | null
}

export function SessionActorSheet({ open, onOpenChange, sessionId, teamId }: SessionActorSheetProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [rows, setRows] = React.useState<Row[]>([])
  const [agentToRuntimeId, setAgentToRuntimeId] = React.useState<Map<string, string>>(new Map())
  const [myActorId, setMyActorId] = React.useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = React.useState<Row | null>(null)
  const [candidateAgents, setCandidateAgents] = React.useState<Array<{ id: string; display_name: string }>>([])
  const [addingAgent, setAddingAgent] = React.useState(false)

  const runtimeStates = useRuntimeStateStore(s => s.byRuntimeId)

  React.useEffect(() => {
    // Clear stale data whenever the sheet closes or the session changes —
    // otherwise switching to a new session leaves the previous session's
    // rows visible until the new fetch lands (or forever, if the new
    // session is null/empty).
    setRows([])
    setAgentToRuntimeId(new Map())
    setMyActorId(null)
    setError(false)
    setCandidateAgents([])
    setAddingAgent(false)
    if (!open || !sessionId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      // Step 1: get actor_id list for the session
      const { data: participantData, error: participantError } = await supabase
        .from('session_participants')
        .select('actor_id')
        .eq('session_id', sessionId)

      if (cancelled) return
      if (participantError) {
        console.error('[SessionActorSheet] fetch failed', participantError)
        setError(true)
        setLoading(false)
        return
      }

      const actorIds = (participantData ?? []).map((r: { actor_id: string }) => r.actor_id)

      if (actorIds.length === 0) {
        setRows([])
        setAgentToRuntimeId(new Map())
        setMyActorId(null)
        setLoading(false)
        return
      }

      // Step 2: fetch actor_directory rows
      const { data: actorData, error: actorError } = await supabase
        .from('actor_directory')
        .select('id, actor_type, display_name, member_status, agent_status, agent_kind, last_active_at')
        .in('id', actorIds)

      if (cancelled) return
      if (actorError) {
        console.error('[SessionActorSheet] fetch failed', actorError)
        setError(true)
        setLoading(false)
        return
      }

      // Step 3: fetch agent_runtimes for live RuntimeInfo mapping
      const { data: runtimeRows, error: runtimeErr } = await supabase
        .from('agent_runtimes')
        .select('agent_id, runtime_id, status, current_model')
        .eq('session_id', sessionId)

      if (cancelled) return
      if (runtimeErr) {
        console.error('[SessionActorSheet] agent_runtimes fetch failed (non-fatal)', runtimeErr)
        // Non-fatal: agents will fall back to static agent_status
      }

      const runtimeMap = new Map<string, string>()
      for (const r of (runtimeRows ?? [])) {
        if (r.agent_id && r.runtime_id) runtimeMap.set(r.agent_id, r.runtime_id)
      }

      // Step 4: resolve current user's actor_id (find which participant is me)
      const { data: { user } } = await supabase.auth.getUser()
      let myActorIdLocal: string | null = null
      if (user && actorIds.length > 0) {
        const { data: myActorRows } = await supabase
          .from('actors')
          .select('id')
          .eq('user_id', user.id)
          .in('id', actorIds)
        myActorIdLocal = myActorRows?.[0]?.id ?? null
      }

      // Step 5: fetch team agents not yet in this session (candidates for add)
      const presentActorIds = new Set(actorIds)
      if (teamId) {
        const { data: teamAgentRows, error: teamAgentsErr } = await supabase
          .from('actors')
          .select('id, display_name, actor_type')
          .eq('team_id', teamId)
          .eq('actor_type', 'agent')
        if (!cancelled) {
          if (teamAgentsErr) {
            console.error('[SessionActorSheet] team agents fetch failed (non-fatal)', teamAgentsErr)
          } else {
            const candidates = (teamAgentRows ?? []).filter(
              (a: { id: string; display_name: string; actor_type: string }) => !presentActorIds.has(a.id),
            )
            setCandidateAgents(candidates as Array<{ id: string; display_name: string }>)
          }
        }
      }

      if (cancelled) return

      setRows((actorData ?? []) as Row[])
      setAgentToRuntimeId(runtimeMap)
      setMyActorId(myActorIdLocal)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, sessionId, teamId])

  async function confirmRemove(actor: Row) {
    if (!sessionId) return
    const prevRows = rows
    // Optimistic: drop the row immediately
    setRows(prev => prev.filter(r => r.id !== actor.id))
    setPendingRemove(null)
    const { error: deleteErr } = await supabase
      .from('session_participants')
      .delete()
      .eq('session_id', sessionId)
      .eq('actor_id', actor.id)
    if (deleteErr) {
      console.error('[SessionActorSheet] remove failed:', deleteErr)
      // Rollback
      setRows(prevRows)
      // Toast
      const { toast } = await import('sonner')
      toast.error(t('chat.actorSheet.removeError', 'Failed to remove from session'))
    }
  }

  async function handleAddAgent() {
    if (!sessionId || !teamId) return
    if (candidateAgents.length === 0) return
    if (addingAgent) return

    const candidate = candidateAgents[0] // MVP: pick the first available
    setAddingAgent(true)

    // Snapshot for rollback
    const prevRows = rows
    const prevCandidates = candidateAgents

    // Optimistic: insert as a "starting"-state agent row
    const newRow: Row = {
      id: candidate.id,
      actor_type: 'agent',
      display_name: candidate.display_name,
      member_status: null,
      agent_status: 'starting',
      agent_kind: null,
      last_active_at: null,
    }
    setRows(prev => [...prev, newRow])
    setCandidateAgents(prev => prev.filter(c => c.id !== candidate.id))

    try {
      // 1. Insert into session_participants
      const { error: insErr } = await supabase
        .from('session_participants')
        .insert({ session_id: sessionId, actor_id: candidate.id })
      if (insErr) throw insErr

      // 2. Derive workspace from the agent's prior runtime history
      const { data: priorRows } = await supabase
        .from('agent_runtimes')
        .select('workspace_id, agent_id, current_model, status, updated_at')
        .eq('agent_id', candidate.id)
        .eq('team_id', teamId)
        .order('updated_at', { ascending: false })
        .limit(1)

      const workspaceId = priorRows?.[0]?.workspace_id ?? ''

      // 3. Call runtimeStart RPC
      const { runtimeStart } = await import('@/lib/teamclaw-rpc')
      const { AgentType } = await import('@/lib/proto/amux_pb')
      const result = await runtimeStart({
        workspaceId,
        worktree: '', // daemon falls back to '.' when empty
        sessionId,
        agentType: AgentType.CLAUDE_CODE,
        initialPrompt: '',
      })
      if (!result.accepted) {
        throw new Error(result.rejectedReason || 'runtimeStart rejected')
      }
      // RuntimeInfo retain will arrive via store subscription and update the dot/model automatically
    } catch (e) {
      console.error('[SessionActorSheet] add agent failed:', e)
      // Rollback
      setRows(prevRows)
      setCandidateAgents(prevCandidates)
      const { toast } = await import('sonner')
      toast.error(t('chat.actorSheet.addError', 'Failed to add agent'))
    } finally {
      setAddingAgent(false)
    }
  }

  const members = rows.filter((a) => a.actor_type === 'member')
  const agents = rows.filter((a) => a.actor_type === 'agent')

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:w-96 p-0 flex flex-col">
          <SheetHeader className="px-4 py-3 border-b">
            <SheetTitle>{t('chat.actorSheet.title', 'Actors')}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && (
              <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="mb-2 h-5 w-5 animate-spin" />
                <span>{t('chat.actorSheet.loading', 'Loading actors...')}</span>
              </div>
            )}

            {!loading && error && (
              <div className="px-4 py-3 text-sm text-destructive">
                {t('chat.actorSheet.error', 'Failed to load actors')}
              </div>
            )}

            {!loading && !error && members.length === 0 && agents.length === 0 && candidateAgents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
                <Users className="mb-2 h-8 w-8 text-muted-foreground" />
                <span>{t('chat.actorSheet.empty', 'No participants in this session')}</span>
              </div>
            )}

            {!loading && !error && (members.length > 0 || agents.length > 0 || candidateAgents.length > 0) && (
              <>
                {members.length > 0 && (
                  <>
                    <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {t('chat.mentionGroupMembers', 'Members')}
                    </div>
                    {members.map((m) => (
                      <ActorRowView
                        key={m.id}
                        actor={m}
                        canRemove={!!myActorId && m.id !== myActorId}
                        onRemove={() => setPendingRemove(m)}
                      />
                    ))}
                  </>
                )}
                {(agents.length > 0 || candidateAgents.length > 0) && (
                  <>
                    <div className="flex items-center justify-between px-4 pb-1 pt-3">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                        {t('chat.mentionGroupAgents', 'Agents')}
                      </span>
                      {candidateAgents.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => void handleAddAgent()}
                          disabled={addingAgent}
                          aria-label={t('chat.actorSheet.addAgentAria', 'Add agent')}
                        >
                          {addingAgent
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Plus className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </div>
                    {agents.map((a) => {
                      const runtimeId = agentToRuntimeId.get(a.id)
                      const info = runtimeId ? runtimeStates[runtimeId]?.info : undefined
                      return (
                        <ActorRowView
                          key={a.id}
                          actor={a}
                          runtimeInfo={info}
                          canRemove={!!myActorId}
                          onRemove={() => setPendingRemove(a)}
                        />
                      )
                    })}
                  </>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!pendingRemove} onOpenChange={(open) => { if (!open) setPendingRemove(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.actorSheet.removeTitle', 'Remove from session?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove && t('chat.actorSheet.removeDesc', 'Remove {{name}} from this session?', { name: pendingRemove.display_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingRemove) void confirmRemove(pendingRemove) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('chat.actorSheet.removeConfirm', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
