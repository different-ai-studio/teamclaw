// Test file - vitest globals (describe, it, expect) provided by vitest/globals type config
import { vi } from 'vitest'
import { GitService, GitStatus, normalizePath, pathsEqual, isChildPath } from '../service'
import { getOpenCodeClient } from '@/lib/opencode/client'

const { mockGetOpenCodeClient } = vi.hoisted(() => ({
  mockGetOpenCodeClient: vi.fn(),
}))

vi.mock('@/lib/opencode/client', () => ({
  getOpenCodeClient: mockGetOpenCodeClient,
}))

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
  let mockClient: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockClient = {
      getFileStatus: vi.fn(),
    }
    vi.mocked(getOpenCodeClient).mockReturnValue(mockClient)
    gitService = GitService.getInstance()
    gitService.clearCache()
  })

  describe('getGitStatus', () => {
    it('应该成功获取Git状态', async () => {
      mockClient.getFileStatus.mockResolvedValue([
        { path: 'modified-file.js', status: 'modified' },
        { path: 'new-file.txt', status: 'untracked' },
        { path: 'another-new.js', status: 'untracked' },
      ])

      const result = await gitService.getGitStatus()

      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({
        path: 'modified-file.js',
        status: GitStatus.MODIFIED,
        staged: false
      })
      expect(result[1]).toEqual({
        path: 'new-file.txt',
        status: GitStatus.UNTRACKED,
        staged: false
      })
      expect(result[2]).toEqual({
        path: 'another-new.js',
        status: GitStatus.UNTRACKED,
        staged: false
      })
    })

    it('应该处理非Git仓库的情况', async () => {
      mockClient.getFileStatus.mockRejectedValue(new Error('Not a Git repository'))

      await expect(gitService.getGitStatus()).rejects.toThrow('Git status query failed: Not a Git repository')
    })

    it('应该缓存结果', async () => {
      mockClient.getFileStatus.mockResolvedValue([
        { path: 'file1.txt', status: 'untracked' },
      ])

      const result1 = await gitService.getGitStatus()
      expect(result1).toHaveLength(1)
      
      const result2 = await gitService.getGitStatus()
      expect(result2).toHaveLength(1)
      expect(result2).toEqual(result1)
      
      expect(mockClient.getFileStatus).toHaveBeenCalledTimes(1)
    })

    it('应该处理API错误', async () => {
      mockClient.getFileStatus.mockRejectedValue(new Error('Network error'))

      await expect(gitService.getGitStatus()).rejects.toThrow('Git status query failed: Network error')
    })
  })

  describe('getFileGitStatus', () => {
    it('应该返回指定文件的状态', async () => {
      mockClient.getFileStatus.mockResolvedValue([
        { path: 'test-file.txt', status: 'untracked' },
      ])

      const result = await gitService.getFileGitStatus('test-file.txt')

      expect(result).toEqual({
        path: 'test-file.txt',
        status: GitStatus.UNTRACKED,
        staged: false
      })
    })

    it('应该返回null当文件没有状态时', async () => {
      mockClient.getFileStatus.mockResolvedValue([
        { path: 'other-file.txt', status: 'untracked' },
      ])

      const result = await gitService.getFileGitStatus('non-existent-file.txt')

      expect(result).toBeNull()
    })
  })

  describe('hasFileChanged', () => {
    it('应该正确判断文件是否有变更', async () => {
      mockClient.getFileStatus.mockResolvedValue([
        { path: 'modified-file.js', status: 'modified' },
        { path: 'new-file.txt', status: 'untracked' },
      ])

      const hasChanged1 = await gitService.hasFileChanged('modified-file.js')
      const hasChanged2 = await gitService.hasFileChanged('new-file.txt')
      const hasChanged3 = await gitService.hasFileChanged('unchanged-file.txt')

      expect(hasChanged1).toBe(true)
      expect(hasChanged2).toBe(true)
      expect(hasChanged3).toBe(false)
    })
  })

  describe('getChangedFiles', () => {
    it('应该返回所有变更的文件', async () => {
      mockClient.getFileStatus.mockResolvedValue([
        { path: 'modified-file.js', status: 'modified' },
        { path: 'new-file.txt', status: 'untracked' },
      ])

      const result = await gitService.getChangedFiles()

      expect(result).toHaveLength(2)
      expect(result[0].path).toBe('modified-file.js')
      expect(result[1].path).toBe('new-file.txt')
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