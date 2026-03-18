import { GitService } from '@/lib/git/service'

// 简单的事件发射器实现
class SimpleEventEmitter {
  private listeners: Map<string, Function[]> = new Map()

  on(event: string, listener: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, [])
    }
    this.listeners.get(event)!.push(listener)
  }

  emit(event: string, ...args: any[]): void {
    const eventListeners = this.listeners.get(event)
    if (eventListeners) {
      eventListeners.forEach(listener => listener(...args))
    }
  }

  off(event: string, listener: Function): void {
    const eventListeners = this.listeners.get(event)
    if (eventListeners) {
      const index = eventListeners.indexOf(listener)
      if (index > -1) {
        eventListeners.splice(index, 1)
      }
    }
  }
}

/**
 * Git状态管理器 - 提供Git状态的实时更新和事件通知
 */
export class GitStatusManager extends SimpleEventEmitter {
  private static instance: GitStatusManager
  private gitService: GitService
  private updateInterval: ReturnType<typeof setInterval> | null = null
  private fileWatchers: Map<string, number> = new Map()
  private isUpdating = false
  private lastUpdate = 0
  private readonly UPDATE_INTERVAL = 30000 // 30秒轮询间隔
  private readonly MIN_UPDATE_INTERVAL = 2000 // 2秒最小更新间隔

  private constructor() {
    super()
    this.gitService = GitService.getInstance()
  }

  static getInstance(): GitStatusManager {
    if (!GitStatusManager.instance) {
      GitStatusManager.instance = new GitStatusManager()
    }
    return GitStatusManager.instance
  }

  /**
   * 开始Git状态监控
   */
  startMonitoring(): void {
    if (this.updateInterval) {
      return // 已经在监控中
    }

    // 立即执行一次更新
    this.updateGitStatus()

    // 设置定时更新
    this.updateInterval = setInterval(() => {
      this.updateGitStatus()
    }, this.UPDATE_INTERVAL)
  }

  /**
   * 停止Git状态监控
   */
  stopMonitoring(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
    }
  }

  /**
   * 立即更新Git状态
   */
  async updateGitStatus(): Promise<void> {
    // 防止重复更新
    if (this.isUpdating) {
      return
    }

    // 检查最小更新间隔
    const now = Date.now()
    if (now - this.lastUpdate < this.MIN_UPDATE_INTERVAL) {
      return
    }

    this.isUpdating = true
    this.lastUpdate = now

    try {
      // 清除缓存
      this.gitService.clearCache()
      
      // 触发更新事件
      this.emit('status-updating')
      
      // 获取更新后的Git状态
      const statuses = await this.gitService.getGitStatus()
      
      // 触发更新完成事件
      this.emit('status-updated', statuses)
      
    } catch (error) {
      console.error('Git status update failed:', error)
      this.emit('status-error', error)
    } finally {
      this.isUpdating = false
    }
  }

  /**
   * 注册文件变更监听
   */
  registerFileChange(filePath: string): void {
    const currentCount = this.fileWatchers.get(filePath) || 0
    this.fileWatchers.set(filePath, currentCount + 1)
    
    // 如果是第一次注册，延迟执行更新
    if (currentCount === 0) {
      setTimeout(() => {
        this.updateGitStatus()
      }, 500) // 500ms延迟，避免频繁更新
    }
  }

  /**
   * 取消文件变更监听
   */
  unregisterFileChange(filePath: string): void {
    const currentCount = this.fileWatchers.get(filePath) || 0
    if (currentCount <= 1) {
      this.fileWatchers.delete(filePath)
    } else {
      this.fileWatchers.set(filePath, currentCount - 1)
    }
  }

  /**
   * 处理文件系统事件
   */
  handleFileSystemEvent(eventType: string, filePath: string): void {
    // 只处理我们关心的文件事件
    if (eventType === 'change' || eventType === 'create' || eventType === 'delete') {
      this.registerFileChange(filePath)
    }
  }

  /**
   * 获取当前的监控状态
   */
  getMonitoringStatus(): {
    isMonitoring: boolean
    isUpdating: boolean
    lastUpdate: number
    watchedFiles: number
  } {
    return {
      isMonitoring: this.updateInterval !== null,
      isUpdating: this.isUpdating,
      lastUpdate: this.lastUpdate,
      watchedFiles: this.fileWatchers.size
    }
  }
}

// 事件类型定义
export interface GitStatusEvents {
  'status-updating': () => void
  'status-updated': (statuses: import('@/lib/git/service').GitFileStatus[]) => void
  'status-error': (error: unknown) => void
}

// 导出单例实例
export const gitStatusManager = GitStatusManager.getInstance()