import { beforeEach, describe, expect, it } from 'vitest'
import { isAcpDebugPanelVisible, useAcpDebugStore } from '../acp-debug-store'

describe('acp-debug-store', () => {
  beforeEach(() => {
    localStorage.clear()
    useAcpDebugStore.setState({ enabled: false, lines: [] })
  })

  it('defaults to disabled when no preference is stored', () => {
    expect(useAcpDebugStore.getState().enabled).toBe(false)
    expect(isAcpDebugPanelVisible()).toBe(false)
  })

  it('persists enabled state via setEnabled', () => {
    useAcpDebugStore.getState().setEnabled(true)
    expect(useAcpDebugStore.getState().enabled).toBe(true)
    expect(localStorage.getItem('teamclaw-acp-stream-debug')).toBe('true')

    useAcpDebugStore.getState().setEnabled(false)
    expect(useAcpDebugStore.getState().enabled).toBe(false)
    expect(localStorage.getItem('teamclaw-acp-stream-debug')).toBe('false')
  })
})
