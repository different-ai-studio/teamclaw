import { describe, it, expect } from 'vitest'
import { parseSessionDeeplink, buildSessionDeeplink } from '@/lib/session-deeplink'

const UUID = 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f'

describe('parseSessionDeeplink', () => {
  it('extracts the uuid from teamclu://session/<uuid>', () => {
    expect(parseSessionDeeplink(`teamclu://session/${UUID}`)).toBe(UUID)
  })

  it('also accepts amux://session/<uuid> for back-compat', () => {
    expect(parseSessionDeeplink(`amux://session/${UUID}`)).toBe(UUID)
  })

  it('returns null for invite urls', () => {
    expect(parseSessionDeeplink('teamclu://invite?token=ABC')).toBeNull()
  })

  it('returns null when the path is not a uuid', () => {
    expect(parseSessionDeeplink('teamclu://session/not-a-uuid')).toBeNull()
  })

  it('returns null when the session id is missing', () => {
    expect(parseSessionDeeplink('teamclu://session')).toBeNull()
    expect(parseSessionDeeplink('teamclu://session/')).toBeNull()
  })

  it('returns null for malformed urls', () => {
    expect(parseSessionDeeplink('not a url')).toBeNull()
  })
})

describe('buildSessionDeeplink', () => {
  it('builds teamclu://session/<uuid> using the build scheme', () => {
    expect(buildSessionDeeplink(UUID)).toBe(`teamclu://session/${UUID}`)
  })
})
