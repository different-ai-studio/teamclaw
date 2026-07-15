import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: vi.fn(async () => 'test-token'),
}))

import { TeamLiteLlmSection } from '../TeamLiteLlmSection'

describe('TeamLiteLlmSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('owner sees "开通 LiteLLM" button and successful setup shows endpoint', async () => {
    mockInvoke.mockResolvedValue({
      aiGatewayEndpoint: 'https://gw.example.com/v1',
      litellmKey: 'sk-xxx',
    })

    render(
      <TeamLiteLlmSection
        teamId="team-1"
        workspacePath="/workspace"
        isOwner={true}
      />,
    )

    expect(screen.getByText(/团队 LiteLLM 未开通/)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /开通 LiteLLM/ })

    fireEvent.click(btn)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_litellm_setup', {
        teamId: 'team-1',
        workspacePath: '/workspace',
        accessToken: 'test-token',
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/已开通/)).toBeTruthy()
      expect(screen.getByText(/https:\/\/gw\.example\.com\/v1/)).toBeTruthy()
    })
  })

  it('non-owner sees read-only "团队 LiteLLM 未开通" without action button', () => {
    render(
      <TeamLiteLlmSection
        teamId="team-1"
        workspacePath="/workspace"
        isOwner={false}
      />,
    )

    expect(screen.getByText(/团队 LiteLLM 未开通/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /开通 LiteLLM/ })).toBeNull()
  })

  it('shows error message and re-enables button on invoke failure', async () => {
    mockInvoke.mockRejectedValue('something went wrong')

    render(
      <TeamLiteLlmSection
        teamId="team-1"
        workspacePath="/workspace"
        isOwner={true}
      />,
    )

    const btn = screen.getByRole('button', { name: /开通 LiteLLM/ }) as HTMLButtonElement
    fireEvent.click(btn)

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/)).toBeTruthy()
    })
    expect(btn.disabled).toBe(false)
  })
})
