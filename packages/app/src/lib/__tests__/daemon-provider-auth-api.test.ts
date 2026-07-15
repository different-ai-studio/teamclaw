import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({
    base_url: 'http://127.0.0.1:19999',
    root_token: 'root',
  }),
}))

describe('daemon OAuth API client', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.endsWith('/v1/auth/exchange')) {
          return new Response(JSON.stringify({ token: 'sess', expires_in: 3600 }), { status: 200 })
        }
        if (url.includes('/oauth/authorize')) {
          return new Response(
            JSON.stringify({
              code: 'not_implemented',
              detail: 'provider OAuth authorize is not available yet (phase 2)',
              status: 501,
              title: 'Not implemented',
            }),
            { status: 501, headers: { 'Content-Type': 'application/problem+json' } },
          )
        }
        if (url.includes('/provider-auth-methods')) {
          return new Response(JSON.stringify({ openai: [{ type: 'oauth', label: 'Browser login' }] }), {
            status: 200,
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )
  })

  it('loads provider auth methods from daemon HTTP', async () => {
    const { getDaemonProviderAuthMethods, invalidateDaemonConnection } = await import(
      '../daemon-local-client'
    )
    invalidateDaemonConnection()
    const methods = await getDaemonProviderAuthMethods('d29ya3NwYWNl')
    expect(methods?.openai).toEqual([{ type: 'oauth', label: 'Browser login' }])
  })

  it('maps 501 authorize response to not_implemented', async () => {
    const { postDaemonProviderOAuthAuthorize, invalidateDaemonConnection } = await import(
      '../daemon-local-client'
    )
    invalidateDaemonConnection()
    const result = await postDaemonProviderOAuthAuthorize('d29ya3NwYWNl', 'openai', 0)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(501)
      expect(result.code).toBe('not_implemented')
    }
  })
})
