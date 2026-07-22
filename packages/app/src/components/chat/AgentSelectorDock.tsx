import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { groupAgentModelOptions, resolveAgentAvailableModels } from '@/lib/agent-available-models'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'
import {
  backendTypeFromRuntimeEntry,
  agentModelDisplayLabel,
  isAgentModelRowSelected,
  resolveRuntimeStateEntryForAgent,
  resolveSetModelId,
  selectAgentModel,
} from '@/lib/runtime-state-resolve'
import { ensureRuntimeThenSetModel } from '@/lib/teamclaw/ensure-agent-runtime'
import { useAgentModelPickStore } from '@/stores/agent-model-pick-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { useSessionMessageStore } from '@/stores/session-message-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionListStore } from '@/stores/session-list-store'
import { useLocalDaemonActorId } from '@/lib/daemon-agent-admin'
import { cn } from '@/lib/utils'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'
import type { SessionAgentUiState } from '@/lib/session-agent-ui-state'
import {
  dotClassesForUiState,
  pillSuffixForUiState,
} from '@/components/chat/EngagedAgentOfflineBanner'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface AgentSelectorDockProps {
  /** The session currently displayed by ChatPanel. */
  activeSessionId: string | null
  /** All agents currently @-mentioned for the active session — one pill each. */
  engagedAgents: AttachedAgent[]
  /** Precomputed in ChatPanel — shared with banner / send confirm. */
  engagedUiEntries: EngagedAgentUiEntry[]
  agentToRuntimeId: Map<string, string>
  agentToBackendType: Map<string, string>
  /** Remove a single agent (clicked the X on the chip / "Remove" in dropdown). */
  onRemoveAgent: (agentId: string) => void
}

export { resolveAgentAvailableModels } from '@/lib/agent-available-models'

