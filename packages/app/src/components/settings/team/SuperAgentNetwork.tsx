/**
 * SuperAgentNetwork - shows connected agents with status indicators and capability tags.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import { useSuperAgentStore } from '@/stores/super-agent'
import type { AgentProfile, AgentStatus } from '@/stores/super-agent'

// ─── Status Dot ─────────────────────────────────────────────────────────────

function statusDotClass(status: AgentStatus): string {
  switch (status) {
    case 'online':
      return 'bg-green-500'
    case 'busy':
      return 'bg-yellow-500'
    case 'offline':
      return 'bg-red-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

// ─── Agent Card ──────────────────────────────────────────────────────────────

interface AgentCardProps {
  agent: AgentProfile
  isLocal: boolean
}

function AgentCard({ agent, isLocal }: AgentCardProps) {
  return (
    <div className="rounded-xl border bg-card p-4 transition-all">
      <div className="flex items-start gap-3">
        {/* Status dot */}
        <div className="mt-1.5 flex-shrink-0">
          <span
            className={cn(
              'block h-2.5 w-2.5 rounded-full',
              statusDotClass(agent.status)
            )}
            title={agent.status}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {/* Name row */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium leading-tight">{agent.name}</span>
            {isLocal && (
              <span className="rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground leading-none">
                you
              </span>
            )}
          </div>

          {/* Capability tags */}
          {agent.capabilities.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {agent.capabilities.map((cap) => (
                <span
                  key={cap.name}
                  className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  title={cap.description}
                >
                  {cap.name}
                </span>
              ))}
            </div>
          )}

          {/* Domain tag */}
          {agent.domain && (
            <p className="text-xs text-muted-foreground truncate">{agent.domain}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function SuperAgentNetwork() {
  const snapshot = useSuperAgentStore((s) => s.snapshot)
  const init = useSuperAgentStore((s) => s.init)

  React.useEffect(() => {
    let cleanup: (() => void) | undefined

    init().then((unlisten) => {
      cleanup = unlisten
    })

    return () => {
      cleanup?.()
    }
  }, [init])

  const { localAgent, agents } = snapshot

  // Build a unified list: local agent first, then remote agents
  const allAgents: Array<{ agent: AgentProfile; isLocal: boolean }> = []
  if (localAgent) {
    allAgents.push({ agent: localAgent, isLocal: true })
  }
  for (const agent of agents) {
    allAgents.push({ agent, isLocal: false })
  }

  const onlineCount = allAgents.filter(
    ({ agent }) => agent.status === 'online' || agent.status === 'busy'
  ).length
  const totalCount = allAgents.length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Connected Agents</p>
          {totalCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {onlineCount} of {totalCount} online
            </p>
          )}
        </div>
      </div>

      {/* Agent list or empty state */}
      {allAgents.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">No agents connected</p>
        </div>
      ) : (
        <div className="space-y-2">
          {allAgents.map(({ agent, isLocal }) => (
            <AgentCard key={agent.agentId} agent={agent} isLocal={isLocal} />
          ))}
        </div>
      )}
    </div>
  )
}
