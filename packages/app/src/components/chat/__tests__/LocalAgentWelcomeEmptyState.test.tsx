import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { LocalAgentWelcomeEmptyState } from '@/components/chat/LocalAgentWelcomeEmptyState'
import { useUIStore } from '@/stores/ui'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}))

vi.mock('@/components/chat/SessionContinueBanner', () => ({
  SessionContinueBanner: () => null,
}))

const agent = { id: 'agent-1', displayName: 'MACPRO' }

describe('LocalAgentWelcomeEmptyState', () => {
  beforeEach(() => {
    useUIStore.setState({ embedMode: false })
  })

  it('renders desktop welcome with agent name when not in embed mode', () => {
    render(
      <LocalAgentWelcomeEmptyState
        agent={agent}
        onStartConversation={() => {}}
        onQuickAction={() => {}}
        onOpenAgentSettings={() => {}}
      />,
    )

    expect(screen.getByText('MACPRO')).toBeInTheDocument()
    expect(screen.getByText('New Chat')).toBeInTheDocument()
    expect(screen.queryByText('Ready when you are')).not.toBeInTheDocument()
  })

  it('renders extension welcome without agent name when embed mode is on', () => {
    useUIStore.setState({ embedMode: true })

    render(
      <LocalAgentWelcomeEmptyState
        agent={agent}
        onStartConversation={() => {}}
        onQuickAction={() => {}}
        onOpenAgentSettings={() => {}}
      />,
    )

    expect(screen.queryByText('MACPRO')).not.toBeInTheDocument()
    expect(screen.getByText('随时可以开始')).toBeInTheDocument()
    expect(screen.getByText('New Chat')).toBeInTheDocument()
    expect(screen.getByText('● online')).toBeInTheDocument()
    expect(screen.queryByText(/local/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/resume/i)).not.toBeInTheDocument()
  })
})
