import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('@sentry/react', () => ({
  captureMessage: (...args: unknown[]) => mocks.captureMessage(...args),
  captureException: (...args: unknown[]) => mocks.captureException(...args),
}))

import {
  __resetRuntimeErrorReportThrottleForTest,
  __resetSentryModuleForTest,
  classifyRuntimeFailureReason,
  isCancelledRuntimeFailure,
  isTransientRuntimeNetworkFailure,
  reportRuntimeEnsureCrash,
  reportRuntimeRpcNotReady,
  reportRuntimeStartFailure,
} from '@/lib/telemetry/runtime-error-report'

/** The capture path is a dynamic import — let it resolve before asserting. */
async function flush(): Promise<void> {
  await import('@sentry/react')
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let now = 1_700_000_000_000

beforeEach(() => {
  __resetRuntimeErrorReportThrottleForTest()
  __resetSentryModuleForTest()
  mocks.captureMessage.mockClear()
  mocks.captureException.mockClear()
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('classifyRuntimeFailureReason', () => {
  it('separates the timeouts that all arrive as runtime_rpc_failed', () => {
    expect(classifyRuntimeFailureReason('rpc timeout after 20000ms')).toBe('rpc_timeout')
    expect(classifyRuntimeFailureReason('local rpc timeout after 10000ms')).toBe(
      'local_rpc_timeout',
    )
    expect(classifyRuntimeFailureReason('teamclu-rpc not initialized')).toBe(
      'rpc_not_initialized',
    )
    expect(classifyRuntimeFailureReason('teamclu-rpc: targetActorId required')).toBe(
      'rpc_not_initialized',
    )
    expect(classifyRuntimeFailureReason('mqtt disconnected')).toBe('mqtt_disconnected')
    expect(classifyRuntimeFailureReason('device offline')).toBe('device_offline')
    expect(classifyRuntimeFailureReason('runtimeStart rejected')).toBe('daemon_rejected')
    expect(classifyRuntimeFailureReason('')).toBe('unknown')
    expect(classifyRuntimeFailureReason(undefined)).toBe('unknown')
  })

  it('names the cancellation that disposeTeamcluRpc raises', () => {
    // Verbatim from `disposeTeamcluRpc()`. Landed in `unknown` before, which
    // made the startup race indistinguishable from a real daemon failure.
    expect(classifyRuntimeFailureReason('rpc disposed')).toBe('rpc_disposed')
    expect(isCancelledRuntimeFailure('rpc disposed')).toBe(true)
  })

  it('does not treat a genuine rpc failure as a cancellation', () => {
    expect(isCancelledRuntimeFailure('rpc timeout after 20000ms')).toBe(false)
    expect(isCancelledRuntimeFailure('runtimeStart rejected')).toBe(false)
    expect(isCancelledRuntimeFailure(undefined)).toBe(false)
  })

  it('classifies transient Cloud API transport failures separately from auth rejection', () => {
    const sendFailed =
      'fetch_session_with_participants failed: cloud_api provider error: None: error sending request for url (https://api.teamclu-dev.ucar.cc/v1/auth/refresh)'
    const refreshTimedOut =
      'fetch_session_with_participants failed: cloud_api provider error: None: token refresh timed out'

    expect(classifyRuntimeFailureReason(sendFailed)).toBe('cloud_network_error')
    expect(classifyRuntimeFailureReason(refreshTimedOut)).toBe('cloud_network_error')
    expect(isTransientRuntimeNetworkFailure(sendFailed)).toBe(true)
    expect(isTransientRuntimeNetworkFailure(refreshTimedOut)).toBe(true)
    expect(isTransientRuntimeNetworkFailure('auth error: invalid_grant')).toBe(false)
    expect(isTransientRuntimeNetworkFailure('not found: session not found')).toBe(false)
  })
})

describe('reportRuntimeStartFailure', () => {
  it('keeps ids out of the message and fingerprints on (kind, code, reasonKind)', async () => {
    reportRuntimeStartFailure(
      {
        agentActorId: '8e822115-2e7c-4f92-97fe-a49b24f53a15',
        code: 'runtime_rpc_failed',
        reason: 'rpc timeout after 20000ms',
      },
      { sessionId: 'sess-1', teamId: 'team-1', trigger: 'send' },
    )
    await flush()

    expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.captureMessage.mock.calls[0] as [
      string,
      Record<string, never>,
    ]
    expect(message).toBe('runtime_start_failure: runtime_rpc_failed')
    expect(message).not.toContain('8e822115')
    expect(message).not.toContain('20000')
    expect(options).toMatchObject({
      level: 'error',
      fingerprint: ['runtime', 'runtime_start_failure', 'runtime_rpc_failed', 'rpc_timeout'],
      tags: {
        runtime_error_kind: 'runtime_start_failure',
        runtime_failure_code: 'runtime_rpc_failed',
        runtime_failure_reason_kind: 'rpc_timeout',
      },
      extra: {
        reason: 'rpc timeout after 20000ms',
        sessionId: 'sess-1',
        teamId: 'team-1',
        agentActorId: '8e822115-2e7c-4f92-97fe-a49b24f53a15',
        trigger: 'send',
      },
    })
  })

  it('downgrades expected offline states to warning', async () => {
    reportRuntimeStartFailure({
      agentActorId: 'agent-1',
      code: 'device_offline',
      reason: 'device offline',
    })
    reportRuntimeStartFailure({
      agentActorId: 'agent-2',
      code: 'transport_offline',
      reason: 'mqtt disconnected',
    })
    await flush()

    expect(mocks.captureMessage).toHaveBeenCalledTimes(2)
    for (const call of mocks.captureMessage.mock.calls) {
      expect((call[1] as { level: string }).level).toBe('warning')
    }
  })

  it('downgrades a cancellation that arrives as a plain runtime_rpc_failed', async () => {
    reportRuntimeStartFailure({
      agentActorId: 'agent-1',
      code: 'runtime_rpc_failed',
      reason: 'rpc disposed',
    })
    await flush()

    expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
    const [, options] = mocks.captureMessage.mock.calls[0] as [string, Record<string, never>]
    expect(options).toMatchObject({
      level: 'warning',
      fingerprint: ['runtime', 'runtime_start_failure', 'runtime_rpc_failed', 'rpc_disposed'],
      tags: { runtime_failure_reason_kind: 'rpc_disposed' },
    })
  })

  it('downgrades a transient Cloud API network failure to warning', async () => {
    reportRuntimeStartFailure({
      agentActorId: 'agent-1',
      code: 'runtime_rpc_failed',
      reason:
        'fetch_session_with_participants failed: cloud_api provider error: None: error sending request for url (https://api.teamclu-dev.ucar.cc/v1/auth/refresh)',
    })
    await flush()

    expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
    const [, options] = mocks.captureMessage.mock.calls[0] as [string, Record<string, never>]
    expect(options).toMatchObject({
      level: 'warning',
      fingerprint: [
        'runtime',
        'runtime_start_failure',
        'runtime_rpc_failed',
        'cloud_network_error',
      ],
      tags: { runtime_failure_reason_kind: 'cloud_network_error' },
    })
  })

  it('keeps a real rpc failure at error level', async () => {
    reportRuntimeStartFailure({
      agentActorId: 'agent-1',
      code: 'runtime_rpc_failed',
      reason: 'rpc timeout after 20000ms',
    })
    await flush()
    expect((mocks.captureMessage.mock.calls[0]?.[1] as { level: string }).level).toBe('error')
  })

  it('throttles the same (code, agent) within the window but not after it', async () => {
    const failure = {
      agentActorId: 'agent-1',
      code: 'device_offline' as const,
      reason: 'device offline',
    }
    reportRuntimeStartFailure(failure)
    reportRuntimeStartFailure(failure)
    reportRuntimeStartFailure(failure)
    await flush()
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1)

    now += 60_001
    reportRuntimeStartFailure(failure)
    await flush()
    expect(mocks.captureMessage).toHaveBeenCalledTimes(2)
  })

  it('does not throttle a different agent with the same code', async () => {
    reportRuntimeStartFailure({
      agentActorId: 'agent-1',
      code: 'device_offline',
      reason: 'device offline',
    })
    reportRuntimeStartFailure({
      agentActorId: 'agent-2',
      code: 'device_offline',
      reason: 'device offline',
    })
    await flush()
    expect(mocks.captureMessage).toHaveBeenCalledTimes(2)
  })
})

describe('reportRuntimeRpcNotReady', () => {
  it('reports once per session within the window', async () => {
    reportRuntimeRpcNotReady(20_000, { sessionId: 'sess-1' })
    reportRuntimeRpcNotReady(20_000, { sessionId: 'sess-1' })
    reportRuntimeRpcNotReady(20_000, { sessionId: 'sess-2' })
    await flush()

    expect(mocks.captureMessage).toHaveBeenCalledTimes(2)
    expect(mocks.captureMessage.mock.calls[0]?.[0]).toBe('rpc_not_ready: unknown')
  })
})

describe('reportRuntimeEnsureCrash', () => {
  it('captures the exception with the runtime fingerprint', async () => {
    const error = new Error('rpc timeout after 20000ms')
    reportRuntimeEnsureCrash(error, { sessionId: 'sess-1', trigger: 'set_model' })
    await flush()

    expect(mocks.captureException).toHaveBeenCalledTimes(1)
    const [captured, options] = mocks.captureException.mock.calls[0] as [
      Error,
      Record<string, never>,
    ]
    expect(captured).toBe(error)
    expect(options).toMatchObject({
      level: 'error',
      fingerprint: ['runtime', 'ensure_runtime_crash', 'none', 'rpc_timeout'],
      tags: { runtime_failure_reason_kind: 'rpc_timeout' },
    })
  })

  it('separates crashes by trigger so set_model is not swallowed by ensure', async () => {
    const error = new Error('rpc timeout after 20000ms')
    reportRuntimeEnsureCrash(error, { sessionId: 'sess-1', trigger: 'send' })
    reportRuntimeEnsureCrash(error, { sessionId: 'sess-1', trigger: 'set_model' })
    await flush()

    expect(mocks.captureException).toHaveBeenCalledTimes(2)
  })
})
