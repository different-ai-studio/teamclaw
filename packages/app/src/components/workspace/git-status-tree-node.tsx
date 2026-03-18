import { useGitStatus } from '@/hooks/use-git-status'
import { GitStatus } from '@/lib/git/service'
import { cn } from '@/lib/utils'
import { useEffect } from 'react'

/**
 * Git状态增强的文件树节点组件
 * 为文件树节点添加Git状态显示功能
 */
interface GitStatusTreeNodeProps {
  filePath: string
  isDirectory: boolean
  children: React.ReactNode
  className?: string
  onStatusChange?: (hasGitChanges: boolean) => void
}

export function GitStatusTreeNode({ 
  filePath, 
  isDirectory, 
  children, 
  className,
  onStatusChange 
}: GitStatusTreeNodeProps) {
  const { getFileStatusStyle, getDirectoryStatus } = useGitStatus()
  
  // 获取Git状态样式
  const statusStyle = getFileStatusStyle(filePath)
  const dirStatus = isDirectory ? getDirectoryStatus(filePath) : null
  
  // 确定是否有Git变更
  const hasGitChanges = isDirectory 
    ? (dirStatus?.hasChangedFiles ?? false)
    : statusStyle.isChanged
  
  // 通知父组件状态变化
  useEffect(() => {
    onStatusChange?.(hasGitChanges)
  }, [hasGitChanges, onStatusChange])
  
  // 构建样式类名
  const nodeClassName = cn(
    className,
    hasGitChanges && 'git-status-changed',
    !isDirectory && statusStyle.colorClass && `${statusStyle.colorClass} git-status-${statusStyle.colorClass.replace('text-', '')}`,
    isDirectory && dirStatus?.hasChangedFiles && 'git-status-directory-changed'
  )
  
  return (
    <div className={nodeClassName} data-git-status={hasGitChanges ? 'changed' : 'unchanged'}>
      {children}
      {/* Git状态指示器 */}
      {hasGitChanges && (
        <GitStatusIndicator 
          isDirectory={isDirectory}
          statusStyle={statusStyle}
          dirStatus={dirStatus}
        />
      )}
    </div>
  )
}

/**
 * Git状态指示器组件
 */
interface GitStatusIndicatorProps {
  isDirectory: boolean
  statusStyle: {
    colorClass: string
    icon?: string
    isChanged: boolean
  }
  dirStatus?: {
    hasChangedFiles: boolean
    changedCount: number
  } | null
}

function GitStatusIndicator({ isDirectory, statusStyle, dirStatus }: GitStatusIndicatorProps) {
  if (isDirectory) {
    return (
      <span className="git-status-indicator-directory" title={`${dirStatus?.changedCount || 0} changed files`}>
        {dirStatus?.changedCount && dirStatus.changedCount > 1 ? (
          <span className="git-status-count">{dirStatus.changedCount}</span>
        ) : (
          <span className="git-status-dot" />
        )}
      </span>
    )
  }
  
  return (
    <span className="git-status-indicator-file" title={`Git: ${statusStyle.colorClass.replace('text-', '')}`}>
      {statusStyle.icon && <span className="git-status-icon">{statusStyle.icon}</span>}
      <span className="git-status-dot" />
    </span>
  )
}

/**
 * 增强的文件树样式
 */
export function getGitStatusTreeStyles() {
  return `
    /* Git状态指示器基础样式 */
    .git-status-indicator-file,
    .git-status-indicator-directory {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 4px;
      font-size: 10px;
      line-height: 1;
    }
    
    .git-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: currentColor;
      opacity: 0.8;
    }
    
    .git-status-icon {
      margin-right: 2px;
      font-weight: bold;
    }
    
    .git-status-count {
      font-size: 9px;
      font-weight: bold;
      padding: 1px 3px;
      border-radius: 2px;
      background-color: currentColor;
      color: white;
      min-width: 12px;
      text-align: center;
    }
    
    /* Git状态颜色样式 */
    .git-status-yellow-500 { color: #eab308 !important; }
    .git-status-green-500 { color: #22c55e !important; }
    .git-status-red-500 { color: #ef4444 !important; }
    .git-status-gray-500 { color: #6b7280 !important; }
    .git-status-blue-500 { color: #3b82f6 !important; }
    .git-status-purple-500 { color: #a855f7 !important; }
    
    /* 变更文件高亮 */
    .git-status-changed {
      position: relative;
    }
    
    .git-status-directory-changed {
      font-weight: 500;
    }
    
    /* 文件树节点悬停效果 */
    .git-status-changed:hover {
      background-color: rgba(234, 179, 8, 0.1) !important;
    }
    
    /* 暗色主题适配 */
    @media (prefers-color-scheme: dark) {
      .git-status-changed:hover {
        background-color: rgba(234, 179, 8, 0.2) !important;
      }
    }
  `
}

/**
 * 辅助函数：获取Git状态的显示文本
 */
export function getGitStatusText(status: GitStatus): string {
  switch (status) {
    case GitStatus.MODIFIED:
      return '已修改'
    case GitStatus.ADDED:
      return '已添加'
    case GitStatus.DELETED:
      return '已删除'
    case GitStatus.UNTRACKED:
      return '未跟踪'
    case GitStatus.STAGED:
      return '已暂存'
    case GitStatus.RENAMED:
      return '重命名'
    case GitStatus.COPIED:
      return '已复制'
    case GitStatus.IGNORED:
      return '已忽略'
    default:
      return '未知状态'
  }
}