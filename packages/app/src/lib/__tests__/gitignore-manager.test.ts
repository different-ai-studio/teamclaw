import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ensureGitignoreEntries,
  parseGitignore,
} from '../gitignore-manager'

// Mock Tauri FS API
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
}))

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}))

import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs'

describe('gitignore-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('parseGitignore', () => {
    it('should parse gitignore content into lines', () => {
      const content = '# Comment\n.teamclaw/\n.opencode/\n'
      const result = parseGitignore(content)
      expect(result).toEqual(['# Comment', '.teamclaw/', '.opencode/'])
    })

    it('should handle empty content', () => {
      const result = parseGitignore('')
      expect(result).toEqual([])
    })
  })

  describe('ensureGitignoreEntries', () => {
    it('should create .gitignore if it does not exist', async () => {
      vi.mocked(exists).mockResolvedValue(false)
      
      await ensureGitignoreEntries('/workspace')
      
      expect(writeTextFile).toHaveBeenCalledWith(
        '/workspace/.gitignore',
        expect.stringContaining('.teamclaw/')
      )
    })

    it('should append missing entries to existing .gitignore', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue('# Existing\nnode_modules/\n')

      await ensureGitignoreEntries('/workspace')

      const writtenContent = vi.mocked(writeTextFile).mock.calls[0][1]
      expect(writtenContent).toContain('# Existing')
      expect(writtenContent).toContain('node_modules/')
      expect(writtenContent).toContain('.teamclaw/')
      expect(writtenContent.indexOf('# Existing')).toBeLessThan(writtenContent.indexOf('.teamclaw/'))
    })

    it('should not duplicate entries with different formatting', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue('.teamclaw\n.opencode\n')  // No trailing slashes

      await ensureGitignoreEntries('/workspace')

      expect(writeTextFile).not.toHaveBeenCalled()
    })

    it('should add comment header when appending entries', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue('node_modules/\n')

      await ensureGitignoreEntries('/workspace')

      expect(writeTextFile).toHaveBeenCalledWith(
        '/workspace/.gitignore',
        expect.stringContaining('# TeamClaw system directories')
      )
    })

    it('should not duplicate existing entries', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readTextFile).mockResolvedValue('.teamclaw/\n.opencode/\n')
      
      await ensureGitignoreEntries('/workspace')
      
      expect(writeTextFile).not.toHaveBeenCalled()
    })
  })
})
