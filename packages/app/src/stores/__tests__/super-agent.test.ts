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
      agentId: 'abc-123',
      name: 'TestAgent',
      status: 'online',
      capabilities: [{ name: 'chat', description: 'Chat capability' }],
      domain: 'example.com',
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
