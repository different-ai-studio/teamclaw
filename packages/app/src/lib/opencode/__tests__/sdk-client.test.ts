import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
  sessionList: vi.fn(),
  sessionUpdate: vi.fn(),
  experimentalSessionList: vi.fn(),
  syncHistoryList: vi.fn(),
  syncReplay: vi.fn(),
  requestInterceptorUse: vi.fn(),
}))

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: mocks.createOpencodeClient,
}))

import { initOpenCodeClient, listSessions, restoreSession } from '@/lib/opencode/sdk-client'

describe('sdk-client session wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createOpencodeClient.mockReturnValue({
      client: {
        interceptors: {
          request: {
            use: mocks.requestInterceptorUse,
          },
        },
      },
      session: {
        list: mocks.sessionList,
        update: mocks.sessionUpdate,
      },
      experimental: {
        session: {
          list: mocks.experimentalSessionList,
        },
      },
      sync: {
        history: {
          list: mocks.syncHistoryList,
        },
        replay: mocks.syncReplay,
      },
    })
    mocks.sessionList.mockResolvedValue({ data: [], error: undefined })
    mocks.sessionUpdate.mockResolvedValue({ data: {}, error: undefined })
    mocks.experimentalSessionList.mockResolvedValue({ data: [], error: undefined })
    mocks.syncHistoryList.mockResolvedValue({ data: [], error: undefined })
    mocks.syncReplay.mockResolvedValue({ data: { sessionID: 'archived-1' }, error: undefined })
    initOpenCodeClient({ baseUrl: 'http://localhost:4096', workspacePath: '/workspace' })
  })

  it('uses the normal session list endpoint when no archived filter is requested', async () => {
    await listSessions({ roots: true })

    expect(mocks.sessionList).toHaveBeenCalledWith({
      directory: '/workspace',
      roots: true,
    })
    expect(mocks.experimentalSessionList).not.toHaveBeenCalled()
  })

  it('uses the experimental session list endpoint when archived sessions are requested', async () => {
    await listSessions({ directory: '/workspace-a', roots: true, archived: true })

    expect(mocks.experimentalSessionList).toHaveBeenCalledWith({
      directory: '/workspace-a',
      roots: true,
      archived: true,
    })
    expect(mocks.sessionList).not.toHaveBeenCalled()
  })

  it('restores an archived session by replaying a sync event that clears the archived time', async () => {
    mocks.syncHistoryList.mockResolvedValue({
      data: [
        { id: 'event-0', aggregate_id: 'other-session', seq: 4, type: 'session.updated.1', data: {} },
        { id: 'event-1', aggregate_id: 'archived-1', seq: 0, type: 'session.created.1', data: {} },
        { id: 'event-2', aggregate_id: 'archived-1', seq: 1, type: 'session.updated.1', data: {} },
      ],
      error: undefined,
    })

    await restoreSession('archived-1', '/workspace-a')

    expect(mocks.syncHistoryList).toHaveBeenCalledWith({
      directory: '/workspace-a',
      body: {},
    })
    expect(mocks.syncReplay).toHaveBeenCalledWith({
      query_directory: '/workspace-a',
      body_directory: '/workspace-a',
      events: [
        expect.objectContaining({
          aggregateID: 'archived-1',
          seq: 2,
          type: 'session.updated.1',
          data: {
            sessionID: 'archived-1',
            info: {
              time: {
                archived: null,
              },
            },
          },
        }),
      ],
    })
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
  })

  it('restores an archived session using the configured workspace when no directory is passed', async () => {
    await restoreSession('archived-1')

    expect(mocks.syncHistoryList).toHaveBeenCalledWith({
      directory: '/workspace',
      body: {},
    })
    expect(mocks.syncReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        query_directory: '/workspace',
        body_directory: '/workspace',
      }),
    )
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects restore before contacting OpenCode when no workspace directory is available', async () => {
    initOpenCodeClient({ baseUrl: 'http://localhost:4096' })

    await expect(restoreSession('archived-1')).rejects.toThrow(
      'Cannot restore an archived session without a workspace directory.',
    )
    expect(mocks.syncHistoryList).not.toHaveBeenCalled()
    expect(mocks.syncReplay).not.toHaveBeenCalled()
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
  })

  it('does not replay restore when loading sync history fails', async () => {
    mocks.syncHistoryList.mockResolvedValue({
      data: undefined,
      error: { message: 'history unavailable' },
    })

    await expect(restoreSession('archived-1', '/workspace-a')).rejects.toThrow(
      'OpenCode API Error: history unavailable',
    )
    expect(mocks.syncReplay).not.toHaveBeenCalled()
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
  })

  it('surfaces replay errors when OpenCode refuses the restore event', async () => {
    mocks.syncReplay.mockResolvedValue({
      data: undefined,
      error: { message: 'Sequence mismatch' },
    })

    await expect(restoreSession('archived-1', '/workspace-a')).rejects.toThrow(
      'OpenCode API Error: Sequence mismatch',
    )
    expect(mocks.syncHistoryList).toHaveBeenCalled()
    expect(mocks.sessionUpdate).not.toHaveBeenCalled()
  })
})
