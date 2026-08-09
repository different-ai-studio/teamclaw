import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACP_DEBUG_MAX_LINES,
  isAcpDebugPanelVisible,
  useAcpDebugStore,
} from '../acp-debug-store'

/** Let the queued append flush; the store coalesces on a microtask. */
const flush = () => Promise.resolve()

const line = (topic: string) => ({ topic, eventCase: 'test' })

describe('acp-debug-store', () => {
  beforeEach(() => {
    localStorage.clear()
    useAcpDebugStore.getState().clear()
    useAcpDebugStore.setState({ enabled: false, lines: [] })
  })

  it('defaults to disabled when no preference is stored', () => {
    expect(useAcpDebugStore.getState().enabled).toBe(false)
    expect(isAcpDebugPanelVisible()).toBe(false)
  })

  it('persists enabled state via setEnabled', () => {
    useAcpDebugStore.getState().setEnabled(true)
    expect(useAcpDebugStore.getState().enabled).toBe(true)
    expect(localStorage.getItem('teamclu-acp-stream-debug')).toBe('true')

    useAcpDebugStore.getState().setEnabled(false)
    expect(useAcpDebugStore.getState().enabled).toBe(false)
    expect(localStorage.getItem('teamclu-acp-stream-debug')).toBe('false')
  })

  it('drops appends while disabled', async () => {
    useAcpDebugStore.getState().append(line('amux/t/a/session/s/live'))
    await flush()
    expect(useAcpDebugStore.getState().lines).toHaveLength(0)
  })

  // Regression (Sentry TEAMCLU-REACT-85): a set() per line meant a synchronous
  // React render per live event, and a streaming reply overran React's nested
  // update limit. A burst has to land as one store update, not N.
  it('coalesces a burst of appends into a single store update', async () => {
    useAcpDebugStore.setState({ enabled: true })
    let notifications = 0
    const unsubscribe = useAcpDebugStore.subscribe(() => {
      notifications += 1
    })

    for (let i = 0; i < 60; i += 1) {
      useAcpDebugStore.getState().append(line(`topic/${i}`))
    }
    expect(useAcpDebugStore.getState().lines).toHaveLength(0)

    await flush()
    unsubscribe()

    expect(useAcpDebugStore.getState().lines).toHaveLength(60)
    expect(notifications).toBe(1)
  })

  it('keeps the ring buffer capped when a burst overflows it', async () => {
    useAcpDebugStore.setState({ enabled: true })
    for (let i = 0; i < ACP_DEBUG_MAX_LINES + 25; i += 1) {
      useAcpDebugStore.getState().append(line(`topic/${i}`))
    }
    await flush()

    const { lines } = useAcpDebugStore.getState()
    expect(lines).toHaveLength(ACP_DEBUG_MAX_LINES)
    // The oldest 25 were dropped, so the window starts at 25.
    expect(lines[0]?.topic).toBe('topic/25')
    expect(lines[lines.length - 1]?.topic).toBe(`topic/${ACP_DEBUG_MAX_LINES + 24}`)
  })

  it('clear() discards lines that are queued but not yet flushed', async () => {
    useAcpDebugStore.setState({ enabled: true })
    useAcpDebugStore.getState().append(line('topic/queued'))
    useAcpDebugStore.getState().clear()
    await flush()
    expect(useAcpDebugStore.getState().lines).toHaveLength(0)
  })
})
