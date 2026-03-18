import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenCodeClient } from '../client'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
  }
}

describe('OpenCodeClient', () => {
  let client: OpenCodeClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new OpenCodeClient({ baseUrl: 'http://localhost:13141' })
  })

  it('creates client with baseUrl and exposes API methods', () => {
    expect(client).toBeDefined()
    expect(typeof client.listSessions).toBe('function')
    expect(typeof client.createSession).toBe('function')
    expect(typeof client.sendMessage).toBe('function')
  })

  it('sets workspace path for directory header', () => {
    const c = new OpenCodeClient({
      baseUrl: 'http://localhost:13141',
      workspacePath: '/tmp/proj',
    })
    c.setWorkspacePath('/other')
    expect(c).toBeDefined()
  })

  it('createSession sends POST /session', async () => {
    const session = { id: 'sess-1', title: 'New' }
    mockFetch.mockResolvedValue(jsonResponse(session))

    const result = await client.createSession()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/session'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result).toEqual(session)
  })

  it('listSessions sends GET /session with query params', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]))

    await client.listSessions({ directory: '/work', roots: true })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/session')
    expect(url).toContain('directory=%2Fwork')
    expect(url).toContain('roots=true')
  })

  it('sendMessage sends POST with parts and model', async () => {
    const msg = { info: { id: 'msg-1' }, parts: [] }
    mockFetch.mockResolvedValue(jsonResponse(msg))

    const result = await client.sendMessage(
      'sess-1',
      'Hello',
      { providerID: 'openai', modelID: 'gpt-4' },
    )

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.parts[0]).toEqual({ type: 'text', text: 'Hello' })
    expect(body.model).toEqual({ providerID: 'openai', modelID: 'gpt-4' })
    expect(result).toEqual(msg)
  })

  it('throws descriptive error when server is unreachable', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))

    await expect(client.createSession()).rejects.toThrow(
      'Cannot connect to OpenCode server',
    )
  })

  it('throws on non-JSON response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: () => Promise.resolve({}),
    })

    await expect(client.listSessions()).rejects.toThrow('non-JSON response')
  })

  it('throws on API error response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: false, error: [{ message: 'Bad request' }] }, 400),
    )

    await expect(client.getSession('xyz')).rejects.toThrow('Bad request')
  })

  it('includes authorization header when password is set', async () => {
    const authedClient = new OpenCodeClient({
      baseUrl: 'http://localhost:13141',
      password: 'secret',
    })
    mockFetch.mockResolvedValue(jsonResponse([]))

    await authedClient.listSessions()

    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers.Authorization).toBe('Bearer secret')
  })
})
