import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SidePanelHostGateOverlay } from '../SidePanelHostGateOverlay'

vi.mock('@/hooks/use-side-panel-host-gate', () => ({
  useSidePanelHostGate: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

import { useSidePanelHostGate } from '@/hooks/use-side-panel-host-gate'

const mockedGate = vi.mocked(useSidePanelHostGate)

describe('SidePanelHostGateOverlay', () => {
  it('renders nothing when not blocked', () => {
    mockedGate.mockReturnValue({ gateEnabled: true, blocked: false, url: 'https://ok.com' })
    const { container } = render(<SidePanelHostGateOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows unavailable copy when blocked', () => {
    mockedGate.mockReturnValue({ gateEnabled: true, blocked: true, url: 'https://evil.com' })
    render(<SidePanelHostGateOverlay />)
    expect(screen.getByTestId('side-panel-host-gate-overlay')).toBeInTheDocument()
    expect(screen.getByText('Unavailable on this page')).toBeInTheDocument()
  })
})
