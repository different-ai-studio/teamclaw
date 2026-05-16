import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/amuxd-channels', () => {
  class AmuxdUnreachableError extends Error {
    constructor() {
      super('amuxd unreachable')
      this.name = 'AmuxdUnreachableError'
    }
  }
  return {
    listChannels: vi.fn(),
    saveChannelConfig: vi.fn(),
    reloadChannels: vi.fn(),
    AmuxdUnreachableError,
  }
})

import {
  listChannels,
  saveChannelConfig,
  reloadChannels,
  AmuxdUnreachableError,
} from '@/lib/amuxd-channels'

describe('createWecomActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps amuxd channel status into the WeCom gateway slot on load', async () => {
    vi.mocked(listChannels).mockResolvedValueOnce([
      { platform: 'wecom', enabled: true, connected: true, lastError: null },
    ])

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.loadWecomConfig()

    expect(listChannels).toHaveBeenCalledTimes(1)
    // first set: wecomIsLoading=true, second set: full payload
    const final = set.mock.calls[set.mock.calls.length - 1][0]
    expect(final.wecomGatewayStatus).toEqual({ status: 'connected' })
    expect(final.wecomIsLoading).toBe(false)
  })

  it('saveWecomConfig flips through wrapper + reload', async () => {
    vi.mocked(saveChannelConfig).mockResolvedValue(undefined)
    vi.mocked(reloadChannels).mockResolvedValue(undefined)

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.saveWecomConfig({
      enabled: true,
      botId: 'bot',
      secret: 'sec',
    })

    expect(saveChannelConfig).toHaveBeenCalledWith('wecom', {
      enabled: true,
      botId: 'bot',
      secret: 'sec',
    })
    expect(reloadChannels).toHaveBeenCalled()
  })

  it('surfaces a friendly error when amuxd is unreachable on load', async () => {
    vi.mocked(listChannels).mockRejectedValueOnce(new AmuxdUnreachableError())

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.loadWecomConfig()

    const errorPayload = set.mock.calls.find(
      (c) => (c[0] as { error?: string }).error
    )?.[0] as { error?: string } | undefined
    expect(errorPayload?.error).toMatch(/amuxd not running/i)
  })

  it('toggleWecomEnabled saves disabled config and clears status', async () => {
    vi.mocked(saveChannelConfig).mockResolvedValue(undefined)
    vi.mocked(reloadChannels).mockResolvedValue(undefined)

    const { createWecomActions } = await import('../wecom')
    const set = vi.fn()
    const actions = createWecomActions(set)

    await actions.toggleWecomEnabled(false, {
      enabled: true,
      botId: 'bot',
      secret: 'sec',
    })

    expect(saveChannelConfig).toHaveBeenCalledWith(
      'wecom',
      expect.objectContaining({ enabled: false })
    )
  })
})
