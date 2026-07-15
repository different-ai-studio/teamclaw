import { describe, it, expect } from 'vitest'
import { parseInviteDeeplink, parseInviteTokenInput } from '@/lib/invite-deeplink'

describe('parseInviteDeeplink', () => {
  it('extracts the token from teamclaw://invite?token=…', () => {
    expect(parseInviteDeeplink('teamclaw://invite?token=ABCXYZ_24bytes')).toBe('ABCXYZ_24bytes')
  })

  it('also accepts amux://invite?token=… (RPC native scheme)', () => {
    expect(parseInviteDeeplink('amux://invite?token=XYZ')).toBe('XYZ')
  })

  it('returns null for non-invite paths', () => {
    expect(parseInviteDeeplink('teamclaw://session/123')).toBeNull()
  })

  it('returns null when token query is absent', () => {
    expect(parseInviteDeeplink('teamclaw://invite')).toBeNull()
  })

  it('returns null for malformed urls', () => {
    expect(parseInviteDeeplink('not a url')).toBeNull()
  })

  it('accepts bare invite tokens for pasted onboarding input', () => {
    expect(parseInviteTokenInput('  bare_token_123  ')).toBe('bare_token_123')
  })

  it('accepts deeplinks for pasted onboarding input', () => {
    expect(parseInviteTokenInput('teamclaw://invite?token=FROM_LINK')).toBe('FROM_LINK')
  })

  it('rejects non-invite urls for pasted onboarding input', () => {
    expect(parseInviteTokenInput('https://example.com/invite?token=nope')).toBeNull()
  })
})
