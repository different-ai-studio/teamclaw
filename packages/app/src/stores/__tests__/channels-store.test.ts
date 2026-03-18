import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/stores/channels/discord', () => ({
  createDiscordActions: () => ({}),
}))

vi.mock('@/stores/channels/feishu', () => ({
  createFeishuActions: () => ({}),
}))

vi.mock('@/stores/channels/email', () => ({
  createEmailActions: () => ({}),
}))

vi.mock('@/stores/channels/kook', () => ({
  createKookActions: () => ({}),
}))

vi.mock('@/stores/channels/wecom', () => ({
  createWecomActions: () => ({}),
}))

vi.mock('@/stores/channels-types', () => ({
  defaultDiscordConfig: { enabled: false, token: '', guildId: '' },
  defaultFeishuConfig: { enabled: false },
  defaultKookConfig: { enabled: false },
  defaultEmailConfig: { enabled: false },
  defaultWeComConfig: { enabled: false },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useChannelsStore', () => {
  it('has correct initial state', async () => {
    const { useChannelsStore } = await import('@/stores/channels-store')
    const state = useChannelsStore.getState()
    expect(state.gatewayStatus.status).toBe('disconnected')
    expect(state.feishuGatewayStatus.status).toBe('disconnected')
    expect(state.isLoading).toBe(false)
    expect(state.hasChanges).toBe(false)
  })

  it('stopAllAndReset resets all state', async () => {
    const { useChannelsStore } = await import('@/stores/channels-store')
    await useChannelsStore.getState().stopAllAndReset()
    const state = useChannelsStore.getState()
    expect(state.discord).toBeNull()
    expect(state.feishu).toBeNull()
    expect(state.email).toBeNull()
    expect(state.kook).toBeNull()
    expect(state.wecom).toBeNull()
    expect(state.gatewayStatus.status).toBe('disconnected')
  })

  it('keepAliveCheck calls invoke for all gateway statuses', async () => {
    mockInvoke.mockResolvedValue({ status: 'disconnected' })
    const { useChannelsStore } = await import('@/stores/channels-store')
    await useChannelsStore.getState().keepAliveCheck()
    // Should have called get_gateway_status for each channel type
    expect(mockInvoke).toHaveBeenCalled()
  })
})
