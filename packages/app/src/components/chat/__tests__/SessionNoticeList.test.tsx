import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { SessionNoticeList } from '../SessionNoticeList'
import { useSessionNoticeStore } from '@/stores/session-notice-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('SessionNoticeList', () => {
  it('does not infinite-render when mounted with no notices (streaming layout)', () => {
    useSessionNoticeStore.setState({ bySession: {} })
    const renderCount = { n: 0 }

    function Probe() {
      renderCount.n += 1
      return <SessionNoticeList sessionId="session-1" />
    }

    expect(() => render(<Probe />)).not.toThrow()
    expect(renderCount.n).toBeLessThan(20)
  })
})
