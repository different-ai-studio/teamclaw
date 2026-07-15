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
})
