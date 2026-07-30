import { describe, expect, it } from 'vitest'
import { resolveAutoPersistModelId } from '../agent-model-auto-persist'

const LOCAL = 'local-daemon-actor'
const MRU_HEAD = 'minimax-cn/MiniMax-M2.7'
const LIST_HEAD = 'anthropic/claude-fable-5'

/** Cold start on the local agent: catalog settled, MRU known, nothing else set. */
function base(overrides: Partial<Parameters<typeof resolveAutoPersistModelId>[0]> = {}) {
  return resolveAutoPersistModelId({
    sessionId: 'sess-1',
    uiState: 'ready',
    runtimeInfoLoading: false,
    availableModelIds: [LIST_HEAD, 'anthropic/claude-haiku', MRU_HEAD],
    existingPick: undefined,
    sessionEstablishedModel: null,
    retainCurrentModel: null,
    localDaemonActorId: LOCAL,
    agentId: LOCAL,
    localCatalogStatus: 'ready',
    localRecentModel: MRU_HEAD,
    ...overrides,
  })
}

describe('resolveAutoPersistModelId', () => {
  it('persists the device MRU, not the first model in the list', () => {
    // The user's report: "每次重启都会回到模型列表的第一个". Every restart makes
    // a new session, so this is the path that decides it.
    expect(base()).toBe(MRU_HEAD)
  })

  it('falls back to first-advertised only when there is no MRU to honour', () => {
    expect(base({ localRecentModel: '' })).toBe(LIST_HEAD)
  })

  describe('refuses to write while an input is merely not-yet-known', () => {
    // These are the two holes that let the wrong model get pinned despite a
    // guard being present. Both look like "known absent" but mean "unknown".

    it('waits when the loopback catalog has no entry yet', () => {
      // undefined = no probe result recorded. A guard that only checked
      // 'pending' sailed straight through the very first render.
      expect(base({ localCatalogStatus: undefined })).toBeNull()
      expect(base({ localCatalogStatus: 'pending' })).toBeNull()
    })
  })

  it('does not stall forever when this device has no local daemon at all', () => {
    // Outside Tauri (web build, tests) the identity never resolves. An earlier
    // guard blocked on null and so persisted nothing for ANY agent, ever —
    // trading the pinned-wrong-model bug for a never-pinned one. The caller
    // passes the persisted id, so null here means "no local daemon on this
    // device", not "ask again later".
    expect(base({ localDaemonActorId: null, localCatalogStatus: undefined })).toBe(MRU_HEAD)
  })

  it('still writes for a remote agent without waiting on this device catalog', () => {
    // The loopback catalog says nothing about another machine, so it must not
    // gate a remote agent — that would leave remote pills permanently unpinned.
    expect(
      base({
        agentId: 'some-remote-agent',
        localCatalogStatus: undefined,
        localRecentModel: '',
      }),
    ).toBe(LIST_HEAD)
  })

  it('never overrides an answer that already has more authority', () => {
    expect(base({ existingPick: 'user/chose-this' })).toBeNull()
    expect(base({ sessionEstablishedModel: 'transcript/model' })).toBeNull()
    expect(base({ retainCurrentModel: 'retain/model' })).toBeNull()
  })

  it('writes nothing when the agent cannot run anything', () => {
    for (const uiState of ['offline', 'stale', 'unconfigured'] as const) {
      expect(base({ uiState }), uiState).toBeNull()
    }
  })

  it('writes nothing without a session, a catalog, or while it is loading', () => {
    expect(base({ sessionId: '   ' })).toBeNull()
    expect(base({ availableModelIds: [] })).toBeNull()
    expect(base({ runtimeInfoLoading: true })).toBeNull()
  })

  it('proceeds once the probe has settled on a definite answer', () => {
    // 'unknown' means we asked and learned nothing — stop waiting and fall
    // back, rather than leave the pill unpinned forever.
    expect(base({ localCatalogStatus: 'unknown', localRecentModel: '' })).toBe(LIST_HEAD)
    expect(base({ localCatalogStatus: 'empty', localRecentModel: '' })).toBe(LIST_HEAD)
  })
})
