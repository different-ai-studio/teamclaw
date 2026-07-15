import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RuntimeRefreshWorkspaceBanner } from '../RuntimeRefreshBanner'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: { kinds?: string }) => {
      const text = fallback ?? key
      if (opts?.kinds) return text.replace('{{kinds}}', opts.kinds)
      return text
    },
    i18n: { language: 'en' },
  }),
}))

describe('RuntimeRefreshWorkspaceBanner', () => {
  beforeEach(() => {
    useWorkspaceRuntimeRefreshStore.getState().stopPolling()
  })

  it('renders nothing when refresh is clean', () => {
    const { container } = render(<RuntimeRefreshWorkspaceBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows apply action for pending refresh', async () => {
    const applyChanges = vi.fn()
    useWorkspaceRuntimeRefreshStore.setState({
      refresh: {
        status: 'pending',
        change_kinds: ['skills', 'mcp'],
        recommended_action: 'apply_changes',
        auto_apply_blocked_by_active_runtime: true,
        last_detected_at: null,
        last_error: null,
      },
      applyChanges,
    })

    render(<RuntimeRefreshWorkspaceBanner />)

    expect(screen.getByTestId('runtime-refresh-workspace-banner')).toBeInTheDocument()
    expect(screen.getByText(/Pending: skills, MCP/i)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-refresh-apply'))
    expect(applyChanges).toHaveBeenCalled()
  })
})
