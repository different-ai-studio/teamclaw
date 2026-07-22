import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentSelectorDock, resolveAgentAvailableModels } from '../AgentSelectorDock'
import { useAgentModelPickStore } from '@/stores/agent-model-pick-store'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'

const mocks = vi.hoisted(() => ({
  runtimeStates: {} as Record<string, unknown>,
  isInternalBuild: vi.fn(() => false),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: (selector: (s: unknown) => unknown) =>
    selector({ byRuntimeId: mocks.runtimeStates }),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: vi.fn(),
}))

vi.mock('@/lib/internal-build', () => ({
  isInternalBuild: () => mocks.isInternalBuild(),
}))

vi.mock('@/lib/teamclaw/ensure-agent-runtime', () => ({
  ensureRuntimeThenSetModel: vi.fn(),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-1' } }),
  },
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({ rows: [{ id: 'session-1', team_id: 'team-1' }] }),
  },
}))

function dockProps(
  partial: Partial<React.ComponentProps<typeof AgentSelectorDock>> &
    Pick<React.ComponentProps<typeof AgentSelectorDock>, 'engagedAgents'>,
) {
  const engagedAgents = partial.engagedAgents ?? []
  const engagedUiEntries: EngagedAgentUiEntry[] =
    partial.engagedUiEntries ??
    engagedAgents.map((agent) => ({ agent, uiState: 'ready' as const }))
  return {
    activeSessionId: null as string | null,
    engagedUiEntries,
    agentToRuntimeId: new Map<string, string>(),
    agentToBackendType: new Map<string, string>(),
    onRemoveAgent: vi.fn(),
    ...partial,
    engagedAgents,
  }
}

