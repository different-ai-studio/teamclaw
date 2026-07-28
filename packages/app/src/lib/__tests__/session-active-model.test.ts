import { describe, expect, it } from 'vitest'

import { resolveSessionModelFromRuntimeRows } from '../session-active-model'

describe('resolveSessionModelFromRuntimeRows', () => {
  const models = [
    { provider: 'opencode', id: 'opencode/qwen3.6-plus-free', name: 'OpenCode Zen/Qwen3.6 Plus Free' },
    { provider: 'opencode', id: 'opencode/big-pickle', name: 'Big Pickle' },
    { provider: 'claude-code', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ]

  it('resolves the active session model from live RuntimeInfo for that session runtime', () => {
    const result = resolveSessionModelFromRuntimeRows(
      [
        {
          runtime_id: 'rt-old',
          backend_type: 'opencode',
          current_model: 'opencode/big-pickle',
        },
      ],
      {
        'rt-old': {
          daemonActorId: 'agent-1',
          info: {
            currentModel: 'opencode/qwen3.6-plus-free',
          },
        } as any,
      },
      models,
    )

    expect(result).toEqual({
      provider: 'opencode',
      modelId: 'opencode/qwen3.6-plus-free',
      name: 'OpenCode Zen/Qwen3.6 Plus Free',
      source: 'runtimeInfo',
    })
  })

  it('falls back to agent_runtimes.current_model when live RuntimeInfo is missing', () => {
    const result = resolveSessionModelFromRuntimeRows(
      [
        {
          runtime_id: 'rt-old',
          backend_type: 'opencode',
          current_model: 'opencode/big-pickle',
        },
      ],
      {},
      models,
    )

    expect(result).toEqual({
      provider: 'opencode',
      modelId: 'opencode/big-pickle',
      name: 'Big Pickle',
      source: 'agentRuntimes',
    })
  })

  it('prefers a mounted agent runtime over an earlier row from a departed agent', () => {
    // Shape of "switch to local agent": the dead remote's row is still in the
    // session and comes back first, but only the local agent is mounted.
    const result = resolveSessionModelFromRuntimeRows(
      [
        { runtime_id: 'rt-remote', backend_type: 'claude-code', current_model: 'claude-sonnet-4-6' },
        { runtime_id: 'rt-local', backend_type: 'opencode', current_model: 'opencode/big-pickle' },
      ],
      {
        'rt-remote': { daemonActorId: 'agent-remote', info: { currentModel: 'claude-sonnet-4-6' } } as any,
        'rt-local': { daemonActorId: 'agent-local', info: { currentModel: 'opencode/big-pickle' } } as any,
      },
      models,
      ['agent-local'],
    )

    expect(result).toMatchObject({ provider: 'opencode', modelId: 'opencode/big-pickle' })
  })

  it('keeps row order when no row belongs to a mounted agent', () => {
    const result = resolveSessionModelFromRuntimeRows(
      [{ runtime_id: 'rt-remote', backend_type: 'claude-code', current_model: 'claude-sonnet-4-6' }],
      {},
      models,
      ['agent-local'],
    )

    expect(result).toMatchObject({ modelId: 'claude-sonnet-4-6', source: 'agentRuntimes' })
  })
})
