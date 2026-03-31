import React, { useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  File,
  Loader2,
  Circle,
  Pencil,
  Check,
  Terminal,
  FilePlus,
  FolderPlus,
  Trash2,
  Copy,
  CopyPlus,
  Scissors,
  ClipboardPaste,
  ExternalLink,
  MessageSquarePlus,
  AppWindow,
  History,
} from "lucide-react";

import { cn } from '@/lib/utils';
import { TEAM_REPO_DIR } from '@/lib/build-config';
import { useTeamModeStore } from '@/stores/team-mode';
import { useTabsStore } from '@/stores/tabs';
import { getFileIcon } from '@/lib/file-icons';
import { getGitStatusIndicator, getGitStatusTextColor } from '@/lib/git-status-utils';
import { GitStatus } from "@/lib/git/service";
import type { FileNode } from "@/stores/workspace";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";

function getSyncStatusTextColor(status: 'synced' | 'modified' | 'new'): string {
  switch (status) {
    case 'synced': return 'text-green-600'
    case 'modified': return 'text-orange-500'
    case 'new': return 'text-gray-400'
  }
}

// Inline editing input component
export function InlineInput({
  defaultValue,
  onConfirm,
  onCancel,
  level,
  icon,
}: {
  defaultValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  level: number;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmedRef = useRef(false);
  // Stable refs to avoid re-creating effects when parent re-renders
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);
  onConfirmRef.current = onConfirm;
  onCancelRef.current = onCancel;

  const doConfirm = useCallback(() => {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    const value = inputRef.current?.value.trim();
    if (value) onConfirmRef.current(value);
    else onCancelRef.current();
  }, []);

  // Focus and select on mount — retry until focused
  React.useEffect(() => {
    let cancelled = false;
    const tryFocus = (attempt: number) => {
      if (cancelled || confirmedRef.current) return;
      const input = inputRef.current;
      if (input) {
        input.scrollIntoView({ block: "nearest" });
        input.focus({ preventScroll: true });
        input.select();
        // Verify focus was acquired, retry if not (up to 10 attempts)
        if (document.activeElement !== input && attempt < 10) {
          setTimeout(() => tryFocus(attempt + 1), 50);
        }
      }
    };
    // Initial delay to let React settle after expandDirectory
    setTimeout(() => tryFocus(0), 50);
    return () => { cancelled = true; };
  }, []);

  // Click-outside detection: confirms when user clicks outside the input
  React.useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (confirmedRef.current) return;
      const input = inputRef.current;
      if (input && !input.contains(e.target as Node)) {
        doConfirm();
      }
    };
    // Delay registration so the context menu click that opened this doesn't trigger
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleMouseDown, true);
    }, 200);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleMouseDown, true);
    };
  }, [doConfirm]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      doConfirm();
    } else if (e.key === "Escape") {
      confirmedRef.current = true;
      onCancelRef.current();
    }
  };

  // No onBlur handler — focus loss is ignored entirely.
  // Confirmation only happens via: Enter, Escape, click-outside, or unmount.

  return (
    <div
      className="flex items-center gap-1 py-0.5 px-2 w-full"
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {icon}
      <input
        ref={inputRef}
        defaultValue={defaultValue}
        onKeyDown={handleKeyDown}
        className="inline-edit-input flex-1 bg-transparent border border-primary/50 rounded px-1 py-0 text-sm outline-none focus:border-primary min-w-0"
      />
    </div>
  );
}

export interface FileTreeItemProps {
  node: FileNode;
  level: number;
  isSelected: boolean;
  isFocused: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  hasGitChanges: boolean;
  gitStatus: GitStatus | null;
  showStatusIcons: boolean;
  statusColors: Record<GitStatus, string>;
  isRenaming: boolean;
  isDragOver: boolean;
  /** Whether this is the root teamclaw-team directory (for visual styling) */
  isTeamClawTeam?: boolean;
  /** OSS sync status for team files */
  syncStatus?: 'synced' | 'modified' | 'new' | null;
  compactName?: string;
  compactedPaths?: string[];
  onCollapseCompacted: (paths: string[]) => void;
  onSelectFile: (path: string) => void;
  onSelectFileRange: (path: string) => void; // Shift+Click range selection
  onToggleFileSelection: (path: string) => void; // Ctrl/Cmd+Click toggle
  onExpandDirectory: (path: string) => void;
  onCollapseDirectory: (path: string) => void;
  onNewFile: (dirPath: string) => void;
  onNewFolder: (dirPath: string) => void;
  onRename: (path: string) => void;
  onRenameConfirm: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  onDelete: (path: string, isDirectory: boolean) => void;
  onCopyPath: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onReveal: (path: string) => void;
  onOpenDefault: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onAddToAgent: (path: string) => void;
  onDragStart: (e: React.DragEvent, path: string) => void;
  onDragOver: (e: React.DragEvent, path: string) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent, targetPath: string) => void;
  onCut: (paths: string[]) => void;
  onCopy: (paths: string[]) => void;
  onPaste: (targetDir: string) => void;
  onDuplicate: (path: string) => void;
  hasClipboard: boolean;
  isClipboardCut: boolean;
  clipboardPaths: string[];
}

