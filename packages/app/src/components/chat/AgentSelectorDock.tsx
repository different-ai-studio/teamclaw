import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { supabase } from '@/lib/supabase-client'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session'
import { setModel } from '@/lib/teamclaw-rpc'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'
import { cn } from '@/lib/utils'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface AgentSelectorDockProps {
  engagedAgent: AttachedAgent | null
  onEngageAgent: (agent: AttachedAgent) => void
}

type SessionAgent = { id: string; display_name: string }

// ────────────────────────────────────────────────────────────────────────────
// Status dot helper
// ────────────────────────────────────────────────────────────────────────────

function dotClasses(info: RuntimeInfo | undefined): { color: string; pulse: boolean } {
  if (!info) return { color: 'bg-muted-foreground/40', pulse: false }
  switch (info.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', pulse: false }
    case RuntimeLifecycle.STARTING:
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
      return { color: 'bg-muted-foreground/40', pulse: false }
    case RuntimeLifecycle.ACTIVE:
      switch (info.status) {
        case AgentStatus.ACTIVE: return { color: 'bg-emerald-500', pulse: true }
        case AgentStatus.IDLE:   return { color: 'bg-emerald-500', pulse: false }
        case AgentStatus.ERROR:  return { color: 'bg-red-500', pulse: false }
        default:                  return { color: 'bg-muted-foreground/40', pulse: false }
      }
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export function AgentSelectorDock({ engagedAgent, onEngageAgent }: AgentSelectorDockProps) {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessionRow = useSessionListStore((s) => s.rows.find((r) => r.id === activeSessionId))
  const fallbackTeamId = useSessionListStore((s) => s.rows[0]?.team_id ?? null)
  const _teamId = sessionRow?.team_id ?? fallbackTeamId

  const [sessionAgents, setSessionAgents] = React.useState<SessionAgent[]>([])
  const [agentToRuntimeId, setAgentToRuntimeId] = React.useState<Map<string, string>>(new Map())
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)

  // Load session participants + agent_runtimes mapping when session changes.
  React.useEffect(() => {
    if (!activeSessionId) {
      setSessionAgents([])
      setAgentToRuntimeId(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      // Fetch session participants
      const { data: parts } = await supabase
        .from('session_participants')
        .select('actor_id')
        .eq('session_id', activeSessionId)
      if (cancelled) return
      const actorIds = (parts ?? []).map((r: { actor_id: string }) => r.actor_id)
      if (actorIds.length === 0) {
        setSessionAgents([])
        setAgentToRuntimeId(new Map())
        return
      }
      const { data: actors } = await supabase
        .from('actors')
        .select('id, display_name, actor_type')
        .in('id', actorIds)
        .eq('actor_type', 'agent')
      if (cancelled) return
      setSessionAgents((actors ?? []) as SessionAgent[])

      // Fetch agent_runtimes for live RuntimeInfo lookup
      const { data: rtRows } = await supabase
        .from('agent_runtimes')
        .select('agent_id, runtime_id')
        .eq('session_id', activeSessionId)
      if (cancelled) return
      const map = new Map<string, string>()
      for (const r of (rtRows ?? []) as { agent_id: string; runtime_id: string }[]) {
        if (r.agent_id && r.runtime_id) map.set(r.agent_id, r.runtime_id)
      }
      setAgentToRuntimeId(map)
    })()
    return () => { cancelled = true }
  }, [activeSessionId])

  const engagedRuntimeId = engagedAgent ? agentToRuntimeId.get(engagedAgent.id) : undefined
  const engagedRuntimeInfo = engagedRuntimeId ? runtimeStates[engagedRuntimeId]?.info : undefined
  const { color: dotColor, pulse } = dotClasses(engagedRuntimeInfo)

  const availableModels = engagedRuntimeInfo?.availableModels ?? []
  const currentModel = engagedRuntimeInfo?.currentModel ?? ''

  const handlePickModel = React.useCallback(async (modelId: string) => {
    if (!engagedAgent || !engagedRuntimeId) return
    try {
      await setModel({
        targetDeviceId: engagedAgent.id,  // daemon device_id == agent actor_id convention
        runtimeId: engagedRuntimeId,
        modelId,
      })
    } catch (e) {
      const { toast } = await import('sonner')
      toast.error(t('chat.agentSelector.modelChangeFailed', 'Failed to change model'))
      console.error('[AgentSelectorDock] setModel failed', e)
    }
  }, [engagedAgent, engagedRuntimeId, t])

  return (
    <div className="flex items-center gap-1">
      {/* Agent dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-full bg-muted/40 px-2 text-xs font-medium"
          >
            <div className="relative flex h-4 w-4 items-center justify-center">
              <Sparkles className="h-3 w-3 text-muted-foreground" />
              <span className={cn(
                'absolute -bottom-0 -right-0 h-2 w-2 rounded-full ring-1 ring-background',
                dotColor,
                pulse && 'animate-pulse',
              )} />
            </div>
            <span className="truncate max-w-[10rem]">
              {engagedAgent?.displayName ?? t('chat.agentSelector.noAgent', 'No agent')}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[12rem]">
          {sessionAgents.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('chat.agentSelector.pickAgent', 'Add an agent to this session first')}
            </div>
          ) : (
            sessionAgents.map((a) => (
              <DropdownMenuItem
                key={a.id}
                onClick={() => onEngageAgent({ id: a.id, displayName: a.display_name })}
                className={cn(engagedAgent?.id === a.id && 'bg-muted')}
              >
                <Sparkles className="h-3.5 w-3.5 text-muted-foreground mr-1.5" />
                <span className="truncate">{a.display_name}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Model dropdown — only when an agent is engaged */}
      {engagedAgent && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-full bg-muted/40 px-2 text-xs text-muted-foreground"
            >
              <span className="truncate max-w-[8rem]">
                {currentModel || availableModels[0]?.id || t('chat.agentSelector.noModels', '—')}
              </span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[10rem]">
            {availableModels.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t('chat.agentSelector.noModels', 'No models advertised')}
              </div>
            ) : (
              availableModels.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => void handlePickModel(m.id)}
                  className={cn(m.id === currentModel && 'bg-muted')}
                >
                  <span className="truncate">{m.displayName || m.id}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
