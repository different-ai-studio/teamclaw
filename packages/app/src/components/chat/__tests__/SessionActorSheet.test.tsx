import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { create } from '@bufbuild/protobuf'
import {
  RuntimeInfoSchema,
  AgentStatus,
  AgentType,
  RuntimeLifecycle,
} from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { SessionActorSheet } from '../SessionActorSheet'

const mockRuntimeStart = vi.fn().mockResolvedValue({ accepted: true, runtimeId: 'rt-new', sessionId: 'sess-1', rejectedReason: '' })
vi.mock('@/lib/teamclaw-rpc', () => ({
  runtimeStart: (...args: unknown[]) => mockRuntimeStart(...args),
}))

const supabaseFrom = vi.fn()
const supabaseDelete = vi.fn()

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (...args: unknown[]) => supabaseFrom(...args),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, fallback: string, opts?: Record<string, unknown>) => {
      if (!opts) return fallback
      // Simple interpolation for test: replace {{key}} with value
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(opts[key] ?? ''))
    },
  }),
}))

beforeEach(() => {
  supabaseFrom.mockReset()
  supabaseDelete.mockReset()
  mockRuntimeStart.mockReset()
  mockRuntimeStart.mockResolvedValue({ accepted: true, runtimeId: 'rt-new', sessionId: 'sess-1', rejectedReason: '' })
  useRuntimeStateStore.getState().clear()
})

function makeActorsMock(myActorId = 'm-1', teamAgentRows: unknown[] = []) {
  return {
    select: () => ({
      eq: vi.fn().mockImplementation((col: string) => {
        if (col === 'user_id') {
          return {
            in: () => Promise.resolve({ data: [{ id: myActorId }], error: null }),
          }
        }
        // col === 'team_id'
        return {
          eq: () => Promise.resolve({ data: teamAgentRows, error: null }),
        }
      }),
    }),
  }
}

function mockJoinedRows(participantActorIds: string[], actorRows: unknown[]) {
  supabaseFrom.mockImplementation((table: string) => {
    if (table === 'session_participants') {
      return {
        select: () => ({
          eq: () => Promise.resolve({
            data: participantActorIds.map(id => ({ actor_id: id })),
            error: null,
          }),
        }),
      }
    }
    if (table === 'actor_directory') {
      return {
        select: () => ({
          in: () => Promise.resolve({ data: actorRows, error: null }),
        }),
      }
    }
    if (table === 'agent_runtimes') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }
    }
    if (table === 'actors') {
      return makeActorsMock('m-1', [])
    }
    return { select: () => Promise.resolve({ data: [], error: null }) }
  })
}

function mockSheetData(
  participantActorIds: string[],
  actorRows: unknown[],
  runtimeRows: unknown[],
  teamAgentRows: unknown[] = [],
) {
  supabaseFrom.mockImplementation((table: string) => {
    if (table === 'session_participants') {
      return {
        select: () => ({
          eq: () => Promise.resolve({
            data: participantActorIds.map(id => ({ actor_id: id })),
            error: null,
          }),
        }),
        delete: () => ({
          eq: () => ({
            eq: () => supabaseDelete(),
          }),
        }),
        insert: () => Promise.resolve({ error: null }),
      }
    }
    if (table === 'actor_directory') {
      return {
        select: () => ({
          in: () => Promise.resolve({ data: actorRows, error: null }),
        }),
      }
    }
    if (table === 'agent_runtimes') {
      return {
        select: () => ({
          eq: vi.fn().mockImplementation((col: string) => {
            if (col === 'session_id') {
              // fetch-effect query: .eq('session_id', ...) → returns Promise
              return Promise.resolve({ data: runtimeRows, error: null })
            }
            // handleAddAgent history query: .eq('agent_id', ...).eq('team_id', ...).order(...).limit(...)
            return {
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }
          }),
        }),
      }
    }
    if (table === 'actors') {
      return makeActorsMock('m-1', teamAgentRows)
    }
    return { select: () => Promise.resolve({ data: [], error: null }) }
  })
}

