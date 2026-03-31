import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSetState, mockUnlisten, mockListen, mockInvoke } = vi.hoisted(() => ({
  mockSetState: vi.fn(),
  mockUnlisten: vi.fn(),
  mockListen: vi.fn(),
  mockInvoke: vi.fn(),
}))

// Mock isTauri to return true
vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// Mock team-mode store
vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    () => ({}),
    {
      getState: () => ({ p2pConnected: false }),
      setState: mockSetState,
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

const DEFAULT_SNAPSHOT = {
  status: 'disconnected',
  streamHealth: 'dead',
  uptimeSecs: 0,
  restartCount: 0,
  lastSyncAt: null,
  peers: [],
  syncedFiles: 0,
  pendingFiles: 0,
}

const CONNECTED_SNAPSHOT = {
  status: 'connected',
  streamHealth: 'healthy',
  uptimeSecs: 120,
  restartCount: 0,
  lastSyncAt: '2024-01-01T00:00:00Z',
  peers: [
    {
      nodeId: 'peer-1',
      name: 'Alice',
      role: 'editor',
      connection: 'active',
      lastSeenSecsAgo: 5,
      entriesSent: 10,
      entriesReceived: 20,
    },
  ],
  syncedFiles: 5,
  pendingFiles: 2,
}

import { useP2pEngineStore } from '../p2p-engine'

let eventCallback: ((event: { payload: unknown }) => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  eventCallback = null
  mockListen.mockImplementation(
    async (_eventName: string, callback: (event: { payload: unknown }) => void) => {
      eventCallback = callback
      return mockUnlisten
    },
  )
  mockInvoke.mockResolvedValue(CONNECTED_SNAPSHOT)
  // Reset store state
  useP2pEngineStore.setState({ snapshot: { ...DEFAULT_SNAPSHOT, peers: [] }, initialized: false })
})

describe('useP2pEngineStore', () => {
  it('has correct default snapshot', () => {
    const { snapshot } = useP2pEngineStore.getState()
    expect(snapshot.status).toBe('disconnected')
    expect(snapshot.streamHealth).toBe('dead')
    expect(snapshot.peers).toEqual([])
    expect(snapshot.uptimeSecs).toBe(0)
    expect(snapshot.syncedFiles).toBe(0)
    expect(snapshot.pendingFiles).toBe(0)
  })

  it('fetch updates snapshot', async () => {
    await useP2pEngineStore.getState().fetch()
    expect(mockInvoke).toHaveBeenCalledWith('p2p_node_status')
    const { snapshot } = useP2pEngineStore.getState()
    expect(snapshot.status).toBe('connected')
    expect(snapshot.peers).toHaveLength(1)
    expect(snapshot.syncedFiles).toBe(5)
  })

  it('init subscribes to p2p:engine-state event', async () => {
    await useP2pEngineStore.getState().init()
    expect(mockListen).toHaveBeenCalledWith('p2p:engine-state', expect.any(Function))
  })

  it('init fetches initial state', async () => {
    await useP2pEngineStore.getState().init()
    expect(mockInvoke).toHaveBeenCalledWith('p2p_node_status')
  })

  it('init is idempotent', async () => {
    await useP2pEngineStore.getState().init()
    await useP2pEngineStore.getState().init()
    expect(mockListen).toHaveBeenCalledTimes(1)
  })

  it('event updates snapshot', async () => {
    await useP2pEngineStore.getState().init()

    const newSnapshot = { ...CONNECTED_SNAPSHOT, uptimeSecs: 999 }
    eventCallback!({ payload: newSnapshot })

    const { snapshot } = useP2pEngineStore.getState()
    expect(snapshot.uptimeSecs).toBe(999)
  })

  it('cleanup unsubscribes', async () => {
    const cleanup = await useP2pEngineStore.getState().init()
    cleanup()
    expect(mockUnlisten).toHaveBeenCalled()
  })

  it('syncs p2pConnected to team-mode store on connected event', async () => {
    await useP2pEngineStore.getState().init()
    mockSetState.mockClear()

    eventCallback!({ payload: { ...CONNECTED_SNAPSHOT, status: 'connected' } })

    expect(mockSetState).toHaveBeenCalledWith({ p2pConnected: true })
  })
})