export const FileTreeItem = React.memo(function FileTreeItem({
  node,
  level,
  isSelected,
  isFocused,
  isExpanded,
  isLoading,
  hasGitChanges,
  gitStatus,
  showStatusIcons,
  statusColors,
  isRenaming,
  isDragOver,
  isTeamClawTeam,
  syncStatus,
  onSelectFile,
  onSelectFileRange,
  onToggleFileSelection,
  onExpandDirectory,
  onCollapseDirectory,
  onNewFile,
  onNewFolder,
  onRename,
  onRenameConfirm,
  onRenameCancel,
  onDelete,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  onOpenDefault,
  onOpenTerminal,
  onAddToAgent,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
  compactName,
  compactedPaths,
  onCollapseCompacted,
  onCut,
  onCopy,
  onPaste,
  onDuplicate,
  hasClipboard,
  isClipboardCut,
  clipboardPaths,
}: FileTreeItemProps) {
  const { t } = useTranslation();
  const isDirectory = node.type === "directory";
  const myRole = useTeamModeStore((s) => s.myRole)
  const isTeamFile = node.path.includes(`/${TEAM_REPO_DIR}/`)
  const isViewerRestricted = isTeamFile && myRole === 'viewer'
  const isCutTarget = clipboardPaths?.includes(node.path) && isClipboardCut;
  const displayName = compactName || node.name;

  const handleClick = (e: React.MouseEvent) => {
    if (isDirectory) {
      if (isExpanded) {
        if (compactedPaths && compactedPaths.length > 1) {
          onCollapseCompacted(compactedPaths);
        } else {
          onCollapseDirectory(node.path);
        }
      } else {
        onExpandDirectory(node.path);
      }
    } else {
      if (e.shiftKey) {
        onSelectFileRange(node.path);
      } else if (e.metaKey || e.ctrlKey) {
        onToggleFileSelection(node.path);
      } else {
        onSelectFile(node.path);
      }
    }
  };

  const fileIconInfo = !isDirectory ? getFileIcon(node.name) : null;
  const FileIcon = fileIconInfo?.icon || File;
  const fileIconColor = fileIconInfo?.color || "text-muted-foreground";

  if (isRenaming) {
    return (
      <InlineInput
        defaultValue={node.name}
        onConfirm={(newName) => onRenameConfirm(node.path, newName)}
        onCancel={onRenameCancel}
        level={level}
        icon={
          isDirectory ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rotate-90" />
          ) : (
            <FileIcon className={cn("h-4 w-4 shrink-0", fileIconColor)} />
          )
        }
      />
    );
  }

  const rowContent = (
    <button
      draggable
      onClick={handleClick}
      onDragStart={(e) => onDragStart(e, node.path)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => isDirectory ? onDragOver(e, node.path) : undefined}
      onDragLeave={(e) => isDirectory ? onDragLeave(e) : undefined}
      onDrop={(e) => isDirectory ? onDrop(e, node.path) : undefined}
      onContextMenu={(e) => {
        e.currentTarget.focus();
        window.getSelection()?.removeAllRanges();
      }}
      data-path={node.path}
      data-testid="file-tree-item"
      className={cn(
        "flex items-center gap-1 py-1 px-2 text-left text-sm hover:bg-primary/10 data-[state=open]:bg-primary/10 rounded transition-colors whitespace-nowrap w-full select-none",
        isSelected &&
          "bg-primary/20 text-primary font-medium ring-1 ring-primary/30",
        isFocused && !isSelected &&
          "ring-1 ring-primary/50 bg-primary/5",
        isDragOver && isDirectory &&
          "bg-primary/20 ring-2 ring-primary/40",
        hasGitChanges && !isSelected && !isFocused && "git-status-changed",
        isTeamClawTeam && !isSelected && !isFocused && "border-l border-blue-500/40",
        isCutTarget && "opacity-50",
      )}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      {isDirectory ? (
        <span className="w-4 h-4 flex items-center justify-center shrink-0">
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                isExpanded && "rotate-90",
              )}
            />
          )}
        </span>
      ) : (
        <FileIcon
          className={cn(
            "h-4 w-4 shrink-0",
            gitStatus
              ? getGitStatusTextColor(gitStatus, statusColors)
              : syncStatus
                ? getSyncStatusTextColor(syncStatus)
                : fileIconColor,
          )}
        />
      )}

      {isSelected && !isDirectory && (
        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
      )}

      <span
        className={cn(
          "pr-2 flex-1",
          gitStatus && getGitStatusTextColor(gitStatus, statusColors),
          !gitStatus && syncStatus && getSyncStatusTextColor(syncStatus),
          gitStatus === GitStatus.DELETED && "line-through opacity-70",
          hasGitChanges && isDirectory && "text-amber-500",
          !hasGitChanges && isDirectory && syncStatus && getSyncStatusTextColor(syncStatus),
        )}
      >
        {displayName}
      </span>

      {hasGitChanges &&
        !isDirectory &&
        (() => {
          if (showStatusIcons && gitStatus) {
            const {
              Icon: StatusIcon,
              color,
              label,
            } = getGitStatusIndicator(gitStatus, statusColors, t);
            return (
              <StatusIcon
                className={cn("h-3 w-3 shrink-0", color)}
                aria-label={label}
              />
            );
          }
          return null;
        })()}
      {hasGitChanges && isDirectory && (
        <Circle className="h-1.5 w-1.5 fill-amber-500 text-amber-500 shrink-0" />
      )}
    </button>
  );

  // Determine terminal path: for files, use parent directory
  const terminalPath = isDirectory
    ? node.path
    : node.path.substring(0, node.path.lastIndexOf("/"));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {isDirectory && !isViewerRestricted && (
          <>
            <ContextMenuItem onClick={() => onNewFile(node.path)}>
              <FilePlus className="h-4 w-4" />
              {t("fileExplorer.newFile", "New File")}
              <ContextMenuShortcut>⌘N</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onNewFolder(node.path)}>
              <FolderPlus className="h-4 w-4" />
              {t("fileExplorer.newFolder", "New Folder")}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={() => onAddToAgent(node.path)}>
          <MessageSquarePlus className="h-4 w-4" />
          {t("fileExplorer.addToAgent", "Add to Agent")}
        </ContextMenuItem>
        {!isDirectory && (
          <ContextMenuItem onClick={() => onOpenDefault(node.path)}>
            <AppWindow className="h-4 w-4" />
            {t("fileExplorer.openWithDefault", "Open with Default App")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCopyPath(node.path)}>
          <Copy className="h-4 w-4" />
          {t("fileExplorer.copyPath", "Copy Path")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopyRelativePath(node.path)}>
          <Copy className="h-4 w-4" />
          {t("fileExplorer.copyRelativePath", "Copy Relative Path")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCopy([node.path])}>
          <Copy className="h-4 w-4" />
          {t("fileExplorer.copyFile", "Copy")}
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        {!isViewerRestricted && (
          <ContextMenuItem onClick={() => onCut([node.path])}>
            <Scissors className="h-4 w-4" />
            {t("fileExplorer.cutFile", "Cut")}
            <ContextMenuShortcut>⌘X</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {!isViewerRestricted && hasClipboard && (
          <ContextMenuItem onClick={() => onPaste(
            isDirectory ? node.path : node.path.substring(0, node.path.lastIndexOf("/"))
          )}>
            <ClipboardPaste className="h-4 w-4" />
            {t("fileExplorer.pasteFile", "Paste")}
            <ContextMenuShortcut>⌘V</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {!isViewerRestricted && (
          <ContextMenuItem onClick={() => onDuplicate(node.path)}>
            <CopyPlus className="h-4 w-4" />
            {t("fileExplorer.duplicate", "Duplicate")}
            <ContextMenuShortcut>⌘D</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {!isDirectory && (
          <ContextMenuItem
            onClick={() => {
              useTabsStore.getState().openTab({
                type: "native",
                target: "version-history",
                label: "版本历史",
              })
            }}
          >
            <History className="h-4 w-4" />
            版本历史
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {!isViewerRestricted && (
          <ContextMenuItem onClick={() => onRename(node.path)}>
            <Pencil className="h-4 w-4" />
            {t("fileExplorer.rename", "Rename")}
            <ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {!isViewerRestricted && (
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDelete(node.path, isDirectory)}
          >
            <Trash2 className="h-4 w-4" />
            {t("fileExplorer.delete", "Delete")}
            <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onOpenTerminal(terminalPath)}>
          <Terminal className="h-4 w-4" />
          {t("fileExplorer.openInTerminal", "Open in Terminal")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onReveal(node.path)}>
          <ExternalLink className="h-4 w-4" />
          {t("fileExplorer.revealInFinder", "Reveal in Finder")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
