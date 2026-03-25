import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import * as React from 'react'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AddMemberInput', () => {
  it('renders input with placeholder', async () => {
    const { AddMemberInput } = await import('../components/settings/AddMemberInput')
    render(React.createElement(AddMemberInput, {
      onAdd: vi.fn(),
    }))

    expect(screen.getByPlaceholderText(/device id/i)).toBeDefined()
  })

  it('Add button is disabled when input is empty', async () => {
    const { AddMemberInput } = await import('../components/settings/AddMemberInput')
    render(React.createElement(AddMemberInput, {
      onAdd: vi.fn(),
    }))

    const addBtn = screen.getByRole('button', { name: /add/i })
    expect(addBtn.hasAttribute('disabled')).toBe(true)
  })

  it('calls onAdd with entered NodeId on submit', async () => {
    const onAdd = vi.fn()
    const { AddMemberInput } = await import('../components/settings/AddMemberInput')
    render(React.createElement(AddMemberInput, { onAdd }))

    const nameInput = screen.getByPlaceholderText(/alice/i)
    fireEvent.change(nameInput, { target: { value: 'Alice' } })

    const idInput = screen.getByPlaceholderText(/device id/i)
    fireEvent.change(idInput, { target: { value: 'new-member-node-id' } })

    const addBtn = screen.getByRole('button', { name: /add/i })
    fireEvent.click(addBtn)

    expect(onAdd).toHaveBeenCalledWith('new-member-node-id', 'Alice', 'editor', '')
  })

  it('shows error state when error prop is set', async () => {
    const { AddMemberInput } = await import('../components/settings/AddMemberInput')
    render(React.createElement(AddMemberInput, {
      onAdd: vi.fn(),
      error: 'Member already exists',
    }))

    expect(screen.getByText('Member already exists')).toBeDefined()
  })
})
