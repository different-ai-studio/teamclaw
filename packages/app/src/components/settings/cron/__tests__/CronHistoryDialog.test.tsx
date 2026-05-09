import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: Array<string | false | null | undefined>) => args.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/test/workspace' }),
  },
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ switchToSession: vi.fn() }),
  },
}))

import { RunRecordCard } from '../CronHistoryDialog'

describe('RunRecordCard', () => {
  it('shows the last heartbeat for running runs', () => {
    render(
      <RunRecordCard
        run={{
          runId: 'run-1',
          jobId: 'job-1',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          lastHeartbeatAt: new Date(Date.now() - 30_000).toISOString(),
          status: 'running',
        }}
      />,
    )

    expect(screen.getByText(/Last heartbeat:/)).toBeTruthy()
  })

  it('shows the last heartbeat for stale runs', () => {
    render(
      <RunRecordCard
        run={{
          runId: 'run-1',
          jobId: 'job-1',
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          finishedAt: new Date(Date.now() - 10_000).toISOString(),
          lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
          status: 'stale',
          error: 'Cron run was interrupted before completion.',
        }}
      />,
    )

    expect(screen.getByText(/Last heartbeat:/)).toBeTruthy()
  })
})
