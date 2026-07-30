import * as React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { SessionLiquidGlass } from '../SessionLiquidGlass'

function SessionListFixture({ activeSessionId }: { activeSessionId: string }) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  return (
    <div ref={scrollRef} style={{ height: 400, overflow: 'auto' }}>
      <div ref={rootRef} style={{ position: 'relative' }}>
        <SessionLiquidGlass
          rootRef={rootRef}
          scrollRef={scrollRef}
          activeSessionId={activeSessionId}
          layoutKey="test"
        />
        <div data-testid="v2-session-row" data-session-id="pinned-1">
          pinned
        </div>
        <div data-testid="v2-session-row" data-session-id="active-1">
          active
        </div>
      </div>
    </div>
  )
}

describe('SessionLiquidGlass', () => {
  const observe = vi.fn()
  const disconnect = vi.fn()

  beforeEach(() => {
    observe.mockReset()
    disconnect.mockReset()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe
        disconnect = disconnect
        unobserve = vi.fn()
        constructor(_callback: ResizeObserverCallback) {}
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('observes every session row, not only the active one', () => {
    render(<SessionListFixture activeSessionId="active-1" />)
    expect(observe).toHaveBeenCalledTimes(2)
  })
})
