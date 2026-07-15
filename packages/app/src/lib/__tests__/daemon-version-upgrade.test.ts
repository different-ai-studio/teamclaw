import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

describe('ensureBundledAmuxdCurrent', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
  })

  it('installs bundled amuxd when an older installed daemon is detected', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: 'amuxd',
        title: 'Agent daemon (amuxd)',
        optional: false,
        present: false,
        version: '0.2.10',
      },
    ])
    invokeMock.mockResolvedValueOnce(undefined)

    const { ensureBundledAmuxdCurrent } = await import('../daemon-version-upgrade')
    await ensureBundledAmuxdCurrent()

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'setup_list_requirements')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'setup_install', {
      id: 'amuxd',
      opencodeDownloadBase: '',
    })
  })

  it('does not install amuxd when the installed daemon is already current', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: 'amuxd',
        title: 'Agent daemon (amuxd)',
        optional: false,
        present: true,
        version: '0.2.16',
      },
    ])

    const { ensureBundledAmuxdCurrent } = await import('../daemon-version-upgrade')
    await ensureBundledAmuxdCurrent()

    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('leaves first-time missing amuxd to the setup wizard', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: 'amuxd',
        title: 'Agent daemon (amuxd)',
        optional: false,
        present: false,
        version: null,
      },
    ])

    const { ensureBundledAmuxdCurrent } = await import('../daemon-version-upgrade')
    await ensureBundledAmuxdCurrent()

    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
