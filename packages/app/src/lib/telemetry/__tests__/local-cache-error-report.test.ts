import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  setLocalCacheTeamGate: vi.fn(),
  currentTeam: { id: 'team-1' } as { id: string } | null,
}))

vi.mock('@sentry/react', () => ({
  captureMessage: (...args: unknown[]) => mocks.captureMessage(...args),
  captureException: (...args: unknown[]) => mocks.captureException(...args),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: mocks.currentTeam }) },
  setLocalCacheTeamGate: (...args: unknown[]) => mocks.setLocalCacheTeamGate(...args),
}))

import {
  __resetSentryModuleForTest,
  __resetTelemetryThrottleForTest,
} from '@/lib/telemetry/capture'
import {
  classifyLocalCacheFailure,
  reportLocalCacheEmptyTeamId,
  reportLocalCacheFailure,
} from '@/lib/telemetry/local-cache-error-report'

async function flush(): Promise<void> {
  await import('@sentry/react')
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  __resetTelemetryThrottleForTest()
  __resetSentryModuleForTest()
  mocks.captureMessage.mockClear()
  mocks.setLocalCacheTeamGate.mockClear()
  mocks.currentTeam = { id: 'team-1' }
})

describe('classifyLocalCacheFailure', () => {
  it('matches the codes emitted by local_cache/commands.rs', () => {
    expect(
      classifyLocalCacheFailure(
        'local_cache: team_gate_mismatch (session: current=team-2, found=team-1)',
      ),
    ).toBe('team_gate_mismatch')
    expect(classifyLocalCacheFailure('local_cache: empty_team_id (requested)')).toBe(
      'empty_team_id',
    )
    expect(classifyLocalCacheFailure('db is locked')).toBe('unknown')
    expect(classifyLocalCacheFailure(undefined)).toBe('unknown')
  })

  it('does not confuse the empty-team-id code with a real gate mismatch', () => {
    // These used to arrive as the same prose string, which sent the
    // investigation after a team-state divergence that was not happening.
    const gate = classifyLocalCacheFailure('local_cache: team_gate_mismatch (row: ...)')
    const empty = classifyLocalCacheFailure('local_cache: empty_team_id (requested)')
    expect(gate).not.toBe(empty)
  })
})

describe('reportLocalCacheFailure', () => {
  it('reports at warning level with ids kept out of the message', async () => {
    const error = new Error(
      'local_cache: team_gate_mismatch (session: current=team-2, found=team-1)',
    )
    reportLocalCacheFailure('session_load_team', error, { teamId: 'team-1' })
    await flush()

    const [message, options] = mocks.captureMessage.mock.calls[0] as [
      string,
      Record<string, never>,
    ]
    expect(message).toBe('local_cache_failed: session_load_team (team_gate_mismatch)')
    expect(message).not.toContain('team-1')
    expect(options).toMatchObject({
      level: 'warning',
      fingerprint: ['local_cache', 'session_load_team', 'team_gate_mismatch'],
      extra: { teamId: 'team-1' },
    })
  })

  it('re-pins the local-cache gate to the current team after a mismatch', async () => {
    reportLocalCacheFailure('session_load_team', new Error('local_cache: team_gate_mismatch (x)'))
    await flush()
    expect(mocks.setLocalCacheTeamGate).toHaveBeenCalledWith('team-1')
  })

  it('does not touch the gate for unrelated failures', async () => {
    reportLocalCacheFailure('session_load_team', new Error('db is locked'))
    await flush()
    expect(mocks.setLocalCacheTeamGate).not.toHaveBeenCalled()
  })

  it('throttles repeats of the same (command, kind)', async () => {
    const error = new Error('local_cache: team_gate_mismatch (x)')
    reportLocalCacheFailure('session_load_team', error)
    reportLocalCacheFailure('session_load_team', error)
    await flush()
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
  })
})

describe('reportLocalCacheEmptyTeamId', () => {
  it('captures the call site, which is the only clue to the offending caller', async () => {
    reportLocalCacheEmptyTeamId('session_load_team')
    await flush()

    const [message, options] = mocks.captureMessage.mock.calls[0] as [
      string,
      { extra: { callSite: string }; fingerprint: string[] },
    ]
    expect(message).toBe('local_cache_empty_team_id: session_load_team')
    expect(options.fingerprint).toEqual(['local_cache', 'session_load_team', 'empty_team_id'])
    expect(options.extra.callSite).toContain('local_cache empty team id')
  })
})
