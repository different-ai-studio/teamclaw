import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useMqttReconnectStore,
  isMqttAuthFailure,
  shouldAutoRecoverMqttAfterVisibility,
  MQTT_SLEEP_WAKE_HIDDEN_MS,
  recoverMqttConnection,
  resetMqttReconnectRecovery,
  __resetMqttReconnectForTests,
  __markAuthRecoveryForTests,
} from './mqtt-reconnect'

vi.mock('@/lib/auth/session-store', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}))

describe('useMqttReconnectStore', () => {
  beforeEach(() => {
    __resetMqttReconnectForTests()
  })

  it('bump increments the reconnect nonce', () => {
    useMqttReconnectStore.getState().bump()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)
  })

  it('setError records the latest broker error', () => {
    useMqttReconnectStore.getState().setError('broker refused connection: BadUserNamePassword')
    expect(useMqttReconnectStore.getState().lastError).toBe(
      'broker refused connection: BadUserNamePassword',
    )
  })

  it('bump clears a stale error so the reconnect attempt starts clean', () => {
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().bump()
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setError(null) clears the error after a successful connect', () => {
    useMqttReconnectStore.getState().setError('connection timed out')
    useMqttReconnectStore.getState().setError(null)
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setConnected updates the shared connection state', () => {
    useMqttReconnectStore.getState().setConnected(false)
    expect(useMqttReconnectStore.getState().connected).toBe(false)
    useMqttReconnectStore.getState().setConnected(true)
    expect(useMqttReconnectStore.getState().connected).toBe(true)
  })

  it('setConnected(true) clears a stale error (a successful connect is healthy)', () => {
    useMqttReconnectStore.getState().setError('broker refused connection: BadUserNamePassword')
    useMqttReconnectStore.getState().setConnected(true)
    expect(useMqttReconnectStore.getState().connected).toBe(true)
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setConnected(false) preserves the error so the reason stays visible', () => {
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().setConnected(false)
    expect(useMqttReconnectStore.getState().connected).toBe(false)
    expect(useMqttReconnectStore.getState().lastError).toBe('connection refused')
  })
})

describe('isMqttAuthFailure', () => {
  it('detects CONNACK auth rejection from the desktop client', () => {
    expect(isMqttAuthFailure('broker refused connection: BadUserNamePassword')).toBe(true)
    expect(isMqttAuthFailure('broker refused connection: NotAuthorized')).toBe(true)
  })

  it('detects event-loop auth rejection messages', () => {
    expect(isMqttAuthFailure('Connection refused, return code: `BadUserNamePassword`')).toBe(true)
    expect(isMqttAuthFailure('Connection refused: bad_username_or_password')).toBe(true)
  })

  it('rejects non-auth broker errors and vague strings', () => {
    expect(isMqttAuthFailure('Operation timed out')).toBe(false)
    expect(isMqttAuthFailure('broker refused connection: ServerUnavailable')).toBe(false)
    expect(isMqttAuthFailure('bad username or password')).toBe(false)
  })
})

describe('shouldAutoRecoverMqttAfterVisibility', () => {
  it('treats long hidden duration as sleep/wake', () => {
    expect(
      shouldAutoRecoverMqttAfterVisibility({
        wasDiscarded: false,
        hiddenMs: MQTT_SLEEP_WAKE_HIDDEN_MS,
      }),
    ).toBe(true)
  })

  it('treats discarded documents as sleep/wake', () => {
    expect(
      shouldAutoRecoverMqttAfterVisibility({ wasDiscarded: true, hiddenMs: 0 }),
    ).toBe(true)
  })

  it('skips session refresh on short tab switches', () => {
    expect(
      shouldAutoRecoverMqttAfterVisibility({
        wasDiscarded: false,
        hiddenMs: MQTT_SLEEP_WAKE_HIDDEN_MS - 1,
      }),
    ).toBe(false)
  })
})

describe('recoverMqttConnection', () => {
  beforeEach(async () => {
    __resetMqttReconnectForTests()
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
  })

  it('bypasses automatic recovery cooldown for explicit user retries', async () => {
    __markAuthRecoveryForTests()
    await recoverMqttConnection()
    const { refreshSession } = await import('@/lib/auth/session-store')
    expect(refreshSession).toHaveBeenCalledOnce()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)
  })
})

describe('resetMqttReconnectRecovery', () => {
  beforeEach(async () => {
    __resetMqttReconnectForTests()
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
  })

  it('clears connected, error, and nonce on sign-out', () => {
    useMqttReconnectStore.getState().setConnected(false)
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().bump()
    resetMqttReconnectRecovery()
    expect(useMqttReconnectStore.getState()).toMatchObject({
      nonce: 0,
      connected: null,
      lastError: null,
    })
  })

  it('aborts bump when reset runs during in-flight refresh', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    let resolveRefresh!: () => void
    const refreshDeferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    vi.mocked(refreshSession).mockReturnValue(refreshDeferred)

    const recovery = recoverMqttConnection()
    await Promise.resolve()
    resetMqttReconnectRecovery()
    resolveRefresh()
    await recovery

    expect(useMqttReconnectStore.getState().nonce).toBe(0)
  })
})

