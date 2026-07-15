import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentChipBar } from '../AgentChipBar'

describe('AgentChipBar', () => {
  it('renders nothing when list is empty', () => {
    const { container } = render(<AgentChipBar agents={[]} onRemove={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
  it('renders one chip per agent and calls onRemove with id', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentChipBar
        agents={[
          { id: 'a-1', displayName: 'Reviewer' },
          { id: 'a-2', displayName: 'Planner' },
        ]}
        onRemove={onRemove}
      />,
    )
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Planner')).toBeInTheDocument()
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    expect(removeButtons).toHaveLength(2)
    await user.click(removeButtons[0])
    expect(onRemove).toHaveBeenCalledWith('a-1')
  })
})
