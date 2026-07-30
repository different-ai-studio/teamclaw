import { describe, expect, it, vi, beforeEach } from 'vitest'
import { create } from '@bufbuild/protobuf'

const getDaemonModelCatalog = vi.hoisted(() => vi.fn())

vi.mock('@/lib/daemon-local-client', () => ({
  getDaemonModelCatalog,
  encodeWorkspaceId: (p: string) => `enc(${p})`,
}))
vi.mock('@/lib/session-flow-log', () => ({ sessionFlowLog: vi.fn() }))

import { ModelInfoSchema, RuntimeInfoSchema, RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import {
  fetchLocalDaemonModels,
  mergeLocalDaemonModels,
} from '../local-daemon-model-catalog'

const catalog = (backend: string, refs: string[]) => ({
  automation_default_backend: backend,
  backends: [
    {
      backend,
      label: backend,
      models: refs.map((ref) => ({ ref, model_id: ref, display_name: ref })),
    },
  ],
})

describe('fetchLocalDaemonModels', () => {
  beforeEach(() => {
    getDaemonModelCatalog.mockReset()
  })

  it('returns the group for each implemented backend', async () => {
    // All four backends must resolve over HTTP; cursor and claude used to get no
    // group at all from this endpoint.
    for (const [backendType, groupId] of [
      ['opencode', 'opencode'],
      ['pi', 'pi'],
      ['cursor', 'cursor'],
      ['claude-code', 'claude'],
    ] as const) {
      getDaemonModelCatalog.mockResolvedValueOnce(catalog(groupId, ['prov/a', 'prov/b']))
      const models = await fetchLocalDaemonModels('/w1', backendType)
      expect(models, `${backendType} should resolve models`).toHaveLength(2)
      expect(models?.[0].id).toBe('prov/a')
      expect(models?.[0].providerName).toBe(groupId)
    }
  })

  it('maps every claude spelling onto the daemon "claude" group id', async () => {
    for (const spelling of ['claude', 'claude_code', 'claude-code']) {
      getDaemonModelCatalog.mockResolvedValueOnce(catalog('claude', ['anthropic/opus']))
      const models = await fetchLocalDaemonModels('/w1', spelling)
      expect(models, `${spelling} should resolve`).toHaveLength(1)
    }
  })

  it('accepts the sole group when the client backend type is stale', async () => {
    // Single-agent mode serves one group; discarding it over a name mismatch
    // would throw away the only catalog available.
    getDaemonModelCatalog.mockResolvedValue(catalog('pi', ['pi/x']))
    expect(await fetchLocalDaemonModels('/w1', 'opencode')).toHaveLength(1)
    expect(await fetchLocalDaemonModels('/w1', null)).toHaveLength(1)
  })

  it('returns null when the daemon is unreachable, empty, or the path is blank', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce(null)
    expect(await fetchLocalDaemonModels('/w1', 'opencode')).toBeNull()

    getDaemonModelCatalog.mockResolvedValueOnce(catalog('opencode', []))
    expect(await fetchLocalDaemonModels('/w1', 'opencode')).toBeNull()

    expect(await fetchLocalDaemonModels('   ', 'opencode')).toBeNull()
  })

  it('does not guess when several groups are offered and none matches', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce({
      automation_default_backend: 'pi',
      backends: [
        { backend: 'pi', label: 'Pi', models: [{ ref: 'pi/x', model_id: 'x', display_name: 'x' }] },
        {
          backend: 'cursor',
          label: 'Cursor',
          models: [{ ref: 'cursor/y', model_id: 'y', display_name: 'y' }],
        },
      ],
    })
    expect(await fetchLocalDaemonModels('/w1', 'opencode')).toBeNull()
  })
})

describe('mergeLocalDaemonModels', () => {
  const models = [create(ModelInfoSchema, { id: 'prov/http', displayName: 'From HTTP' })]

  const seedEntry = (runtimeId: string, actorId: string, availableModels: unknown[] = []) => {
    useRuntimeStateStore.getState().upsert(
      runtimeId,
      actorId,
      create(RuntimeInfoSchema, {
        runtimeId,
        state: RuntimeLifecycle.ACTIVE,
        availableModels: availableModels as never,
      }),
    )
  }

  beforeEach(() => {
    useRuntimeStateStore.getState().clear()
  })

  it('fills an empty catalog on both the spawn and agent-uuid keys', () => {
    seedEntry('rt-1', 'actor-1')
    expect(
      mergeLocalDaemonModels({ daemonActorId: 'actor-1', runtimeId: 'rt-1', models }),
    ).toBe(true)

    const state = useRuntimeStateStore.getState().byRuntimeId
    expect(state['rt-1'].info.availableModels[0].id).toBe('prov/http')
    // The mirror key is what resolvers look up first.
    expect(state['actor-1'].info.availableModels[0].id).toBe('prov/http')
  })

  it('leaves a retain that already carries models alone', () => {
    seedEntry('rt-1', 'actor-1', [create(ModelInfoSchema, { id: 'prov/from-retain' })])
    expect(
      mergeLocalDaemonModels({ daemonActorId: 'actor-1', runtimeId: 'rt-1', models }),
    ).toBe(false)
    expect(
      useRuntimeStateStore.getState().byRuntimeId['rt-1'].info.availableModels[0].id,
    ).toBe('prov/from-retain')
  })

  it('does nothing without an existing entry or without models', () => {
    expect(
      mergeLocalDaemonModels({ daemonActorId: 'actor-1', runtimeId: 'missing', models }),
    ).toBe(false)

    seedEntry('rt-1', 'actor-1')
    expect(
      mergeLocalDaemonModels({ daemonActorId: 'actor-1', runtimeId: 'rt-1', models: [] }),
    ).toBe(false)
  })
})
