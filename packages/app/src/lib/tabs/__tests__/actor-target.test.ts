import { describe, it, expect } from 'vitest'
import { encodeActorTarget, decodeActorTarget, isActorOwnedTarget } from '../actor-target'
import { decodeTeamShareTarget, decodeVersionHistoryTarget } from '../teamshare-target'

describe('actor tab target', () => {
  it('round-trips an actor id', () => {
    const target = encodeActorTarget('11111111-2222-3333-4444-555555555555')
    expect(decodeActorTarget(target)).toBe('11111111-2222-3333-4444-555555555555')
    expect(isActorOwnedTarget(target)).toBe(true)
  })

  it('ignores targets it does not own', () => {
    expect(decodeActorTarget('teamshare:skill/foo')).toBeNull()
    expect(decodeActorTarget('version-history/notes.md')).toBeNull()
    expect(decodeActorTarget('src/main.ts')).toBeNull()
    // The prefix alone addresses nothing.
    expect(decodeActorTarget('actor/')).toBeNull()
    expect(isActorOwnedTarget('teamshare:mcp/github')).toBe(false)
  })

  // NativeContent parses targets in sequence, so an actor target must not read
  // as a team-share or version-history one (or vice versa).
  it('does not collide with the other native target namespaces', () => {
    const target = encodeActorTarget('actor-1')
    expect(decodeTeamShareTarget(target)).toBeNull()
    expect(decodeVersionHistoryTarget(target)).toBeUndefined()
  })
})