describe('useMqttReconnectStore — ensureWired browser path', () => {
  let stateHandler: ((state: 'connecting' | 'connected' | 'disconnected') => void) | null = null
  let errorHandler: ((message: string) => void) | null = null

  beforeEach(async () => {
    stateHandler = null
    errorHandler = null

    // Mock isTauri() => false (jsdom is already non-Tauri, but make it explicit)
    vi.doMock('@/lib/utils', () => ({
      isTauri: () => false,
      cn: (...args: string[]) => args.join(' '),
    }))

    // Mock the browser bridge to capture subscriptions
    vi.doMock('@/lib/mqtt-browser-bridge', () => ({
      subscribeBrowserMqttState: (h: (s: 'connecting' | 'connected' | 'disconnected') => void) => {
        stateHandler = h
        return () => { stateHandler = null }
      },
      subscribeBrowserMqttError: (h: (msg: string) => void) => {
        errorHandler = h
        return () => { errorHandler = null }
      },
    }))

    // Reset store state and _wired flag so ensureWired runs fresh each test
    useMqttReconnectStore.setState({ nonce: 0, lastError: null, connected: null, _wired: false })

    // Clear module cache so dynamic imports pick up the new mocks
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('@/lib/utils')
    vi.doUnmock('@/lib/mqtt-browser-bridge')
  })

  it('ensureWired in browser path subscribes to state and error from bridge', async () => {
    // Re-import fresh module to pick up mocks
    const { useMqttReconnectStore: store } = await import('./mqtt-reconnect')
    store.setState({ _wired: false, connected: null, lastError: null })
    store.getState().ensureWired()

    // Allow async dynamic imports to settle
    await new Promise((r) => setTimeout(r, 20))

    expect(stateHandler).not.toBeNull()
    expect(errorHandler).not.toBeNull()

    // 'disconnected' state -> connected=false
    stateHandler!('disconnected')
    expect(store.getState().connected).toBe(false)

    // 'connected' state -> connected=true
    stateHandler!('connected')
    expect(store.getState().connected).toBe(true)

    // 'connecting' state -> connected=null
    stateHandler!('connecting')
    expect(store.getState().connected).toBeNull()

    // error -> lastError set
    errorHandler!('broker auth failure')
    expect(store.getState().lastError).toBe('broker auth failure')
  })

  it('refreshes credentials and bumps reconnect when a browser MQTT disconnect outlasts the grace window', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
    const { useMqttReconnectStore: store, BROWSER_RECONNECT_GRACE_MS } = await import('./mqtt-reconnect')
    store.setState({ _wired: false, connected: null, lastError: null, nonce: 0 })
    store.getState().ensureWired()
    await new Promise((r) => setTimeout(r, 20))

    vi.useFakeTimers()
    try {
      stateHandler!('disconnected')
      // Inside the grace window mqtt.js auto-reconnect owns recovery.
      await vi.advanceTimersByTimeAsync(BROWSER_RECONNECT_GRACE_MS - 1000)
      expect(refreshSession).not.toHaveBeenCalled()
      // Still down once the grace window elapses -> escalate.
      await vi.advanceTimersByTimeAsync(2000)
    } finally {
      vi.useRealTimers()
    }
    await new Promise((r) => setTimeout(r, 20))

    expect(refreshSession).toHaveBeenCalledOnce()
    expect(store.getState().nonce).toBe(1)
  })

  it('does not refresh credentials when auto-reconnect restores within the grace window', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
    const { useMqttReconnectStore: store, BROWSER_RECONNECT_GRACE_MS } = await import('./mqtt-reconnect')
    store.setState({ _wired: false, connected: null, lastError: null, nonce: 0 })
    store.getState().ensureWired()
    await new Promise((r) => setTimeout(r, 20))

    vi.useFakeTimers()
    try {
      stateHandler!('disconnected')
      await vi.advanceTimersByTimeAsync(3000)
      stateHandler!('connected')
      await vi.advanceTimersByTimeAsync(BROWSER_RECONNECT_GRACE_MS * 2)
    } finally {
      vi.useRealTimers()
    }
    await new Promise((r) => setTimeout(r, 20))

    expect(refreshSession).not.toHaveBeenCalled()
    expect(store.getState().nonce).toBe(0)
  })

  it('refreshes credentials and bumps reconnect on browser MQTT auth failure', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
    const { useMqttReconnectStore: store } = await import('./mqtt-reconnect')
    store.setState({ _wired: false, connected: null, lastError: null, nonce: 0 })
    store.getState().ensureWired()

    await new Promise((r) => setTimeout(r, 20))
    errorHandler!('Connection refused: bad_username_or_password')
    expect(store.getState().lastError).toBe('Connection refused: bad_username_or_password')
    await new Promise((r) => setTimeout(r, 20))

    expect(refreshSession).toHaveBeenCalledOnce()
    expect(store.getState().nonce).toBe(1)
    expect(store.getState().lastError).toBeNull()
  })
})