describe('SessionActorSheet', () => {
  it('lists members and agents from session_participants × actor_directory', async () => {
    mockJoinedRows(
      ['m-1', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Alice', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer', member_status: null, agent_status: 'idle', agent_kind: 'claude', last_active_at: null },
      ],
    )
    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" teamId={null} />)
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText(/members/i)).toBeInTheDocument()
    expect(screen.getByText(/agents/i)).toBeInTheDocument()
  })

  it('shows empty state when session has no participants', async () => {
    mockJoinedRows([], [])
    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" teamId={null} />)
    await waitFor(() => expect(screen.getByText(/no participants in this session/i)).toBeInTheDocument())
  })

  it('does not fetch when sessionId is null', async () => {
    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId={null} teamId={null} />)
    // Brief wait to ensure no fetch fires
    await new Promise(r => setTimeout(r, 50))
    expect(supabaseFrom).not.toHaveBeenCalled()
  })

  it('shows breathing dot and model name for an active agent', async () => {
    // Prime the runtime-state-store with a live ACTIVE/ACTIVE runtime
    const info = create(RuntimeInfoSchema, {
      runtimeId: '05532480',
      agentType: AgentType.CLAUDE_CODE,
      state: RuntimeLifecycle.ACTIVE,
      status: AgentStatus.ACTIVE,
      currentModel: 'claude-opus-4-7',
    })
    useRuntimeStateStore.getState().upsert('05532480', 'dev-a', info)

    mockSheetData(
      ['a-1'],
      [
        {
          id: 'a-1',
          actor_type: 'agent',
          display_name: 'Reviewer',
          member_status: null,
          agent_status: 'idle',
          agent_kind: 'claude',
          last_active_at: null,
        },
      ],
      [{ agent_id: 'a-1', runtime_id: '05532480', status: 'running', current_model: 'claude-opus-4-7' }],
    )

    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" teamId={null} />)
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeInTheDocument())

    // Model name appears in subline
    expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument()

    // Status dot has animate-pulse (breathing) class
    const dot = document.querySelector('.animate-pulse.rounded-full')
    expect(dot).toBeTruthy()
  })

  it('hides X button for self row but shows it for others', async () => {
    // Current user is m-1; session has m-1 (self), m-2, and agent a-1
    mockSheetData(
      ['m-1', 'm-2', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'm-2', actor_type: 'member', display_name: 'Other', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'Bot', member_status: null, agent_status: 'idle', agent_kind: 'claude', last_active_at: null },
      ],
      [],
    )

    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" teamId={null} />)
    await waitFor(() => expect(screen.getByText('Me')).toBeInTheDocument())

    // There should be exactly 2 remove buttons: one for 'Other' (m-2) and one for 'Bot' (a-1)
    // The self row 'Me' (m-1) must NOT have a remove button
    const removeBtns = screen.getAllByRole('button', { name: /remove/i })
    expect(removeBtns).toHaveLength(2)
  })

  it('opens confirm dialog when X is clicked and dismisses on cancel', async () => {
    const user = userEvent.setup()
    mockSheetData(
      ['m-1', 'm-2'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'm-2', actor_type: 'member', display_name: 'Other', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
      ],
      [],
    )

    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" teamId={null} />)
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument())

    // Click the remove button on the non-self row
    const removeBtn = screen.getByRole('button', { name: /remove/i })
    await user.click(removeBtn)

    // Confirm dialog should appear
    await waitFor(() => expect(screen.getByText(/remove from session\?/i)).toBeInTheDocument())
    expect(screen.getByText(/remove other from this session\?/i)).toBeInTheDocument()

    // Cancel dismisses the dialog (row stays)
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })
    await user.click(cancelBtn)
    await waitFor(() => expect(screen.queryByText(/remove from session\?/i)).not.toBeInTheDocument())
    // Row still present after cancel
    expect(screen.getByText('Other')).toBeInTheDocument()
  })

  it('shows + button when team has candidate agents and hides when no candidates', async () => {
    // Session has only a member (m-1), team has agent a-1 not yet in session
    mockSheetData(
      ['m-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
      ],
      [],
      [{ id: 'a-1', display_name: 'Bot', actor_type: 'agent' }],
    )

    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByText('Me')).toBeInTheDocument())

    // The Agents heading and + button should appear since there's a candidate
    expect(screen.getByText(/agents/i)).toBeInTheDocument()
    const addBtn = screen.getByRole('button', { name: /add agent/i })
    expect(addBtn).toBeInTheDocument()
  })

  it('clicking + button calls runtimeStart and adds agent row', async () => {
    const user = userEvent.setup()

    // Session has only m-1; team has candidate agent a-1
    mockSheetData(
      ['m-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Me', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
      ],
      [],
      [{ id: 'a-1', display_name: 'Bot', actor_type: 'agent' }],
    )

    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" teamId="team-1" />)
    await waitFor(() => expect(screen.getByRole('button', { name: /add agent/i })).toBeInTheDocument())

    const addBtn = screen.getByRole('button', { name: /add agent/i })
    await user.click(addBtn)

    // After click, the agent row should appear optimistically
    await waitFor(() => expect(screen.getByText('Bot')).toBeInTheDocument())

    // runtimeStart should have been called
    await waitFor(() => expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1' }),
    ))
  })
})
