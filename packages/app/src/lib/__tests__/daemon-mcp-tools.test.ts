import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'get_daemon_http_info') {
      return { base_url: 'http://127.0.0.1:9999', root_token: 'root' }
    }
    return null
  }),
}))

import { getDaemonMcpTools, invalidateDaemonConnection } from '../daemon-local-client'

beforeEach(() => {
  invalidateDaemonConnection()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.endsWith('/v1/auth/exchange')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'sess-123', expires_in: 3600 }),
        } as unknown as Response
      }
      if (u.includes('/mcp/tools')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            servers: {
              playwright: {
                probe_status: 'ready',
                tools: ['browser_click'],
                error: null,
                probed_at: '2026-06-05T00:00:00Z',
              },
            },
          }),
        } as unknown as Response
      }
      throw new Error(`unexpected fetch ${u}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getDaemonMcpTools', () => {
  it('returns per-server probe payload', async () => {
    const result = await getDaemonMcpTools('ws-id')
    expect(result.playwright.probe_status).toBe('ready')
    expect(result.playwright.tools).toEqual(['browser_click'])
  })

  it('appends refresh query when requested', async () => {
    await getDaemonMcpTools('ws-id', { refresh: true })
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c) => String(c[0]).includes('/mcp/tools?refresh=1'))).toBe(true)
  })
})
