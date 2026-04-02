import { describe, it, expect } from 'vitest'
import { isSuperAgentSnapshot } from '../super-agent'

describe('isSuperAgentSnapshot', () => {
  it('returns true for valid snapshot', () => {
    expect(
      isSuperAgentSnapshot({ localAgent: null, agents: [], connected: false }),
    ).toBe(true)
  })

  it('returns true for snapshot with agents', () => {
    const agent = {
      nodeId: 'abc-123',
      name: 'TestAgent',
      owner: 'user-1',
      status: 'online',
      capabilities: [{ domain: 'chat', skills: [], tools: [], languages: [], confidence: 0.9, taskCount: 0, avgScore: 0.8 }],
      currentTask: null,
      lastHeartbeat: 0,
      version: '0.1.0',
      modelId: 'claude-3-5-sonnet',
      joinedAt: 0,
    }
    expect(
      isSuperAgentSnapshot({ localAgent: agent, agents: [agent], connected: true }),
    ).toBe(true)
  })

  it('returns false for null', () => {
    expect(isSuperAgentSnapshot(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isSuperAgentSnapshot(undefined)).toBe(false)
  })

  it('returns false for missing agents array', () => {
    expect(isSuperAgentSnapshot({ localAgent: null, connected: false })).toBe(false)
  })

  it('returns false for missing connected boolean', () => {
    expect(isSuperAgentSnapshot({ localAgent: null, agents: [] })).toBe(false)
  })

  it('returns false for wrong types', () => {
    expect(isSuperAgentSnapshot({ localAgent: null, agents: 'not-an-array', connected: 'yes' })).toBe(false)
  })
})
