import { describe, it, expect } from 'vitest'
import { parseSessionDeeplink, buildSessionDeeplink } from '@/lib/session-deeplink'

const UUID = 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f'

describe('parseSessionDeeplink', () => {
  it('extracts the uuid from teamclaw://session/<uuid>', () => {
    expect(parseSessionDeeplink(`teamclaw://session/${UUID}`)).toBe(UUID)
  })

  it('also accepts amux://session/<uuid> for back-compat', () => {
    expect(parseSessionDeeplink(`amux://session/${UUID}`)).toBe(UUID)
  })

  it('returns null for invite urls', () => {
    expect(parseSessionDeeplink('teamclaw://invite?token=ABC')).toBeNull()
  })

  it('returns null when the path is not a uuid', () => {
    expect(parseSessionDeeplink('teamclaw://session/not-a-uuid')).toBeNull()
  })

  it('returns null when the session id is missing', () => {
    expect(parseSessionDeeplink('teamclaw://session')).toBeNull()
    expect(parseSessionDeeplink('teamclaw://session/')).toBeNull()
  })

  it('returns null for malformed urls', () => {
    expect(parseSessionDeeplink('not a url')).toBeNull()
  })
})

describe('buildSessionDeeplink', () => {
  it('builds teamclaw://session/<uuid> using the build scheme', () => {
    expect(buildSessionDeeplink(UUID)).toBe(`teamclaw://session/${UUID}`)
  })
})
