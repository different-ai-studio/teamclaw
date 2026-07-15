import {
  GitService,
  GitStatus,
  normalizePath,
  isChildPath,
  type GitFileStatus,
} from "@/lib/git/service";
import { useState, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useGitSettingsStore } from "@/stores/git-settings";
import { isTauri } from "@tauri-apps/api/core";
import { gitManager } from "@/lib/git/manager";
import { TEAM_REPO_DIR } from "@/lib/build-config";

function toGitStatus(status: string): GitStatus {
  switch (status) {
    case "modified": return GitStatus.MODIFIED;
    case "added": return GitStatus.ADDED;
    case "deleted": return GitStatus.DELETED;
    case "untracked": return GitStatus.UNTRACKED;
    case "renamed": return GitStatus.RENAMED;
    case "copied": return GitStatus.COPIED;
    case "staged": return GitStatus.STAGED;
    case "ignored": return GitStatus.IGNORED;
    default: return GitStatus.MODIFIED;
  }
}

/**
 * Git状态Hook - 管理文件树的Git状态显示
 */
export function useGitStatus() {
  const [gitStatuses, setGitStatuses] = useState<Map<string, GitFileStatus>>(
    new Map(),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspacePath = useWorkspaceStore(s => s.workspacePath);
  const pollingInterval = useGitSettingsStore(s => s.pollingInterval);
  const gitService = GitService.getInstance();

  /**
   * 获取Git状态
   */
  const loadGitStatus = useCallback(async () => {
    if (!workspacePath) {
      setGitStatuses(new Map());
      return;
    }

    setIsLoading(true);
    setError(null);

    const teamRepoPath = `${workspacePath}/${TEAM_REPO_DIR}`;
    const normalizedTeamRepo = normalizePath(teamRepoPath);

    try {
      const statusMap = new Map<string, GitFileStatus>();

      if (isTauri()) {
        const result = await gitManager.status(teamRepoPath);
        result.files.forEach((file) => {
          const statusPath = normalizePath(file.path);
          const absolutePath = statusPath.startsWith("/")
            ? statusPath
            : `${normalizedTeamRepo}/${statusPath}`;
          statusMap.set(absolutePath, {
            path: absolutePath,
            status: toGitStatus(file.status),
            staged: file.staged,
          });
        });
      } else {
        const statuses = await gitService.getGitStatus();
        const normalizedWorkspace = normalizePath(workspacePath);
        statuses.forEach((status) => {
          const statusPath = normalizePath(status.path);
          const absolutePath = statusPath.startsWith("/")
            ? statusPath
            : `${normalizedWorkspace}/${statusPath}`;
          if (absolutePath.startsWith(normalizedTeamRepo + "/")) {
            statusMap.set(absolutePath, { ...status, path: absolutePath });
          }
        });
      }

      // Only update state if the map actually changed, to avoid unnecessary re-renders
      setGitStatuses((prev) => {
        if (prev.size !== statusMap.size) return statusMap;
        for (const [key, val] of statusMap) {
          const existing = prev.get(key);
          if (
            !existing ||
            existing.status !== val.status ||
            existing.path !== val.path
          )
            return statusMap;
        }
        return prev; // identical — keep same reference, skip re-render
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load Git status";
      setError(errorMessage);
      console.error("[GitStatus] Error loading git status:", err);
      // 出错时清空状态，避免显示错误信息
      setGitStatuses(new Map());
    } finally {
      setIsLoading(false);
    }
  }, [workspacePath, gitService]);

  /**
   * 刷新Git状态
   */
  const refreshGitStatus = useCallback(async () => {
    gitService.clearCache();
    await loadGitStatus();
  }, [gitService, loadGitStatus]);

  /**
   * 获取文件的Git状态（跨平台路径规范化匹配）
   */
  const getFileGitStatus = useCallback(
    (filePath: string): GitFileStatus | null => {
      const normalized = normalizePath(filePath);
      return gitStatuses.get(normalized) || null;
    },
    [gitStatuses],
  );

  /**
   * 检查文件是否有变更
   */
  const hasFileChanged = useCallback(
    (filePath: string): boolean => {
      const status = getFileGitStatus(filePath);
      return (
        status !== null &&
        [
          GitStatus.MODIFIED,
          GitStatus.ADDED,
          GitStatus.DELETED,
          GitStatus.UNTRACKED,
          GitStatus.STAGED,
        ].includes(status.status)
      );
    },
    [getFileGitStatus],
  );

  /**
   * 获取文件状态样式
   */
  const getFileStatusStyle = useCallback(
    (
      filePath: string,
    ): {
      colorClass: string;
      icon?: string;
      isChanged: boolean;
    } => {
      const status = getFileGitStatus(filePath);

      if (!status) {
        return {
          colorClass: "",
          isChanged: false,
        };
      }

      return {
        colorClass: GitService.getStatusColor(status.status),
        icon: GitService.getStatusIcon(status.status),
        isChanged: true,
      };
    },
    [getFileGitStatus],
  );

  /**
   * 获取目录状态（检查是否包含变更的文件，跨平台路径匹配）
   */
  const getDirectoryStatus = useCallback(
    (
      dirPath: string,
    ): {
      hasChangedFiles: boolean;
      changedCount: number;
    } => {
      const normalizedDir = normalizePath(dirPath);
      let hasChangedFiles = false;
      let changedCount = 0;

      gitStatuses.forEach((status, path) => {
        if (isChildPath(normalizedDir, path) || path === normalizedDir) {
          if (
            [
              GitStatus.MODIFIED,
              GitStatus.ADDED,
              GitStatus.DELETED,
              GitStatus.UNTRACKED,
              GitStatus.STAGED,
            ].includes(status.status)
          ) {
            hasChangedFiles = true;
            changedCount++;
          }
        }
      });

      return { hasChangedFiles, changedCount };
    },
    [gitStatuses],
  );

  // 加载Git状态
  useEffect(() => {
    loadGitStatus();
  }, [loadGitStatus]);

  // 定期刷新Git状态（可配置间隔）
  useEffect(() => {
    if (!workspacePath) return;

    const interval = setInterval(() => {
      loadGitStatus();
    }, pollingInterval);

    return () => clearInterval(interval);
  }, [workspacePath, loadGitStatus, pollingInterval]);

  return {
    gitStatuses,
    isLoading,
    error,
    loadGitStatus,
    refreshGitStatus,
    getFileGitStatus,
    hasFileChanged,
    getFileStatusStyle,
    getDirectoryStatus,
  };
}