/** Connected = green. Starting = yellow. Error = red. Stopped/unknown = gray. */
function dotClasses(info: RuntimeInfo | undefined): { color: string; pulse: boolean } {
  if (!info) return { color: 'bg-muted-foreground/40', pulse: false }
  switch (info.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', pulse: false }
    case RuntimeLifecycle.STARTING:
      return { color: 'bg-amber-400', pulse: false }
    case RuntimeLifecycle.ACTIVE:
      if (info.status === AgentStatus.ERROR) {
        return { color: 'bg-red-500', pulse: false }
      }
      return { color: 'bg-emerald-500', pulse: false }
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export function AgentSelectorDock({
  activeSessionId,
  engagedAgents,
  engagedUiEntries,
  agentToRuntimeId,
  agentToBackendType,
  onRemoveAgent,
}: AgentSelectorDockProps) {
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)
  const uiStateByAgentId = React.useMemo(
    () => new Map(engagedUiEntries.map((e) => [e.agent.id, e.uiState])),
    [engagedUiEntries],
  )

  if (engagedAgents.length === 0) return null

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {engagedAgents.map((agent) => {
        const dbRuntimeId = agentToRuntimeId.get(agent.id)
        const runtimeEntry = resolveRuntimeStateEntryForAgent(
          agent.id,
          runtimeStates,
          dbRuntimeId,
        )
        const backendType = backendTypeFromRuntimeEntry(
          runtimeEntry,
          agentToBackendType.get(agent.id),
        )
        return (
          <AgentPill
            key={agent.id}
            sessionIdProp={activeSessionId}
            agent={agent}
            dbRuntimeId={dbRuntimeId}
            backendType={backendType}
            runtimeInfo={runtimeEntry?.info}
            uiState={uiStateByAgentId.get(agent.id) ?? 'connecting'}
            onRemove={() => {
              if (activeSessionId) {
                useAgentModelPickStore.getState().clearPick(activeSessionId, agent.id)
              }
              onRemoveAgent(agent.id)
            }}
          />
        )
      })}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Per-agent pill
// ────────────────────────────────────────────────────────────────────────────

function AgentPill({
  sessionIdProp,
  agent,
  dbRuntimeId,
  backendType,
  runtimeInfo,
  uiState,
  onRemove,
}: {
  sessionIdProp: string | null
  agent: AttachedAgent
  dbRuntimeId: string | undefined
  backendType: string | undefined
  runtimeInfo: RuntimeInfo | undefined
  uiState: SessionAgentUiState
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const localActorId = useLocalDaemonActorId()
  const isSelf = !!localActorId && agent.id === localActorId
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)
  const sessionId =
    sessionIdProp?.trim() ||
    useSessionSelectionStore.getState().activeSessionId?.trim() ||
    ''

  const liveRuntimeEntry = React.useMemo(
    () => resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId),
    [agent.id, byRuntimeId, dbRuntimeId],
  )
  const liveRuntimeInfo = liveRuntimeEntry?.info ?? runtimeInfo
  const effectiveUiState: SessionAgentUiState = uiState
  const runtimeDot = dotClasses(liveRuntimeInfo)
  const { color: dotColor, pulse } =
    effectiveUiState === 'ready' ? runtimeDot : dotClassesForUiState(effectiveUiState)

  const availableModels = React.useMemo(
    () => resolveAgentAvailableModels(liveRuntimeInfo),
    [liveRuntimeInfo],
  )
  const statusSuffix = pillSuffixForUiState(effectiveUiState, t)
  const showModelPicker = effectiveUiState === 'ready' || effectiveUiState === 'connecting'
  const runtimeInfoLoading =
    showModelPicker &&
    availableModels.length === 0 &&
    (!liveRuntimeInfo || liveRuntimeInfo.state === RuntimeLifecycle.STARTING)
  // Subscribe to the pick entry so explicit user picks immediately drive the
  // pill — selectAgentModel reads the same store but via getState() and would
  // otherwise miss a re-render trigger.
  const pickEntry = useAgentModelPickStore((s) =>
    sessionId ? s.bySessionAgent[`${sessionId}::${agent.id}`] : undefined,
  )
  // The model this session already ran with, from its transcript. Prefer the
  // latest reply authored by THIS agent; fall back to the latest modeled
  // message. Empty for brand-new sessions, so they keep the last-pick default.
  const sessionEstablishedModel = useSessionMessageStore((s) => {
    if (!sessionId) return null
    const msgs = s.messages[sessionId]
    if (!msgs?.length) return null
    let fallback: string | null = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const model = msgs[i].model?.trim()
      if (!model) continue
      if (msgs[i].senderActorId === agent.id) return model
      if (!fallback) fallback = model
    }
    return fallback
  })

  const selected = React.useMemo(
    () =>
      selectAgentModel({
        sessionId,
        agentId: agent.id,
        available: availableModels,
        byRuntimeId,
        sessionEstablishedModel,
      }),
    [
      sessionId,
      agent.id,
      availableModels,
      byRuntimeId,
      sessionEstablishedModel,
      // Force recompute when the pick changes — pickEntry is referenced for
      // the dependency hint; selectAgentModel reads from store.getState().
      pickEntry?.modelId,
    ],
  )
  const effectiveModelId = selected.modelId
  const displayedModel =
    availableModels.find((m) => m.id === effectiveModelId)?.displayName ||
    (effectiveModelId
      ? agentModelDisplayLabel(effectiveModelId, availableModels)
      : '') ||
    (runtimeInfoLoading ? '' : availableModels[0]?.displayName || availableModels[0]?.id || '')
  // Pill shows user pick or live retain; list[0] is only a loading placeholder.
  const isPlaceholderModel = selected.source === 'none' && !!displayedModel

  const displayRuntimeId = liveRuntimeInfo?.runtimeId?.trim() || dbRuntimeId
  const [modelSearch, setModelSearch] = React.useState('')
  const filteredModels = React.useMemo(() => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return availableModels
    return availableModels.filter((m) => {
      const label = (m.displayName || m.id).toLowerCase()
      return (
        label.includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.providerName ?? '').toLowerCase().includes(q)
      )
    })
  }, [availableModels, modelSearch])
  const modelGroups = React.useMemo(
    () => groupAgentModelOptions(filteredModels),
    [filteredModels],
  )

  React.useEffect(() => {
    if (!open) setModelSearch('')
  }, [open])

  // On open, scroll the currently-selected model row into view (the list can
  // be long — landing at the top loses the user's place). Runs once per open,
  // re-armed if models arrive async after the popover mounts; skipped while
  // the user is filtering.
  const modelListRef = React.useRef<HTMLDivElement>(null)
  const scrolledToSelectionRef = React.useRef(false)
  React.useEffect(() => {
    if (!open) {
      scrolledToSelectionRef.current = false
      return
    }
    if (scrolledToSelectionRef.current || modelSearch) return
    const raf = requestAnimationFrame(() => {
      const el = modelListRef.current?.querySelector(
        '[data-model-selected="true"]',
      )
      if (el) {
        el.scrollIntoView({ block: 'center' })
        scrolledToSelectionRef.current = true
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [open, modelSearch, filteredModels])

  React.useEffect(() => {
    sessionFlowLog('agent_selector.model_options.resolved', {
      agentId: agent.id,
      agentName: agent.displayName,
      runtimeId: displayRuntimeId,
      backendType,
      runtimeCurrentModel: liveRuntimeInfo?.currentModel ?? null,
      runtimeAvailableModelIds: liveRuntimeInfo?.availableModels.map((m) => m.id) ?? [],
      resolvedModelIds: availableModels.map((m) => m.id),
      runtimeInfoLoading,
    })
  }, [
    agent.id,
    agent.displayName,
    displayRuntimeId,
    backendType,
    liveRuntimeInfo?.currentModel,
    liveRuntimeInfo?.availableModels,
    availableModels,
    runtimeInfoLoading,
  ])

  const handlePickModel = React.useCallback(async (modelId: string) => {
    const freshByRuntimeId = useRuntimeStateStore.getState().byRuntimeId
    const rpcModelId = resolveSetModelId(agent.id, modelId, freshByRuntimeId)
    const teamId =
      useSessionListStore.getState().rows.find((r) => r.id === sessionId)?.team_id ??
      useCurrentTeamStore.getState().team?.id ??
      null

    sessionFlowLog('agent_selector.model_pick.begin', {
      agentId: agent.id,
      agentName: agent.displayName,
      dbRuntimeId,
      teamId,
      effectiveModelId,
      modelId,
      rpcModelId,
      availableModelIds: availableModels.map((m) => m.id),
    })

    // Store the pick FIRST. Survives reload; MQTT retains cannot override it.
    if (sessionId) {
      useAgentModelPickStore.getState().setPick(sessionId, agent.id, rpcModelId)
    }

    if (!sessionId || !teamId) {
      sessionFlowLog('agent_selector.model_pick.deferred_until_session', {
        agentId: agent.id,
        modelId,
        sessionId,
        teamId,
      })
      const { toast } = await import('sonner')
      toast.success(t('chat.agentSelector.modelPickSaved', '模型已选择'), {
        description: t(
          'chat.agentSelector.modelPickSavedHint',
          '将在发送消息或 runtime 就绪后应用到 Agent',
        ),
      })
      return
    }

    // Ask daemon for the live spawn (runtimeStart, with dedup), then setModel
    // with that authoritative id — never guess from MQTT/DB hints.
    try {
      const { runtimeId } = await ensureRuntimeThenSetModel({
        sessionId,
        teamId,
        agentActorId: agent.id,
        modelId: rpcModelId,
      })
      sessionFlowLog('agent_selector.model_pick.ok', {
        agentId: agent.id,
        runtimeId,
        modelId: rpcModelId,
        sessionId,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      sessionFlowError('agent_selector.model_pick.failed', e, {
        agentId: agent.id,
        modelId: rpcModelId,
        sessionId,
        teamId,
      })
      const { toast } = await import('sonner')
      toast.error(t('chat.agentSelector.modelChangeFailed', 'Failed to change model'), {
        description: t(
          'chat.agentSelector.modelChangeWillRetry',
          '选择已保存，将在下次发送消息时重新应用。详情: {{message}}',
          { message },
        ),
      })
      console.error('[AgentSelectorDock] ensureRuntimeThenSetModel failed (pick preserved)', e)
    }
  }, [agent.id, agent.displayName, dbRuntimeId, sessionId, t, effectiveModelId, availableModels])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 min-w-0 max-w-full gap-1 overflow-hidden rounded-full bg-muted/40 px-2 text-xs font-medium',
            effectiveUiState === 'stale' && 'border border-dashed border-border',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              dotColor,
              pulse && 'animate-pulse',
            )}
          />
          {isSelf ? null : <span className="min-w-0 truncate">{agent.displayName}</span>}
          {statusSuffix ? (
            <>
              {isSelf ? null : <span className="shrink-0 text-muted-foreground/70">·</span>}
              <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
                {effectiveUiState === 'connecting' && runtimeInfoLoading ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    {statusSuffix}
                  </span>
                ) : (
                  statusSuffix
                )}
              </span>
            </>
          ) : runtimeInfoLoading && !displayedModel ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          ) : displayedModel ? (
            <>
              {isSelf ? null : <span className="shrink-0 text-muted-foreground/70">·</span>}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-[11px]',
                  isPlaceholderModel
                    ? 'italic text-muted-foreground/50'
                    : 'text-muted-foreground',
                )}
                title={isPlaceholderModel
                  ? t('chat.agentSelector.placeholderModelHint', 'No live runtime — dropdown will default to this model')
                  : undefined}
              >
                {displayedModel}
              </span>
            </>
          ) : null}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[18rem] p-0"
      >
        <Command shouldFilter={false}>
          {availableModels.length > 0 ? (
            <CommandInput
              value={modelSearch}
              onValueChange={setModelSearch}
              placeholder={t('chat.agentSelector.searchModelPlaceholder', 'Search models…')}
              className="text-xs"
            />
          ) : null}
          <CommandList ref={modelListRef} className="max-h-[18rem]">
            {effectiveUiState === 'offline' || effectiveUiState === 'stale' ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {effectiveUiState === 'stale'
                  ? t('chat.sessionAgent.dropdownStale')
                  : t('chat.sessionAgent.dropdownOffline')}
              </div>
            ) : runtimeInfoLoading ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.agentSelector.loading', 'Loading…')}
              </div>
            ) : availableModels.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.agentSelector.noModels', 'No models advertised')}
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.agentSelector.noMatchingModels', 'No matching models')}
              </div>
            ) : (
              <>
                {modelGroups.map((group) => (
                  <CommandGroup key={group.providerName} heading={group.providerName}>
                    {group.models.map((m) => {
                      const label = m.displayName || m.id
                      const selected = isAgentModelRowSelected(
                        m.id,
                        effectiveModelId,
                      )
                      return (
                        <CommandItem
                          key={m.id}
                          value={`${label} ${m.id}`}
                          data-model-selected={selected ? 'true' : undefined}
                          onSelect={() => {
                            setOpen(false)
                            void handlePickModel(m.id)
                          }}
                          className="text-xs py-1.5"
                        >
                          <Check
                            className={cn(
                              'h-3.5 w-3.5 mr-1.5 shrink-0',
                              selected ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                          <span className="truncate">{label}</span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                ))}
              </>
            )}
          </CommandList>
          <CommandSeparator />
          <div className="p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onRemove()
              }}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
            >
              <X className="h-3.5 w-3.5 mr-1.5" />
              {t('chat.agentSelector.removeMention', 'Remove mention')}
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
