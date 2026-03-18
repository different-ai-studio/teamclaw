import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import * as React from 'react'

// Mock clipboard
const writeText = vi.fn().mockResolvedValue(undefined)
Object.assign(navigator, { clipboard: { writeText } })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DeviceIdDisplay', () => {
  it('renders truncated NodeId', async () => {
    const { DeviceIdDisplay } = await import('../components/settings/DeviceIdDisplay')
    render(React.createElement(DeviceIdDisplay, {
      nodeId: 'abcdefgh12345678ijklmnop',
    }))

    // Should show truncated version (first 8 + ... + last 8)
    expect(screen.getByText(/abcdefgh/)).toBeDefined()
    expect(screen.getByText(/ijklmnop/)).toBeDefined()
  })

  it('copies full NodeId to clipboard on button click', async () => {
    const fullNodeId = 'abcdefgh12345678ijklmnop90qrstuv'
    const { DeviceIdDisplay } = await import('../components/settings/DeviceIdDisplay')
    render(React.createElement(DeviceIdDisplay, { nodeId: fullNodeId }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    })

    expect(writeText).toHaveBeenCalledWith(fullNodeId)
  })

  it('shows "Copied" feedback after click', async () => {
    const { DeviceIdDisplay } = await import('../components/settings/DeviceIdDisplay')
    render(React.createElement(DeviceIdDisplay, { nodeId: 'test-node-id' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    })

    expect(screen.getByText(/copied/i)).toBeDefined()
  })
})
