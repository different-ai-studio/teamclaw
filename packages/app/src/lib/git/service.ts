import { getOpenCodeClient } from '@/lib/opencode/sdk-client'

/**
 * 跨平台路径规范化工具
 * 将Windows反斜杠路径统一为正斜杠，移除尾部斜杠
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/g, '')
}

/**
 * 跨平台路径比较 - 忽略路径分隔符差异
 */
export function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

/**
 * 检查 child 路径是否在 parent 目录下
 */
export function isChildPath(parent: string, child: string): boolean {
  const normalizedParent = normalizePath(parent)
  const normalizedChild = normalizePath(child)
  return normalizedChild.startsWith(normalizedParent + '/')
}

export interface GitFileStatus {
  path: string
  status: GitStatus
  staged: boolean
}

export enum GitStatus {
  MODIFIED = 'modified',
  ADDED = 'added',
  DELETED = 'deleted',
  UNTRACKED = 'untracked',
  STAGED = 'staged',
  RENAMED = 'renamed',
  COPIED = 'copied',
  IGNORED = 'ignored'
}

export interface GitStatusOptions {
  includeIgnored?: boolean
  includeUntracked?: boolean
}

/**
 * Git服务模块 - 封装Git相关操作
 * 遵循项目架构，通过OpenCode服务器API获取Git状态
 */
export class GitService {
  private static instance: GitService
  private statusCache: Map<string, { data: GitFileStatus[]; timestamp: number }> = new Map()
  private readonly CACHE_TTL = 2000 // 2秒缓存
  // private readonly MAX_RETRIES = 3 // 预留用于未来扩展
  // private readonly TIMEOUT = 10000 // 10秒超时 - 预留用于未来扩展

  private constructor() {}

  static getInstance(): GitService {
    if (!GitService.instance) {
      GitService.instance = new GitService()
    }
    return GitService.instance
  }

  /**
   * 获取Git状态信息
   */
  async getGitStatus(options: GitStatusOptions = {}): Promise<GitFileStatus[]> {
    const cacheKey = JSON.stringify(options)
    const cached = this.statusCache.get(cacheKey)
    
    // 检查缓存
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data
    }

    try {
      const client = getOpenCodeClient()

      // 直接获取文件状态（无需先检查项目git信息）
      const fileStatus = await client.getFileStatus()
      console.log('[GitService] Raw API /file/status response:', JSON.stringify(fileStatus))
      
      // 转换为统一的Git状态格式
      const gitStatuses = this.convertToGitStatuses(fileStatus, options)
      console.log('[GitService] Converted statuses:', gitStatuses)
      
      // 缓存结果
      this.statusCache.set(cacheKey, {
        data: gitStatuses,
        timestamp: Date.now()
      })
      
      return gitStatuses
    } catch (error) {
      console.error('Failed to get Git status:', error)
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Git status query failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * 获取指定文件或目录的Git状态
   */
  async getFileGitStatus(filePath: string): Promise<GitFileStatus | null> {
    const allStatuses = await this.getGitStatus()
    return allStatuses.find(status => status.path === filePath) || null
  }

  /**
   * 检查文件是否有变更
   */
  async hasFileChanged(filePath: string): Promise<boolean> {
    const fileStatus = await this.getFileGitStatus(filePath)
    return fileStatus !== null && this.isChangedStatus(fileStatus.status)
  }

  /**
   * 获取变更的文件列表
   */
  async getChangedFiles(): Promise<GitFileStatus[]> {
    const allStatuses = await this.getGitStatus()
    return allStatuses.filter(status => this.isChangedStatus(status.status))
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.statusCache.clear()
  }

  /**
   * 将API文件状态映射到GitStatus枚举
   */
  private mapApiStatus(status: string): GitStatus {
    switch (status) {
      case 'modified': return GitStatus.MODIFIED
      case 'added': return GitStatus.ADDED
      case 'deleted': return GitStatus.DELETED
      case 'untracked': return GitStatus.UNTRACKED
      case 'renamed': return GitStatus.RENAMED
      case 'copied': return GitStatus.COPIED
      default: return GitStatus.MODIFIED
    }
  }

  /**
   * 将API响应转换为统一的Git状态格式
   * getFileStatus() returns Array<{ path, added, removed, status: 'added' | 'deleted' | 'modified' }>
   */
  private convertToGitStatuses(
    fileStatus: any, 
    _options: GitStatusOptions
  ): GitFileStatus[] {
    const statuses: GitFileStatus[] = []

    // Handle array response from /file/status API
    if (Array.isArray(fileStatus)) {
      fileStatus.forEach((file: { path: string; status: string; added?: number; removed?: number }) => {
        statuses.push({
          path: normalizePath(file.path),
          status: this.mapApiStatus(file.status),
          staged: false
        })
      })
    }

    return statuses
  }

  /**
   * 判断是否为变更状态
   */
  private isChangedStatus(status: GitStatus): boolean {
    return [
      GitStatus.MODIFIED,
      GitStatus.ADDED,
      GitStatus.DELETED,
      GitStatus.UNTRACKED,
      GitStatus.STAGED,
      GitStatus.RENAMED,
      GitStatus.COPIED
    ].includes(status)
  }

  /**
   * 获取Git状态对应的颜色
   */
  static getStatusColor(status: GitStatus): string {
    switch (status) {
      case GitStatus.MODIFIED:
        return 'text-yellow-500' // 黄色/橙色
      case GitStatus.ADDED:
        return 'text-green-500' // 绿色
      case GitStatus.DELETED:
        return 'text-red-500' // 红色
      case GitStatus.UNTRACKED:
        return 'text-gray-500' // 灰色
      case GitStatus.STAGED:
        return 'text-blue-500' // 蓝色
      case GitStatus.RENAMED:
        return 'text-purple-500' // 紫色
      case GitStatus.COPIED:
        return 'text-cyan-500' // 青色
      case GitStatus.IGNORED:
        return 'text-muted-foreground' // 默认颜色
      default:
        return 'text-muted-foreground'
    }
  }

  /**
   * 获取Git状态对应的图标
   */
  static getStatusIcon(status: GitStatus): string {
    switch (status) {
      case GitStatus.MODIFIED:
        return '●' // 圆点
      case GitStatus.ADDED:
        return '+' // 加号
      case GitStatus.DELETED:
        return '−' // 减号
      case GitStatus.UNTRACKED:
        return '?' // 问号
      case GitStatus.STAGED:
        return '✓' // 对勾
      case GitStatus.RENAMED:
        return '→' // 箭头
      case GitStatus.COPIED:
        return '©' // 复制符号
      case GitStatus.IGNORED:
        return '!' // 感叹号
      default:
        return ''
    }
  }
}

// 导出单例实例
export const gitService = GitService.getInstance()