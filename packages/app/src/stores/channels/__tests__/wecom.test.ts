import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/tmp/test-workspace' }),
  },
}))

describe('createWecomActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes workspacePath when loading config and status', async () => {
    mockInvoke
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'disconnected' })

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.loadWecomConfig()

    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'get_wecom_config', {
      workspacePath: '/tmp/test-workspace',
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'get_wecom_gateway_status', {
      workspacePath: '/tmp/test-workspace',
    })
  })

  it('passes workspacePath when starting and stopping the gateway', async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: 'connected' })
      .mockResolvedValueOnce(undefined)

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.startWecomGateway()
    await actions.stopWecomGateway()

    expect(mockInvoke).toHaveBeenCalledWith('start_wecom_gateway', {
      workspacePath: '/tmp/test-workspace',
    })
    expect(mockInvoke).toHaveBeenCalledWith('get_wecom_gateway_status', {
      workspacePath: '/tmp/test-workspace',
    })
    expect(mockInvoke).toHaveBeenCalledWith('stop_wecom_gateway', {
      workspacePath: '/tmp/test-workspace',
    })
  })
})
