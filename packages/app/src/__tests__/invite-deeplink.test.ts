import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildInviteDeeplink, parseInviteDeeplink, parseInviteTokenInput } from '@/lib/invite-deeplink'

describe('parseInviteDeeplink', () => {
  it('extracts the token from teamclu://invite?token=…', () => {
    expect(parseInviteDeeplink('teamclu://invite?token=ABCXYZ_24bytes')).toBe('ABCXYZ_24bytes')
  })

  it('still accepts the pre-rebrand teamclaw:// scheme', () => {
    // Invite links handed out before the rename carry it; rejecting them makes
    // every one of those links dead.
    expect(parseInviteDeeplink('teamclaw://invite?token=OLD_LINK')).toBe('OLD_LINK')
  })

  it('also accepts amux://invite?token=… (RPC native scheme)', () => {
    expect(parseInviteDeeplink('amux://invite?token=XYZ')).toBe('XYZ')
  })

  it('returns null for non-invite paths', () => {
    expect(parseInviteDeeplink('teamclu://session/123')).toBeNull()
  })

  it('returns null when token query is absent', () => {
    expect(parseInviteDeeplink('teamclu://invite')).toBeNull()
  })

  it('returns null for malformed urls', () => {
    expect(parseInviteDeeplink('not a url')).toBeNull()
  })

  it('accepts bare invite tokens for pasted onboarding input', () => {
    expect(parseInviteTokenInput('  bare_token_123  ')).toBe('bare_token_123')
  })

  it('accepts deeplinks for pasted onboarding input', () => {
    expect(parseInviteTokenInput('teamclu://invite?token=FROM_LINK')).toBe('FROM_LINK')
  })

  it('rejects non-invite urls for pasted onboarding input', () => {
    expect(parseInviteTokenInput('https://example.com/invite?token=nope')).toBeNull()
  })
})

describe('buildInviteDeeplink', () => {
  it('builds the link on the build scheme, not the backend amux:// one', () => {
    expect(buildInviteDeeplink('TOK/EN+1')).toBe('teamclu://invite?token=TOK%2FEN%2B1')
  })
})

describe('a build with its own app.scheme', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/build-config')
    vi.resetModules()
  })

  async function loadForScheme(scheme: string) {
    vi.resetModules()
    vi.doMock('@/lib/build-config', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/build-config')>('@/lib/build-config')
      return { ...actual, appScheme: scheme, deeplinkSchemes: actual.resolveDeeplinkSchemes(scheme) }
    })
    return import('@/lib/invite-deeplink')
  }

  it('takes copilot361:// and nothing else', async () => {
    // The OS only ever hands this build copilot361:// links; a teamclu:// or
    // amux:// one would open the official app, so accepting it here just made a
    // dead link look supported.
    const { parseInviteDeeplink: parse } = await loadForScheme('copilot361')
    expect(parse('copilot361://invite?token=OK')).toBe('OK')
    expect(parse('teamclu://invite?token=NO')).toBeNull()
    expect(parse('teamclaw://invite?token=NO')).toBeNull()
    expect(parse('amux://invite?token=NO')).toBeNull()
  })

  it('hands out invite links on its own scheme', async () => {
    const { buildInviteDeeplink: build } = await loadForScheme('copilot361')
    expect(build('TOK')).toBe('copilot361://invite?token=TOK')
  })

  it('still takes a bare pasted token', async () => {
    const { parseInviteTokenInput: parseInput } = await loadForScheme('copilot361')
    expect(parseInput('  bare_token_123  ')).toBe('bare_token_123')
  })
})
