import { describe, expect, it } from 'vitest'

import { shouldOpenNewSessionActorPicker } from '../chat-panel-routing'

describe('shouldOpenNewSessionActorPicker', () => {
  it('opens for a first message when no session is active', () => {
    expect(
      shouldOpenNewSessionActorPicker({
        activeSessionId: null,
        activeMessageCount: 0,
        hasDraftPreselectedActor: false,
      }),
    ).toBe(true)
  })

  it('opens for a first message in an active empty session', () => {
    expect(
      shouldOpenNewSessionActorPicker({
        activeSessionId: 'empty-session',
        activeMessageCount: 0,
        hasDraftPreselectedActor: false,
      }),
    ).toBe(true)
  })

  it('does not open after the session already has messages', () => {
    expect(
      shouldOpenNewSessionActorPicker({
        activeSessionId: 'session-with-history',
        activeMessageCount: 1,
        hasDraftPreselectedActor: false,
      }),
    ).toBe(false)
  })

  it('does not open for actor-draft sends', () => {
    expect(
      shouldOpenNewSessionActorPicker({
        activeSessionId: null,
        activeMessageCount: 0,
        hasDraftPreselectedActor: true,
      }),
    ).toBe(false)
  })
})
