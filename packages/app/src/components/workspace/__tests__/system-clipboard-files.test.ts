import { describe, it, expect } from 'vitest'
import { resolvePasteSource } from '../system-clipboard-files'

describe('resolvePasteSource', () => {
  it('returns nothing when neither source has files', () => {
    expect(resolvePasteSource([], [], null)).toBeNull()
  })

  it('pastes files copied in Finder, which the in-app clipboard knows nothing about', () => {
    expect(resolvePasteSource(['/Users/me/notes.md'], [], null)).toEqual({
      paths: ['/Users/me/notes.md'],
      mode: 'copy',
    })
  })

  it('keeps cut semantics when the pasteboard still holds exactly our own selection', () => {
    const paths = ['/ws/a.md', '/ws/b.md']
    expect(resolvePasteSource(paths, paths, 'cut')).toEqual({ paths, mode: 'cut' })
  })

  it('ignores selection order when matching our own selection', () => {
    expect(
      resolvePasteSource(['/ws/b.md', '/ws/a.md'], ['/ws/a.md', '/ws/b.md'], 'cut'),
    ).toEqual({ paths: ['/ws/b.md', '/ws/a.md'], mode: 'cut' })
  })

  it('downgrades a stale cut to a copy once the pasteboard moves on', () => {
    // User cut in-app, then copied something else in Finder. Honouring the
    // pending cut here would move files the user never selected.
    expect(resolvePasteSource(['/other/x.md'], ['/ws/a.md'], 'cut')).toEqual({
      paths: ['/other/x.md'],
      mode: 'copy',
    })
  })

  it('treats a partial overlap as a foreign copy, not our cut', () => {
    expect(
      resolvePasteSource(['/ws/a.md', '/other/x.md'], ['/ws/a.md'], 'cut'),
    ).toEqual({ paths: ['/ws/a.md', '/other/x.md'], mode: 'copy' })
  })

  it('falls back to the in-app clipboard when the pasteboard holds no files', () => {
    expect(resolvePasteSource([], ['/ws/a.md'], 'cut')).toEqual({
      paths: ['/ws/a.md'],
      mode: 'cut',
    })
  })

  it('ignores an in-app selection with no mode', () => {
    expect(resolvePasteSource([], ['/ws/a.md'], null)).toBeNull()
  })
})
