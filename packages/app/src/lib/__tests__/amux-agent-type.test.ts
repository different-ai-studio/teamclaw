import { describe, expect, it } from 'vitest'

import { AgentType } from '@/lib/proto/amux_pb'

import { resolveAmuxAgentType } from '../amux-agent-type'

describe('resolveAmuxAgentType', () => {
  it('prefers explicit backend type when present', () => {
    expect(resolveAmuxAgentType('opencode')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType('codex')).toBe(AgentType.CODEX)
    expect(resolveAmuxAgentType('claude-code')).toBe(AgentType.CLAUDE_CODE)
    expect(resolveAmuxAgentType('claude')).toBe(AgentType.CLAUDE_CODE)
    expect(resolveAmuxAgentType('claude_code')).toBe(AgentType.CLAUDE_CODE)
  })

  it('falls back to agent kind when backend history is missing', () => {
    expect(resolveAmuxAgentType(null, 'daemon')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType(undefined, 'amuxd')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType(undefined, 'opencode')).toBe(AgentType.OPENCODE)
    expect(resolveAmuxAgentType(undefined, 'codex')).toBe(AgentType.CODEX)
  })

  it('defaults unknown combinations to claude code', () => {
    expect(resolveAmuxAgentType(undefined, undefined)).toBe(AgentType.CLAUDE_CODE)
    expect(resolveAmuxAgentType('something-else', 'member')).toBe(AgentType.CLAUDE_CODE)
  })
})
