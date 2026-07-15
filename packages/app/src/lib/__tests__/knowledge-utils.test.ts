import { describe, it, expect, vi } from 'vitest'
import {
  formatTimeAgo,
  getScoreBadgeVariant,
  filterKnowledgeItems,
  classifyFileType,
  type KnowledgeItem,
} from '../knowledge-utils'

// Minimal t() mock that returns the key + interpolation
const t = vi.fn((key: string, opts?: Record<string, unknown>) => {
  if (opts && 'count' in opts) return `${key}:${opts.count}`
  return key
})

// ─── formatTimeAgo ──────────────────────────────────────────────────────────

describe('formatTimeAgo', () => {
  it('returns "common.never" for undefined', () => {
    expect(formatTimeAgo(undefined, t)).toBe('common.never')
  })

  it('returns "common.justNow" for < 1 minute ago', () => {
    const now = new Date().toISOString()
    expect(formatTimeAgo(now, t)).toBe('common.justNow')
  })

  it('returns minutes ago for 5 minutes', () => {
    const date = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(formatTimeAgo(date, t)).toBe('common.minutesAgo:5')
  })

  it('returns minutes ago for 59 minutes', () => {
    const date = new Date(Date.now() - 59 * 60_000).toISOString()
    expect(formatTimeAgo(date, t)).toBe('common.minutesAgo:59')
  })

  it('returns hours ago for 3 hours', () => {
    const date = new Date(Date.now() - 3 * 3600_000).toISOString()
    expect(formatTimeAgo(date, t)).toBe('common.hoursAgo:3')
  })

  it('returns hours ago for 23 hours', () => {
    const date = new Date(Date.now() - 23 * 3600_000).toISOString()
    expect(formatTimeAgo(date, t)).toBe('common.hoursAgo:23')
  })

  it('returns days ago for 2 days', () => {
    const date = new Date(Date.now() - 48 * 3600_000).toISOString()
    expect(formatTimeAgo(date, t)).toBe('common.daysAgo:2')
  })

  it('boundary: exactly 1 hour is hours (not minutes)', () => {
    const date = new Date(Date.now() - 60 * 60_000).toISOString()
    expect(formatTimeAgo(date, t)).toBe('common.hoursAgo:1')
  })

  it('boundary: exactly 24 hours is days', () => {
    const date = new Date(Date.now() - 24 * 3600_000).toISOString()
    expect(formatTimeAgo(date, t)).toBe('common.daysAgo:1')
  })
})

// ─── getScoreBadgeVariant ───────────────────────────────────────────────────

describe('getScoreBadgeVariant', () => {
  it('returns "default" for score >= 0.8', () => {
    expect(getScoreBadgeVariant(0.9)).toBe('default')
    expect(getScoreBadgeVariant(1.0)).toBe('default')
  })

  it('returns "default" at boundary 0.8', () => {
    expect(getScoreBadgeVariant(0.8)).toBe('default')
  })

  it('returns "secondary" for score >= 0.5 and < 0.8', () => {
    expect(getScoreBadgeVariant(0.6)).toBe('secondary')
    expect(getScoreBadgeVariant(0.79)).toBe('secondary')
  })

  it('returns "secondary" at boundary 0.5', () => {
    expect(getScoreBadgeVariant(0.5)).toBe('secondary')
  })

  it('returns "outline" for score < 0.5', () => {
    expect(getScoreBadgeVariant(0.3)).toBe('outline')
    expect(getScoreBadgeVariant(0)).toBe('outline')
    expect(getScoreBadgeVariant(0.49)).toBe('outline')
  })
})

// ─── filterKnowledgeItems ───────────────────────────────────────────────────

describe('filterKnowledgeItems', () => {
  const items: KnowledgeItem[] = [
    { path: '/a/readme.md', name: 'readme.md', type: 'file' },
    {
      path: '/a/docs',
      name: 'docs',
      type: 'directory',
      children: [
        { path: '/a/docs/guide.md', name: 'guide.md', type: 'file' },
        { path: '/a/docs/api.md', name: 'api.md', type: 'file' },
      ],
    },
    { path: '/a/notes.txt', name: 'notes.txt', type: 'file' },
  ]

  it('returns all items for empty query', () => {
    expect(filterKnowledgeItems(items, '')).toEqual(items)
  })

  it('returns all items for whitespace-only query', () => {
    expect(filterKnowledgeItems(items, '   ')).toEqual(items)
  })

  it('filters files by name match', () => {
    const result = filterKnowledgeItems(items, 'readme')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('readme.md')
  })

  it('is case-insensitive', () => {
    const result = filterKnowledgeItems(items, 'README')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('readme.md')
  })

  it('preserves parent directory when child matches', () => {
    const result = filterKnowledgeItems(items, 'guide')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('docs')
    expect(result[0].children).toHaveLength(1)
    expect(result[0].children![0].name).toBe('guide.md')
  })

  it('returns directory if directory name matches', () => {
    const result = filterKnowledgeItems(items, 'docs')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('docs')
    // Directory name matches, so it's included; children are also filtered
    // Both children also contain "docs" path, but filter is name-based
    // Children don't match "docs" in name, so they get filtered out
    // unless the directory itself short-circuits the filter
    expect(result[0].type).toBe('directory')
  })

  it('returns empty array when nothing matches', () => {
    const result = filterKnowledgeItems(items, 'nonexistent')
    expect(result).toHaveLength(0)
  })

  it('matches partial file names', () => {
    const result = filterKnowledgeItems(items, '.md')
    expect(result.length).toBeGreaterThanOrEqual(2) // readme.md + docs dir (children match)
  })
})

// ─── classifyFileType ───────────────────────────────────────────────────────

describe('classifyFileType', () => {
  it('classifies PDF as convert', () => {
    expect(classifyFileType('/path/doc.pdf')).toBe('convert')
  })

  it('classifies DOCX as convert', () => {
    expect(classifyFileType('/path/doc.docx')).toBe('convert')
  })

  it('classifies images as convert', () => {
    expect(classifyFileType('/path/img.jpg')).toBe('convert')
    expect(classifyFileType('/path/img.png')).toBe('convert')
  })

  it('classifies audio as convert', () => {
    expect(classifyFileType('/path/audio.mp3')).toBe('convert')
    expect(classifyFileType('/path/audio.wav')).toBe('convert')
  })

  it('classifies MD as copy', () => {
    expect(classifyFileType('/path/readme.md')).toBe('copy')
  })

  it('classifies TXT as copy', () => {
    expect(classifyFileType('/path/notes.txt')).toBe('copy')
  })

  it('classifies unknown extension as unsupported', () => {
    expect(classifyFileType('/path/file.xyz')).toBe('unsupported')
  })

  it('classifies file without extension as unsupported', () => {
    expect(classifyFileType('/path/Makefile')).toBe('unsupported')
  })

  it('handles lowercase extension matching', () => {
    // classifyFileType lowercases the extension before comparing
    expect(classifyFileType('/path/doc.pdf')).toBe('convert')
    expect(classifyFileType('/path/doc.md')).toBe('copy')
  })
})
