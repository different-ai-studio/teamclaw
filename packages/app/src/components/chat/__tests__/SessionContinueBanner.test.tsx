import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionContinueBanner } from '@/components/chat/SessionContinueBanner'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string, vars?: Record<string, unknown>) => {
      let out = defaultValue ?? _key
      for (const [k, v] of Object.entries(vars ?? {})) out = out.replace(`{{${k}}}`, String(v))
      return out
    },
  }),
}))

// Radix's popover keeps its content unmounted until opened and portals it out of
// the tree; this test is about which rows survive the filter, so render both
// halves inline instead.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const listSessionIdsForActor = vi.fn()
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ sessionMembers: { listSessionIdsForActor } }),
}))

let rows: any[] = []
vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: (sel: (s: any) => unknown) => sel({ rows }),
}))

let cronSessionIds = new Set<string>()
vi.mock('@/stores/cron', () => ({
  useCronStore: (sel: (s: any) => unknown) => sel({ cronSessionIds }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: { getState: () => ({ switchToSession: vi.fn() }) },
}))

function row(id: string, title: string, source: string | null) {
  return {
    id,
    title,
    team_id: 't1',
    last_message_at: null,
    last_message_preview: null,
    mode: 'solo',
    idea_id: null,
    has_unread: false,
    source,
    cron_job_id: source === 'cron' ? 'job-1' : null,
    created_at: null,
    updated_at: null,
  }
}

function renderBanner() {
  return render(<SessionContinueBanner actorId="actor-1" actorName="MACPRO" variant="inline" />)
}

describe('SessionContinueBanner', () => {
  it('hides scheduled sessions and counts only what it lists', async () => {
    cronSessionIds = new Set()
    rows = [row('s1', 'Real chat', 'user'), row('c1', 'Cron: test', 'cron'), row('c2', 'Cron: test', 'cron')]
    listSessionIdsForActor.mockResolvedValue(['s1', 'c1', 'c2'])

    renderBanner()

    expect(await screen.findByText('Real chat')).toBeInTheDocument()
    expect(screen.queryByText('Cron: test')).not.toBeInTheDocument()
    // The trigger count is derived from the same filtered array, so a popover
    // showing one row must never advertise three.
    expect(screen.getByText('继续 ×1')).toBeInTheDocument()
  })

  it('also hides a just-created cron session whose row has not synced source yet', async () => {
    // `source` arrives from the server; until it does, the device-local overlay
    // is the only signal, which is why the shared predicate checks both.
    cronSessionIds = new Set(['c1'])
    rows = [row('s1', 'Real chat', 'user'), row('c1', 'Cron: test', null)]
    listSessionIdsForActor.mockResolvedValue(['s1', 'c1'])

    renderBanner()

    expect(await screen.findByText('Real chat')).toBeInTheDocument()
    expect(screen.queryByText('Cron: test')).not.toBeInTheDocument()
  })

  it('renders nothing when every match is scheduled', async () => {
    cronSessionIds = new Set()
    rows = [row('c1', 'Cron: test', 'cron')]
    listSessionIdsForActor.mockResolvedValue(['c1'])

    const { container } = renderBanner()

    await waitFor(() => expect(listSessionIdsForActor).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
