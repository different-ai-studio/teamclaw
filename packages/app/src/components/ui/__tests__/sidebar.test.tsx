import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.filter(Boolean).join(' ') }))

import {
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from '../sidebar'

// Helper component to test the context
function SidebarConsumer() {
  const ctx = useSidebar()
  return <div data-testid="state">{ctx.state}</div>
}

describe('SidebarProvider', () => {
  it('renders children and provides context', () => {
    render(
      <SidebarProvider>
        <SidebarConsumer />
      </SidebarProvider>
    )
    expect(screen.getByTestId('state').textContent).toBe('expanded')
  })

  it('SidebarInset renders children', () => {
    render(
      <SidebarProvider>
        <SidebarInset>
          <span>content</span>
        </SidebarInset>
      </SidebarProvider>
    )
    expect(screen.getByText('content')).toBeTruthy()
  })
})