describe('AgentSelectorDock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runtimeStates = {}
    mocks.isInternalBuild.mockReturnValue(false)
    useAgentModelPickStore.setState({ bySessionAgent: {} })
    useActorPresenceStore.setState({ byActorId: {} })
  })

  it('renders nothing when no agents are engaged', () => {
    const { container } = render(
      <AgentSelectorDock {...dockProps({ engagedAgents: [] })} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders one pill per engaged agent', () => {
    render(
      <AgentSelectorDock
        {...dockProps({
          engagedAgents: [
            { id: 'a-1', displayName: 'Reviewer Bot' },
            { id: 'a-2', displayName: 'Ops Buddy' },
          ],
        })}
      />,
    )
    expect(screen.getByText('Reviewer Bot')).toBeInTheDocument()
    expect(screen.getByText('Ops Buddy')).toBeInTheDocument()
  })

  it('does not synthesize fallback models when runtime info has not advertised models', () => {
    expect(resolveAgentAvailableModels(undefined)).toEqual([])
    expect(resolveAgentAvailableModels({ availableModels: [] } as any)).toEqual([])
    expect(resolveAgentAvailableModels({
      availableModels: [{ id: 'm-1', displayName: 'Model One' }],
    } as any)).toEqual([{ id: 'm-1', displayName: 'Model One' }])
  })

  it('shows ACP-advertised models when retain is keyed by agent id but DB runtime id differs', async () => {
    mocks.runtimeStates = {
      'a-1': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          agentType: 2,
          availableModels: [{ id: 'anthropic/claude-sonnet-4.6', displayName: 'Sonnet 4.6' }],
          currentModel: 'anthropic/claude-sonnet-4.6',
        },
      },
    }

    render(
      <AgentSelectorDock
        {...dockProps({
          activeSessionId: 'session-1',
          engagedAgents: [{ id: 'a-1', displayName: 'OpenCode Bot' }],
          agentToRuntimeId: new Map([['a-1', 'uuid-db']]),
          agentToBackendType: new Map([['a-1', 'opencode']]),
        })}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /OpenCode Bot/i }))
    expect((await screen.findAllByText('Sonnet 4.6')).length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the newest runtime row when duplicate rows arrive newest-first', async () => {
    mocks.runtimeStates = {
      'runtime-new': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [],
          currentModel: 'new-model',
        },
      },
      'runtime-old': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now() - 1,
        info: {
          availableModels: [],
          currentModel: 'old-model',
        },
      },
    }

    render(
      <AgentSelectorDock
        {...dockProps({
          activeSessionId: 'session-1',
          engagedAgents: [{ id: 'a-1', displayName: 'OpenCode Bot' }],
          agentToRuntimeId: new Map([['a-1', 'runtime-new']]),
        })}
      />,
    )

    expect(await screen.findByText('new-model')).toBeInTheDocument()
    expect(screen.queryByText('old-model')).not.toBeInTheDocument()
  })

  it('hides model label on the pill in internal builds', async () => {
    mocks.isInternalBuild.mockReturnValue(true)
    mocks.runtimeStates = {
      'runtime-1': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [{ id: 'opencode/big-pickle', displayName: 'Big Pickle' }],
          currentModel: 'opencode/big-pickle',
          state: RuntimeLifecycle.ACTIVE,
        },
      },
    }

    render(
      <AgentSelectorDock
        {...dockProps({
          activeSessionId: 'session-1',
          engagedAgents: [{ id: 'a-1', displayName: 'OpenCode Bot' }],
          agentToRuntimeId: new Map([['a-1', 'runtime-1']]),
        })}
      />,
    )

    expect(await screen.findByRole('button', { name: /OpenCode Bot/i })).toBeInTheDocument()
    expect(screen.queryByText('Big Pickle')).not.toBeInTheDocument()
  })

  it('shows no-models hint when ACP retain has no available_models and runtime is active', async () => {
    mocks.runtimeStates = {
      'runtime-1': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [],
          currentModel: '',
          state: RuntimeLifecycle.ACTIVE,
        },
      },
    }

    render(
      <AgentSelectorDock
        {...dockProps({
          activeSessionId: 'session-1',
          engagedAgents: [{ id: 'a-1', displayName: 'OpenCode Bot' }],
          agentToRuntimeId: new Map([['a-1', 'runtime-1']]),
          agentToBackendType: new Map([['a-1', 'opencode']]),
        })}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /OpenCode Bot/i }))
    expect(await screen.findByText('No models advertised')).toBeInTheDocument()
  })

  it('lists only models from ACP retain on the runtime', async () => {
    mocks.runtimeStates = {
      'runtime-1': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [
            { id: 'opencode/big-pickle', displayName: 'Big Pickle' },
            { id: 'openai/gpt-5.2', displayName: 'GPT 5.2' },
          ],
          currentModel: 'opencode/big-pickle',
          state: RuntimeLifecycle.ACTIVE,
        },
      },
    }

    render(
      <AgentSelectorDock
        {...dockProps({
          activeSessionId: 'session-1',
          engagedAgents: [{ id: 'a-1', displayName: 'OpenCode Bot' }],
          agentToRuntimeId: new Map([['a-1', 'runtime-1']]),
        })}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /OpenCode Bot/i }))
    expect((await screen.findAllByText('Big Pickle')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('GPT 5.2')).toBeInTheDocument()
    expect(screen.queryByText('mimo-v2.5-free')).not.toBeInTheDocument()
  })

  it('shows offline pill suffix from engagedUiEntries', async () => {
    render(
      <AgentSelectorDock
        {...dockProps({
          engagedAgents: [{ id: 'a-1', displayName: 'Ghost Bot' }],
          engagedUiEntries: [
            {
              agent: { id: 'a-1', displayName: 'Ghost Bot' },
              uiState: 'offline',
            },
          ],
        })}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText(/Offline/i)).toBeInTheDocument()
    })
  })

  it('does not downgrade a ready local agent pill from stale offline presence', async () => {
    useActorPresenceStore.setState({
      byActorId: {
        'a-1': { online: false, displayName: 'OpenCode Bot', lastUpdated: Date.now() },
      },
    })

    render(
      <AgentSelectorDock
        {...dockProps({
          engagedAgents: [{ id: 'a-1', displayName: 'OpenCode Bot' }],
          engagedUiEntries: [
            {
              agent: { id: 'a-1', displayName: 'OpenCode Bot' },
              uiState: 'ready',
            },
          ],
        })}
      />,
    )

    expect(await screen.findByRole('button', { name: /OpenCode Bot/i })).toBeInTheDocument()
    expect(screen.queryByText(/Offline/i)).not.toBeInTheDocument()
  })
})
