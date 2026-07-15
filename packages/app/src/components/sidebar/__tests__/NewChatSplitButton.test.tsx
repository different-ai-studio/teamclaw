import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewChatSplitButton } from '../NewChatSplitButton'

const onPrimaryClick = vi.fn()
const openDialog = vi.fn()

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ openNewSessionDialog: openDialog }),
  },
}))

describe('NewChatSplitButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('primary click delegates to onPrimaryClick when ready', () => {
    render(
      <NewChatSplitButton
        quickChatState={{
          kind: 'ready',
          target: { agentId: 'a1', displayName: 'Bot', source: 'team_default' },
        }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /新聊天/i }))
    expect(onPrimaryClick).toHaveBeenCalled()
  })

  it('disables primary when no default agent is configured', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'no_agent' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    const button = screen.getByRole('button', { name: /新聊天/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title')
  })

  it('disables primary while loading', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'loading' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    expect(screen.getByRole('button', { name: /新聊天/i })).toBeDisabled()
  })

  it('expands inline panel without workspace when team is available', () => {
    render(
      <NewChatSplitButton
        quickChatState={{
          kind: 'ready',
          target: { agentId: 'a1', displayName: 'Bot', source: 'member_default' },
        }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    const wrap = screen.getByTestId('new-chat-more-panel-wrap')
    expect(wrap).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: /更多新建选项/i }))
    expect(wrap).toHaveAttribute('aria-hidden', 'false')
    fireEvent.click(screen.getByRole('button', { name: /多人会话/i }))
    expect(openDialog).toHaveBeenCalled()
    expect(wrap).toHaveAttribute('aria-hidden', 'true')
  })

  it('disables more-options chevron when no team', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'no_team' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    expect(screen.getByRole('button', { name: /更多新建选项/i })).toBeDisabled()
    expect(screen.queryByTestId('new-chat-more-panel-wrap')).not.toBeInTheDocument()
  })
})
