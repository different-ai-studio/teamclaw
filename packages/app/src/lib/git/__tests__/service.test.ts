// Test file - vitest globals (describe, it, expect) provided by vitest/globals type config
import { GitService, GitStatus, normalizePath, pathsEqual, isChildPath } from '../service'

// Path utility tests (no mocks needed)
describe('Path Utilities', () => {
  describe('normalizePath', () => {
    it('should convert backslashes to forward slashes', () => {
      expect(normalizePath('src\\components\\App.tsx')).toBe('src/components/App.tsx')
      expect(normalizePath('C:\\Users\\project\\file.ts')).toBe('C:/Users/project/file.ts')
    })

    it('should remove trailing slashes', () => {
      expect(normalizePath('src/components/')).toBe('src/components')
      expect(normalizePath('src/components///')).toBe('src/components')
    })

    it('should handle mixed separators', () => {
      expect(normalizePath('src\\components/utils\\file.ts')).toBe('src/components/utils/file.ts')
    })

    it('should handle already normalized paths', () => {
      expect(normalizePath('src/components/App.tsx')).toBe('src/components/App.tsx')
    })

    it('should handle empty string', () => {
      expect(normalizePath('')).toBe('')
    })
  })

  describe('pathsEqual', () => {
    it('should match identical paths', () => {
      expect(pathsEqual('src/file.ts', 'src/file.ts')).toBe(true)
    })

    it('should match paths with different separators', () => {
      expect(pathsEqual('src\\file.ts', 'src/file.ts')).toBe(true)
    })

    it('should not match different paths', () => {
      expect(pathsEqual('src/file.ts', 'src/other.ts')).toBe(false)
    })

    it('should handle trailing slash differences', () => {
      expect(pathsEqual('src/dir/', 'src/dir')).toBe(true)
    })
  })

  describe('isChildPath', () => {
    it('should detect child paths', () => {
      expect(isChildPath('src', 'src/file.ts')).toBe(true)
      expect(isChildPath('src/components', 'src/components/App.tsx')).toBe(true)
    })

    it('should not match sibling paths', () => {
      expect(isChildPath('src', 'lib/file.ts')).toBe(false)
    })

    it('should not match parent as child of itself', () => {
      expect(isChildPath('src', 'src')).toBe(false)
    })

    it('should handle cross-platform separators', () => {
      expect(isChildPath('src\\components', 'src/components/App.tsx')).toBe(true)
    })

    it('should not match partial directory name matches', () => {
      expect(isChildPath('src', 'src2/file.ts')).toBe(false)
    })
  })
})

describe('GitService', () => {
  let gitService: GitService

  beforeEach(() => {
    gitService = GitService.getInstance()
    gitService.clearCache()
  })

  describe('getGitStatus', () => {
    it('returns empty array (git status not wired)', async () => {
      // getGitStatus() now returns an empty array until a Tauri-native implementation.
      const result = await gitService.getGitStatus()
      expect(result).toEqual([])
    })

    it('caches results', async () => {
      const result1 = await gitService.getGitStatus()
      const result2 = await gitService.getGitStatus()
      expect(result1).toEqual([])
      expect(result2).toEqual([])
    })
  })

  describe('getFileGitStatus', () => {
    it('returns null (no status data)', async () => {
      const result = await gitService.getFileGitStatus('test-file.txt')
      expect(result).toBeNull()
    })
  })

  describe('hasFileChanged', () => {
    it('returns false for all files (no status data)', async () => {
      const hasChanged = await gitService.hasFileChanged('any-file.js')
      expect(hasChanged).toBe(false)
    })
  })

  describe('getChangedFiles', () => {
    it('returns empty array (no status data)', async () => {
      const result = await gitService.getChangedFiles()
      expect(result).toEqual([])
    })
  })

  describe('getStatusColor', () => {
    it('应该返回正确的状态颜色', () => {
      expect(GitService.getStatusColor(GitStatus.MODIFIED)).toBe('text-yellow-500')
      expect(GitService.getStatusColor(GitStatus.ADDED)).toBe('text-green-500')
      expect(GitService.getStatusColor(GitStatus.DELETED)).toBe('text-red-500')
      expect(GitService.getStatusColor(GitStatus.UNTRACKED)).toBe('text-gray-500')
      expect(GitService.getStatusColor(GitStatus.STAGED)).toBe('text-blue-500')
    })
  })

  describe('getStatusIcon', () => {
    it('应该返回正确的状态图标', () => {
      expect(GitService.getStatusIcon(GitStatus.MODIFIED)).toBe('●')
      expect(GitService.getStatusIcon(GitStatus.ADDED)).toBe('+')
      expect(GitService.getStatusIcon(GitStatus.DELETED)).toBe('−')
      expect(GitService.getStatusIcon(GitStatus.UNTRACKED)).toBe('?')
      expect(GitService.getStatusIcon(GitStatus.STAGED)).toBe('✓')
    })
  })
})
