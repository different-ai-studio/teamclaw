import React, { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, File } from "lucide-react";

import { toast } from 'sonner';
import { copyToClipboard, isTauri } from '@/lib/utils';
import { GitStatus } from "@/lib/git/service";
import { useWorkspaceStore, type FileNode } from "@/stores/workspace";
import { useGitStatus } from "@/hooks/use-git-status";
import { useGitSettingsStore } from "@/stores/git-settings";
import { useTeamOssStore } from "@/stores/team-oss";
import { useTeamModeStore } from "@/stores/team-mode";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FileTreeItem, InlineInput } from "./FileTreeNode";
import {
  createNewFile,
  createNewFolder,
  renameItem,
  deleteItem,
  revealInFinder,
  openWithDefaultApp,
  openInTerminal,
  moveItem,
  copyItem,
  duplicateItem,
  readFileContent,
} from "./file-tree-operations";
import { TEAM_REPO_DIR, appShortName } from "@/lib/build-config";

// Flattened tree node for virtualization
interface FlatTreeNode {
  node: FileNode;
  level: number;
  /** Display name for compact folders, e.g. "src/main/java" */
  compactName?: string;
  /** All directory paths in a compacted chain (for collapsing all at once) */
  compactedPaths?: string[];
}

// Filter tree nodes recursively based on filter text.
// Returns { nodes, autoExpandPaths } where autoExpandPaths contains
// directories that should be auto-expanded because they have matching children.
function filterTree(
  nodes: FileNode[],
  filterText: string,
  autoExpandPaths: Set<string> = new Set(),
): { nodes: FileNode[]; autoExpandPaths: Set<string> } {
  if (!filterText.trim()) {
    return { nodes, autoExpandPaths };
  }

  const lowerFilter = filterText.toLowerCase();
  const filtered: FileNode[] = [];

  for (const node of nodes) {
    const matchesFilter = node.name.toLowerCase().includes(lowerFilter);

    // If it's a directory, check if any children match
    let matchingChildren: FileNode[] = [];
    if (node.type === "directory" && node.children) {
      const result = filterTree(node.children, filterText, autoExpandPaths);
      matchingChildren = result.nodes;
    }

    // Include node if:
    // 1. The node itself matches, OR
    // 2. It's a directory with matching children
    if (matchesFilter || matchingChildren.length > 0) {
      if (matchingChildren.length > 0) {
        // Auto-expand directories that have matching children
        autoExpandPaths.add(node.path);
        filtered.push({
          ...node,
          children: matchingChildren,
        });
      } else {
        filtered.push(node);
      }
    }
  }

  return { nodes: filtered, autoExpandPaths };
}

/**
 * Build a complete file tree from git-changed file paths.
 * This is used instead of filtering the lazy-loaded file tree,
 * because unexpanded directories wouldn't contain their changed files.
 */
function buildGitChangedTree(
  changedPaths: Set<string>,
  workspacePath: string,
): { nodes: FileNode[]; autoExpandPaths: Set<string> } {
  if (changedPaths.size === 0 || !workspacePath)
    return { nodes: [], autoExpandPaths: new Set() };

  const normalizedWorkspace = workspacePath.replace(/\\/g, "/");

  // Build a nested map: relative path segments -> file entries
  interface TreeEntry {
    children: Map<string, TreeEntry>;
    isFile: boolean;
    absolutePath: string;
  }

  const root: TreeEntry = {
    children: new Map(),
    isFile: false,
    absolutePath: normalizedWorkspace,
  };

  for (const absPath of changedPaths) {
    const normalized = absPath.replace(/\\/g, "/");
    // Get relative path from workspace
    if (!normalized.startsWith(normalizedWorkspace + "/")) continue;
    const relativePath = normalized.slice(normalizedWorkspace.length + 1);
    const segments = relativePath.split("/");

    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!current.children.has(seg)) {
        const partialPath =
          normalizedWorkspace + "/" + segments.slice(0, i + 1).join("/");
        current.children.set(seg, {
          children: new Map(),
          isFile: i === segments.length - 1,
          absolutePath: partialPath,
        });
      }
      current = current.children.get(seg)!;
    }
  }

  // Convert the nested map into FileNode[], collecting directory paths to auto-expand
  const autoExpandPaths = new Set<string>();
  function toFileNodes(entry: TreeEntry): FileNode[] {
    const nodes: FileNode[] = [];
    const sorted = [...entry.children.entries()].sort(
      ([aName, aEntry], [bName, bEntry]) => {
        // Directories first, then files
        if (!aEntry.isFile && bEntry.isFile) return -1;
        if (aEntry.isFile && !bEntry.isFile) return 1;
        return aName.localeCompare(bName);
      },
    );

    for (const [name, child] of sorted) {
      if (child.isFile) {
        nodes.push({
          name,
          path: child.absolutePath,
          type: "file",
        });
      } else {
        autoExpandPaths.add(child.absolutePath);
        nodes.push({
          name,
          path: child.absolutePath,
          type: "directory",
          children: toFileNodes(child),
        });
      }
    }
    return nodes;
  }

  return { nodes: toFileNodes(root), autoExpandPaths };
}

// Flatten the recursive tree into a flat list of visible nodes
function flattenTree(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  level: number = 0,
  result: FlatTreeNode[] = [],
): FlatTreeNode[] {
  for (const node of nodes) {
    if (node.type === "directory" && expandedPaths.has(node.path) && node.children) {
      // Check for compact folder chain: single directory child only
      let current = node;
      const nameParts = [current.name];
      const chainPaths = [current.path];

      while (
        current.children &&
        current.children.length === 1 &&
        current.children[0].type === "directory" &&
        expandedPaths.has(current.children[0].path)
      ) {
        current = current.children[0];
        nameParts.push(current.name);
        chainPaths.push(current.path);
      }

      if (nameParts.length > 1) {
        result.push({
          node: current,
          level,
          compactName: nameParts.join("/"),
          compactedPaths: chainPaths,
        });
      } else {
        result.push({ node, level });
      }

      if (current.children) {
        flattenTree(current.children, expandedPaths, level + 1, result);
      }
    } else {
      result.push({ node, level });
      if (
        node.type === "directory" &&
        expandedPaths.has(node.path) &&
        node.children
      ) {
        flattenTree(node.children, expandedPaths, level + 1, result);
      }
    }
  }
  return result;
}

// Row height in pixels (matches py-1 + text-sm line-height)
const ROW_HEIGHT = 28;


// File operations imported from ./file-tree-operations

// FileTreeItem and InlineInput imported from ./FileTreeNode

// Threshold for enabling virtual scrolling
const VIRTUAL_SCROLL_THRESHOLD = 200;

interface FileTreeProps {
  filterText?: string;
  gitChangedOnly?: boolean;
  /** Override tree nodes (e.g. for custom root). When provided, bypasses workspace store's fileTree. */
  nodes?: import('@/stores/workspace').FileNode[];
  /** Suppress git status decorations */
  hideGitStatus?: boolean;
}

export function FileTree({
  filterText = "",
  gitChangedOnly = false,
  nodes: nodesProp,
  hideGitStatus = false,
}: FileTreeProps) {
  const { t } = useTranslation();
  const storeFileTree = useWorkspaceStore(s => s.fileTree);
  const fileTree = nodesProp ?? storeFileTree;
  const expandedPaths = useWorkspaceStore(s => s.expandedPaths);
  const loadingPaths = useWorkspaceStore(s => s.loadingPaths);
  const selectedFile = useWorkspaceStore(s => s.selectedFile);
  const selectedFiles = useWorkspaceStore(s => s.selectedFiles);
  const workspacePath = useWorkspaceStore(s => s.workspacePath);
  const focusedPath = useWorkspaceStore(s => s.focusedPath);
  const selectFile = useWorkspaceStore(s => s.selectFile);
  const selectFileRange = useWorkspaceStore(s => s.selectFileRange);
  const toggleFileSelection = useWorkspaceStore(s => s.toggleFileSelection);
  const expandDirectory = useWorkspaceStore(s => s.expandDirectory);
  const collapseDirectory = useWorkspaceStore(s => s.collapseDirectory);
  const setFocusedPath = useWorkspaceStore(s => s.setFocusedPath);
  const pushUndo = useWorkspaceStore(s => s.pushUndo);
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree);
  const revealFile = useWorkspaceStore(s => s.revealFile);
  const clipboardPaths = useWorkspaceStore(s => s.clipboardPaths);
  const clipboardMode = useWorkspaceStore(s => s.clipboardMode);
  const setClipboard = useWorkspaceStore(s => s.setClipboard);
  const pasteFiles = useWorkspaceStore(s => s.pasteFiles);

  const { gitStatuses } = useGitStatus();
  const { showGitStatus, showStatusIcons, statusColors } =
    useGitSettingsStore();
  const effectiveShowGitStatus = hideGitStatus ? false : showGitStatus;
  const parentRef = useRef<HTMLDivElement>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);

  // Memoize selectedFiles as a Set for O(1) lookup
  const selectedFilesSet = useMemo(
    () => new Set(selectedFiles),
    [selectedFiles],
  );

  // Inline editing state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<{
    dirPath: string;
    type: "file" | "folder";
  } | null>(null);

  // Delete confirmation dialog state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    path: string;
    name: string;
    isDirectory: boolean;
    isBatch: boolean;
    count: number;
  } | null>(null);

  // Drag-and-drop state
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [dragSourcePath, setDragSourcePath] = useState<string | null>(null);
  const dragOverPathRef = useRef<string | null>(null);
  useEffect(() => { dragOverPathRef.current = dragOverPath; }, [dragOverPath]);
  const pushUndoRef = useRef(pushUndo);
  useEffect(() => { pushUndoRef.current = pushUndo; }, [pushUndo]);

  // Pre-compute git data
  const { fileGitStatusMap, dirtyDirectories } = useMemo(() => {
    if (!effectiveShowGitStatus) {
      return {
        fileGitStatusMap: new Map<string, GitStatus>(),
        dirtyDirectories: new Set<string>(),
      };
    }
    const fileMap = new Map<string, GitStatus>();
    const dirtyDirs = new Set<string>();
    const wpLen = workspacePath?.length || 0;

    gitStatuses.forEach((status, path) => {
      fileMap.set(path, status.status);
      let dir = path.substring(0, path.lastIndexOf("/"));
      while (dir && dir.length > wpLen) {
        if (dirtyDirs.has(dir)) break;
        dirtyDirs.add(dir);
        dir = dir.substring(0, dir.lastIndexOf("/"));
      }
    });

    return { fileGitStatusMap: fileMap, dirtyDirectories: dirtyDirs };
  }, [effectiveShowGitStatus, gitStatuses, workspacePath]);

  // Pre-compute sync status data for team files (merge OSS and P2P sources)
  const ossFileSyncStatusMap = useTeamOssStore(s => s.fileSyncStatusMap);
  const p2pFileSyncStatusMap = useTeamModeStore(s => s.p2pFileSyncStatusMap);
  const p2pConnected = useTeamModeStore(s => s.p2pConnected);
  const fileSyncStatusMap = p2pConnected ? p2pFileSyncStatusMap : ossFileSyncStatusMap;
  const syncDirtyDirectories = useMemo(() => {
    const dirtyDirs = new Map<string, 'synced' | 'modified' | 'new'>();
    if (!workspacePath) return dirtyDirs;

    for (const [relPath, status] of Object.entries(fileSyncStatusMap)) {
      if (status === 'synced') continue;
      // Build absolute path and propagate to parent directories
      const absPath = `${workspacePath}/${TEAM_REPO_DIR}/${relPath}`;
      let dir = absPath.substring(0, absPath.lastIndexOf("/"));
      while (dir && dir.length > workspacePath.length) {
        const existing = dirtyDirs.get(dir);
        // modified > new > synced priority
        if (!existing || (status === 'modified' && existing === 'new')) {
          dirtyDirs.set(dir, status);
        }
        dir = dir.substring(0, dir.lastIndexOf("/"));
      }
    }
    return dirtyDirs;
  }, [fileSyncStatusMap, workspacePath]);

  const collapseCompacted = useCallback((paths: string[]) => {
    const nextExpanded = new Set(useWorkspaceStore.getState().expandedPaths);
    for (const p of paths) {
      nextExpanded.delete(p);
    }
    useWorkspaceStore.setState({ expandedPaths: nextExpanded });
  }, []);

  // Context menu action handlers
  const handleNewFile = useCallback(
    async (dirPath: string) => {
      await expandDirectory(dirPath);
      setCreatingIn({ dirPath, type: "file" });
    },
    [expandDirectory],
  );

  const handleNewFolder = useCallback(
    async (dirPath: string) => {
      await expandDirectory(dirPath);
      setCreatingIn({ dirPath, type: "folder" });
    },
    [expandDirectory],
  );

  const handleCreateConfirm = useCallback(
    async (name: string) => {
      if (!creatingIn) return;
      const { dirPath, type } = creatingIn;
      const success =
        type === "file"
          ? await createNewFile(dirPath, name)
          : await createNewFolder(dirPath, name);

      if (success) {
        await refreshFileTree();
        await expandDirectory(dirPath);
        if (type === "file") {
          selectFile(`${dirPath}/${name}`);
        }
      }
      setCreatingIn(null);
    },
    [creatingIn, refreshFileTree, expandDirectory, selectFile],
  );

  const handleRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleRenameConfirm = useCallback(
    async (oldPath: string, newName: string) => {
      const parentDir = oldPath.substring(0, oldPath.lastIndexOf("/"));
      const newPath = `${parentDir}/${newName}`;

      if (newPath !== oldPath) {
        const success = await renameItem(oldPath, newPath);
        if (success) {
          pushUndo({
            type: 'rename',
            description: `Rename ${oldPath.substring(oldPath.lastIndexOf("/") + 1)} → ${newName}`,
            originalPath: oldPath,
            newPath,
            isDirectory: false, // approximate, fine for undo
          });
          await refreshFileTree();
          await expandDirectory(parentDir);
        }
      }
      setRenamingPath(null);
    },
    [refreshFileTree, expandDirectory, pushUndo],
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // Delete: show confirmation dialog instead of window.confirm
  const handleDelete = useCallback(
    (path: string, isDirectory: boolean) => {
      const {
        selectedFiles: currentSelectedFiles,
      } = useWorkspaceStore.getState();

      if (
        currentSelectedFiles.length > 1 &&
        currentSelectedFiles.includes(path)
      ) {
        setDeleteConfirm({
          path,
          name: "",
          isDirectory,
          isBatch: true,
          count: currentSelectedFiles.length,
        });
      } else {
        const name = path.substring(path.lastIndexOf("/") + 1);
        setDeleteConfirm({
          path,
          name,
          isDirectory,
          isBatch: false,
          count: 1,
        });
      }
    },
    [],
  );

  const executeDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const {
      selectedFiles: currentSelectedFiles,
      fileTree: currentFileTree,
      clearSelection,
    } = useWorkspaceStore.getState();

    if (deleteConfirm.isBatch) {
      let allSuccess = true;
      for (const filePath of currentSelectedFiles) {
        const findNode = (nodes: FileNode[], targetPath: string): FileNode | null => {
          for (const node of nodes) {
            if (node.path === targetPath) return node;
            if (node.children) {
              const found = findNode(node.children, targetPath);
              if (found) return found;
            }
          }
          return null;
        };
        const node = findNode(currentFileTree, filePath);
        const isDir = node?.type === "directory";
        // Backup content for undo (text files only)
        if (!isDir && workspacePath) {
          const content = await readFileContent(workspacePath, filePath);
          if (content !== undefined) {
            pushUndo({
              type: 'delete',
              description: `Delete ${filePath.substring(filePath.lastIndexOf("/") + 1)}`,
              originalPath: filePath,
              isDirectory: false,
              content,
            });
          }
        }
        const success = await deleteItem(filePath, isDir ?? false);
        if (!success) allSuccess = false;
      }
      if (allSuccess) {
        await refreshFileTree();
        clearSelection();
      }
    } else {
      // Backup for undo
      if (!deleteConfirm.isDirectory && workspacePath) {
        const content = await readFileContent(workspacePath, deleteConfirm.path);
        if (content !== undefined) {
          pushUndo({
            type: 'delete',
            description: `Delete ${deleteConfirm.name}`,
            originalPath: deleteConfirm.path,
            isDirectory: false,
            content,
          });
        }
      }
      const success = await deleteItem(deleteConfirm.path, deleteConfirm.isDirectory);
      if (success) {
        await refreshFileTree();
      }
    }
    setDeleteConfirm(null);
  }, [deleteConfirm, refreshFileTree, pushUndo]);

  const handleCopyPath = useCallback((path: string) => {
    copyToClipboard(path);
  }, []);

  const handleCopyRelativePath = useCallback(
    (path: string) => {
      if (workspacePath && path.startsWith(workspacePath)) {
        const relative = path.slice(workspacePath.length + 1);
        copyToClipboard(relative);
      } else {
        copyToClipboard(path);
      }
    },
    [workspacePath],
  );

  const handleReveal = useCallback((path: string) => {
    revealInFinder(path);
  }, []);

  const handleOpenDefault = useCallback((path: string) => {
    openWithDefaultApp(path);
  }, []);

  const handleOpenTerminal = useCallback((path: string) => {
    openInTerminal(path);
  }, []);

  const handleAddToAgent = useCallback(
    (path: string) => {
      // Insert as @{filepath} mention so it renders as a file chip in the prompt input
      let displayPath = path;
      if (workspacePath && path.startsWith(workspacePath)) {
        displayPath = path.slice(workspacePath.length + 1);
      }
      const mention = `@{${displayPath}} `;
      import("@/stores/voice-input").then(({ useVoiceInputStore }) => {
        useVoiceInputStore.getState().insertToChat(mention);
      });
    },
    [workspacePath],
  );

  // ── Clipboard handlers for context menu ──
  const handleCut = useCallback((paths: string[]) => {
    setClipboard(paths, 'cut');
    toast.success(t('fileExplorer.cut', 'Cut {{count}} item(s)', { count: paths.length }));
  }, [setClipboard, t]);

  const handleCopy = useCallback((paths: string[]) => {
    setClipboard(paths, 'copy');
    toast.success(t('fileExplorer.copied', 'Copied {{count}} item(s)', { count: paths.length }));
  }, [setClipboard, t]);

  const handlePaste = useCallback(async (targetDir: string) => {
    const success = await pasteFiles(targetDir);
    if (success) {
      toast.success(t('fileExplorer.pasted', 'Pasted'));
      await expandDirectory(targetDir);
    } else {
      toast.error(t('fileExplorer.pasteFailed', 'Paste failed'));
    }
  }, [pasteFiles, expandDirectory, t]);

  // ── Duplicate handler ──
  const handleDuplicate = useCallback(async (path: string) => {
    const success = await duplicateItem(path);
    if (success) {
      toast.success(t('fileExplorer.duplicated', 'Duplicated'));
      await refreshFileTree();
    } else {
      toast.error(t('fileExplorer.duplicateFailed', 'Duplicate failed'));
    }
  }, [refreshFileTree, t]);

  // ── Drag and drop handlers ──
  // Track drag source in a ref so Tauri event listeners can access it
  const dragSourcePathRef = useRef<string | null>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent, path: string) => {
      setDragSourcePath(path);
      dragSourcePathRef.current = path;
      e.dataTransfer.setData("text/plain", path);
      e.dataTransfer.setData(`application/x-${appShortName}-filepath`, path);
      e.dataTransfer.effectAllowed = "copyMove";
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, path: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
      // Don't allow dropping on self or on a child of the dragged item
      if (dragSourcePath && (path === dragSourcePath || path.startsWith(dragSourcePath + "/"))) {
        return;
      }
      setDragOverPath(path);
    },
    [dragSourcePath],
  );

  const handleDragLeave = useCallback((_e: React.DragEvent) => {
    setDragOverPath(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (isTauri()) {
      // Defer ALL cleanup — tauri://drag-drop arrives asynchronously after
      // the HTML5 dragend and needs both refs to detect internal drags and
      // resolve the drop target. If drag was cancelled, timeout ensures cleanup.
      setTimeout(() => {
        dragSourcePathRef.current = null;
        setDragSourcePath(null);
        setDragOverPath(null);
      }, 300);
    } else {
      dragSourcePathRef.current = null;
      setDragSourcePath(null);
      setDragOverPath(null);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetDirPath: string) => {
      e.preventDefault();
      setDragOverPath(null);
      // Use ref as fallback — Tauri's dragDropEnabled may prevent dataTransfer access
      const sourcePath = e.dataTransfer.getData("text/plain") || dragSourcePathRef.current;
      dragSourcePathRef.current = null;
      setDragSourcePath(null);
      if (!sourcePath || sourcePath === targetDirPath) return;
      // Don't drop into own subtree
      if (targetDirPath.startsWith(sourcePath + "/")) return;

      const fileName = sourcePath.substring(sourcePath.lastIndexOf("/") + 1);

      // Option/Alt+drag = copy, otherwise move
      if (e.altKey) {
        const success = await copyItem(sourcePath, targetDirPath);
        if (success) {
          await refreshFileTree();
          await expandDirectory(targetDirPath);
        }
      } else {
        const newPath = `${targetDirPath}/${fileName}`;
        const success = await moveItem(sourcePath, targetDirPath);
        if (success) {
          pushUndo({
            type: 'move',
            description: `Move ${fileName} to ${targetDirPath.substring(targetDirPath.lastIndexOf("/") + 1)}`,
            originalPath: sourcePath,
            newPath,
            isDirectory: false,
          });
          await refreshFileTree();
          await expandDirectory(targetDirPath);
        }
      }
      setDragSourcePath(null);
    },
    [refreshFileTree, expandDirectory, pushUndo],
  );

  // Build set of git-changed file paths for filtering
  const gitChangedPaths = useMemo(() => {
    if (!gitChangedOnly) return new Set<string>();
    return new Set(gitStatuses.keys());
  }, [gitChangedOnly, gitStatuses]);

  // Filter and flatten tree
  const { filteredTree, effectiveExpandedPaths } = useMemo(() => {
    if (gitChangedOnly) {
      const gitResult = buildGitChangedTree(
        gitChangedPaths,
        workspacePath || "",
      );
      let tree = gitResult.nodes;
      const autoExpand = gitResult.autoExpandPaths;
      if (filterText.trim()) {
        const filterResult = filterTree(tree, filterText, autoExpand);
        tree = filterResult.nodes;
      }
      return {
        filteredTree: tree,
        effectiveExpandedPaths: autoExpand,
      };
    }
    const filterResult = filterTree(fileTree, filterText);
    const merged =
      filterResult.autoExpandPaths.size > 0
        ? new Set([...expandedPaths, ...filterResult.autoExpandPaths])
        : expandedPaths;
    return {
      filteredTree: filterResult.nodes,
      effectiveExpandedPaths: merged,
    };
  }, [
    fileTree,
    filterText,
    gitChangedOnly,
    gitChangedPaths,
    workspacePath,
    expandedPaths,
  ]);
  const flatNodes = useMemo(
    () => flattenTree(filteredTree, effectiveExpandedPaths),
    [filteredTree, effectiveExpandedPaths],
  );
  const useVirtual = flatNodes.length > VIRTUAL_SCROLL_THRESHOLD;

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: useVirtual ? flatNodes.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // ── Keyboard navigation ──
  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (!flatNodes.length) return;
      // Don't handle keys when renaming
      if (renamingPath || creatingIn) return;

      // ⌘D = Duplicate focused item
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault();
        if (focusedPath) {
          handleDuplicate(focusedPath);
        }
        return;
      }

      // Clipboard shortcuts
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        if (e.key === 'c') {
          e.preventDefault();
          const paths = selectedFiles.length > 0 ? selectedFiles : (focusedPath ? [focusedPath] : []);
          if (paths.length > 0) {
            setClipboard(paths, 'copy');
            toast.success(t('fileExplorer.copied', 'Copied {{count}} item(s)', { count: paths.length }));
          }
          return;
        }
        if (e.key === 'x') {
          e.preventDefault();
          const paths = selectedFiles.length > 0 ? selectedFiles : (focusedPath ? [focusedPath] : []);
          if (paths.length > 0) {
            setClipboard(paths, 'cut');
            toast.success(t('fileExplorer.cut', 'Cut {{count}} item(s)', { count: paths.length }));
          }
          return;
        }
        if (e.key === 'v') {
          e.preventDefault();
          if (clipboardPaths.length > 0 && clipboardMode) {
            let targetDir = workspacePath;
            if (focusedPath) {
              const node = flatNodes.find(n => n.node.path === focusedPath);
              if (node?.node.type === 'directory') {
                targetDir = focusedPath;
              } else {
                targetDir = focusedPath.substring(0, focusedPath.lastIndexOf('/'));
              }
            }
            if (targetDir) {
              const success = await pasteFiles(targetDir);
              if (success) {
                toast.success(t('fileExplorer.pasted', 'Pasted'));
                await expandDirectory(targetDir);
              } else {
                toast.error(t('fileExplorer.pasteFailed', 'Paste failed'));
              }
            }
          }
          return;
        }
      }

      const currentIndex = flatNodes.findIndex(
        (n) => n.node.path === focusedPath,
      );

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const nextIndex = currentIndex < flatNodes.length - 1
            ? currentIndex + 1
            : 0;
          setFocusedPath(flatNodes[nextIndex].node.path);
          // Scroll into view
          const el = treeContainerRef.current?.querySelector(
            `[data-path="${CSS.escape(flatNodes[nextIndex].node.path)}"]`,
          );
          el?.scrollIntoView({ block: "nearest" });
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prevIndex = currentIndex > 0
            ? currentIndex - 1
            : flatNodes.length - 1;
          setFocusedPath(flatNodes[prevIndex].node.path);
          const el = treeContainerRef.current?.querySelector(
            `[data-path="${CSS.escape(flatNodes[prevIndex].node.path)}"]`,
          );
          el?.scrollIntoView({ block: "nearest" });
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (currentIndex === -1) break;
          const node = flatNodes[currentIndex].node;
          if (node.type === "directory" && !effectiveExpandedPaths.has(node.path)) {
            expandDirectory(node.path);
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (currentIndex === -1) break;
          const { node, compactedPaths } = flatNodes[currentIndex];
          if (node.type === "directory" && effectiveExpandedPaths.has(node.path)) {
            if (compactedPaths && compactedPaths.length > 1) {
              collapseCompacted(compactedPaths);
            } else {
              collapseDirectory(node.path);
            }
          } else {
            // Navigate to parent directory
            const parentPath = node.path.substring(0, node.path.lastIndexOf("/"));
            if (parentPath && parentPath !== workspacePath) {
              setFocusedPath(parentPath);
              const el = treeContainerRef.current?.querySelector(
                `[data-path="${CSS.escape(parentPath)}"]`,
              );
              el?.scrollIntoView({ block: "nearest" });
            }
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (currentIndex === -1) break;
          const entryNode = flatNodes[currentIndex];
          if (entryNode.node.type === "directory") {
            if (effectiveExpandedPaths.has(entryNode.node.path)) {
              if (entryNode.compactedPaths && entryNode.compactedPaths.length > 1) {
                collapseCompacted(entryNode.compactedPaths);
              } else {
                collapseDirectory(entryNode.node.path);
              }
            } else {
              expandDirectory(entryNode.node.path);
            }
          } else {
            selectFile(entryNode.node.path);
          }
          break;
        }
        case "Home": {
          e.preventDefault();
          if (flatNodes.length > 0) {
            setFocusedPath(flatNodes[0].node.path);
            const el = treeContainerRef.current?.querySelector(
              `[data-path="${CSS.escape(flatNodes[0].node.path)}"]`,
            );
            el?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "End": {
          e.preventDefault();
          const last = flatNodes[flatNodes.length - 1];
          if (last) {
            setFocusedPath(last.node.path);
            const el = treeContainerRef.current?.querySelector(
              `[data-path="${CSS.escape(last.node.path)}"]`,
            );
            el?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "F2": {
          e.preventDefault();
          if (focusedPath) {
            setRenamingPath(focusedPath);
          }
          break;
        }
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          if (focusedPath) {
            const node = flatNodes.find((n) => n.node.path === focusedPath);
            if (node) {
              handleDelete(node.node.path, node.node.type === "directory");
            }
          }
          break;
        }
      }
    },
    [
      flatNodes,
      focusedPath,
      renamingPath,
      creatingIn,
      effectiveExpandedPaths,
      workspacePath,
      selectedFiles,
      setFocusedPath,
      expandDirectory,
      collapseDirectory,
      collapseCompacted,
      selectFile,
      handleDelete,
      handleDuplicate,
      clipboardPaths,
      clipboardMode,
      setClipboard,
      pasteFiles,
      t,
    ],
  );

  // Auto-scroll to reveal selected file (when file is selected from editor)
  useEffect(() => {
    if (!selectedFile) return;
    // Small delay to let tree render
    const timer = setTimeout(() => {
      const el = treeContainerRef.current?.querySelector(
        `[data-path="${CSS.escape(selectedFile)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedFile]);

  // Auto-reveal active file in tree when tab changes
  // Dynamic import to avoid circular dependency (workspace ↔ tabs)
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    import('@/stores/tabs').then(({ useTabsStore }) => {
      if (cancelled) return;
      let prevActiveTabId = useTabsStore.getState().activeTabId;
      unsubscribe = useTabsStore.subscribe((state) => {
        if (state.activeTabId === prevActiveTabId) return;
        prevActiveTabId = state.activeTabId;
        if (!state.activeTabId) {
          useWorkspaceStore.setState({ selectedFile: null, selectedFiles: [], focusedPath: null });
          return;
        }
        const tab = state.tabs.find(t => t.id === state.activeTabId);
        if (tab?.type === 'file' && tab.target) {
          // Only reveal if the file was opened from outside the tree (e.g. tab click, chat link).
          // If selectedFile already matches, the user clicked in the tree — no need to reveal.
          const alreadySelected = useWorkspaceStore.getState().selectedFile === tab.target;
          useWorkspaceStore.setState({ selectedFile: tab.target, selectedFiles: [tab.target] });
          if (!alreadySelected) {
            revealFile(tab.target).catch(() => {});
          }
        }
      });
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [revealFile]);

  // Listen for Tauri native drag-drop events (external file drops from OS)
  // Use flatNodesRef so the drag-over handler can resolve file paths to parent dirs
  const flatNodesRef = useRef(flatNodes);
  useEffect(() => { flatNodesRef.current = flatNodes; }, [flatNodes]);

  useEffect(() => {
    if (!isTauri() || !workspacePath) return;
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    import('@tauri-apps/api/event').then(async ({ listen }) => {
      if (cancelled) return;

      // Handle external file drop (or internal drag that landed outside the file tree)
      unlisteners.push(await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-drop',
        async (event) => {
          // Internal drag-move: Tauri intercepts the HTML5 drop event.
          // Check if the drop target was inside the file tree (perform move)
          // or outside (dispatch to prompt input / other drop targets).
          if (dragSourcePathRef.current) {
            const sourcePath = dragSourcePathRef.current;
            // Read refs before clearing state to avoid race with useEffect sync
            let targetDir = dragOverPathRef.current;
            dragSourcePathRef.current = null;
            setDragSourcePath(null);
            setDragOverPath(null);

            // Resolve drop target: prefer dragOverPath (set by HTML5 dragover
            // on directories), fall back to elementFromPoint for file targets
            if (!targetDir) {
              const { x, y } = event.payload.position;
              const el = document.elementFromPoint(x, y);
              const treeItem = el?.closest('[data-path]') as HTMLElement | null;
              if (treeItem) {
                const path = treeItem.getAttribute('data-path');
                if (path) {
                  const node = flatNodesRef.current.find(fn => fn.node.path === path);
                  if (node && node.node.type === 'file') {
                    targetDir = path.substring(0, path.lastIndexOf('/')) || workspacePath;
                  } else {
                    targetDir = path;
                  }
                }
              }
            }

            // Drop landed on a directory in the file tree → move
            if (targetDir && targetDir !== sourcePath && !targetDir.startsWith(sourcePath + '/')) {
              const fileName = sourcePath.substring(sourcePath.lastIndexOf('/') + 1);
              const newPath = `${targetDir}/${fileName}`;
              const { moveItem } = await import('./file-tree-operations');
              const success = await moveItem(sourcePath, targetDir);
              if (success) {
                pushUndoRef.current({
                  type: 'move',
                  description: `Move ${fileName} to ${targetDir.substring(targetDir.lastIndexOf('/') + 1)}`,
                  originalPath: sourcePath,
                  newPath,
                  isDirectory: false,
                });
                await refreshFileTree();
                await expandDirectory(targetDir);
              }
              return;
            }

            // Drop landed outside the file tree → dispatch for prompt input
            window.dispatchEvent(new CustomEvent('teamclaw:filedrop', {
              detail: { path: sourcePath, position: event.payload.position },
            }));
            return;
          }
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;

          const targetDir = dragOverPathRef.current || workspacePath;

          const { copyExternalFiles } = await import('./file-tree-operations');
          const success = await copyExternalFiles(paths, targetDir);
          if (success) {
            toast.success(t('fileExplorer.externalDropped', 'Copied {{count}} file(s)', { count: paths.length }));
            await refreshFileTree();
            if (targetDir !== workspacePath) {
              await expandDirectory(targetDir);
            }
          } else {
            toast.error(t('fileExplorer.externalDropFailed', 'Failed to copy files'));
          }
          setDragOverPath(null);
        },
      ));
      if (cancelled) { unlisteners.forEach(fn => fn()); return; }

      // Highlight hovered directory during external drag (skip for internal drags)
      unlisteners.push(await listen<{ paths: string[]; position: { x: number; y: number } }>(
        'tauri://drag-over',
        (event) => {
          if (dragSourcePathRef.current) return; // Internal drag handled by HTML5 handlers
          const el = document.elementFromPoint(event.payload.position.x, event.payload.position.y);
          const treeItem = el?.closest('[data-path]') as HTMLElement | null;
          if (treeItem) {
            const path = treeItem.getAttribute('data-path');
            if (path) {
              // Resolve to parent directory if hovering over a file
              const node = flatNodesRef.current.find(fn => fn.node.path === path);
              if (node && node.node.type === 'file') {
                const parentDir = path.substring(0, path.lastIndexOf('/'));
                setDragOverPath(parentDir || workspacePath);
              } else {
                setDragOverPath(path);
              }
            }
          } else {
            setDragOverPath(null);
          }
        },
      ));
      if (cancelled) { unlisteners.forEach(fn => fn()); return; }

      // Clear highlight when drag leaves window
      unlisteners.push(await listen('tauri://drag-leave', () => {
        setDragOverPath(null);
      }));
      if (cancelled) { unlisteners.forEach(fn => fn()); return; }
    });

    return () => { cancelled = true; unlisteners.forEach(fn => fn()); };
  }, [workspacePath, refreshFileTree, expandDirectory, t]);

  if (fileTree.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {t("fileExplorer.noFilesFound", "No files found")}
      </div>
    );
  }

  if ((filterText.trim() || gitChangedOnly) && filteredTree.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        {gitChangedOnly && !filterText.trim()
          ? t("fileExplorer.noGitChanges", "No git changes")
          : t("fileExplorer.noFilesMatchFilter", "No files match filter")}
      </div>
    );
  }

  const findCreatingIndex = (nodes: FlatTreeNode[]): number => {
    if (!creatingIn) return -1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].node.path === creatingIn.dirPath) {
        return i + 1;
      }
    }
    return -1;
  };

  const creatingIndex = findCreatingIndex(flatNodes);
  const creatingLevel = creatingIn
    ? (flatNodes.find((n) => n.node.path === creatingIn.dirPath)?.level ?? 0) +
      1
    : 0;

  const buildItemProps = (node: FileNode, level: number, compactName?: string, compactedPaths?: string[]) => ({
    node,
    level,
    compactName,
    compactedPaths,
    onCollapseCompacted: collapseCompacted,
    isSelected: selectedFilesSet.has(node.path) || selectedFile === node.path,
    isFocused: focusedPath === node.path,
    isExpanded: effectiveExpandedPaths.has(node.path),
    isLoading: loadingPaths.has(node.path),
    hasGitChanges:
      node.type === "directory"
        ? dirtyDirectories.has(node.path)
        : fileGitStatusMap.has(node.path),
    gitStatus:
      node.type === "directory"
        ? null
        : (fileGitStatusMap.get(node.path) ?? null),
    showStatusIcons,
    statusColors,
    isRenaming: renamingPath === node.path,
    isDragOver: dragOverPath === node.path,
    isTeamClawTeam: node.name === TEAM_REPO_DIR && node.type === "directory" && level === 0,
    syncStatus: (() => {
      if (!node.path.includes(`/${TEAM_REPO_DIR}/`)) return null;
      if (node.type === 'directory') {
        return syncDirtyDirectories.get(node.path) ?? null;
      }
      // Extract relative path within teamclaw-team/
      const teamDirPrefix = `${workspacePath}/${TEAM_REPO_DIR}/`;
      if (!node.path.startsWith(teamDirPrefix)) return null;
      const relPath = node.path.slice(teamDirPrefix.length);
      return fileSyncStatusMap[relPath] ?? null;
    })(),
    onSelectFile: selectFile,
    onSelectFileRange: selectFileRange,
    onToggleFileSelection: toggleFileSelection,
    onExpandDirectory: expandDirectory,
    onCollapseDirectory: collapseDirectory,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    onRename: handleRename,
    onRenameConfirm: handleRenameConfirm,
    onRenameCancel: handleRenameCancel,
    onDelete: handleDelete,
    onCopyPath: handleCopyPath,
    onCopyRelativePath: handleCopyRelativePath,
    onReveal: handleReveal,
    onOpenDefault: handleOpenDefault,
    onOpenTerminal: handleOpenTerminal,
    onAddToAgent: handleAddToAgent,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDragEnd: handleDragEnd,
    onDrop: handleDrop,
    onCut: handleCut,
    onCopy: handleCopy,
    onPaste: handlePaste,
    onDuplicate: handleDuplicate,
    hasClipboard: clipboardPaths.length > 0,
    isClipboardCut: clipboardMode === 'cut',
    clipboardPaths,
  });

  const treeContent = !useVirtual ? (
    <div className="py-1">
      {flatNodes.map(({ node, level, compactName, compactedPaths }, index) => (
        <React.Fragment key={node.path}>
          <FileTreeItem {...buildItemProps(node, level, compactName, compactedPaths)} />
          {creatingIn && index === creatingIndex - 1 && (
            <InlineInput
              defaultValue={
                creatingIn.type === "file" ? "untitled" : "new-folder"
              }
              onConfirm={handleCreateConfirm}
              onCancel={() => setCreatingIn(null)}
              level={creatingLevel}
              icon={
                creatingIn.type === "file" ? (
                  <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rotate-90" />
                )
              }
            />
          )}
        </React.Fragment>
      ))}
    </div>
  ) : (
    <div ref={parentRef} className="py-1 h-full overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const { node, level, compactName, compactedPaths } = flatNodes[virtualRow.index];
          return (
            <div
              key={node.path}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <FileTreeItem {...buildItemProps(node, level, compactName, compactedPaths)} />
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <div
        ref={treeContainerRef}
        tabIndex={creatingIn || renamingPath ? -1 : 0}
        onKeyDown={handleKeyDown}
        onFocusCapture={
          creatingIn || renamingPath
            ? (e) => {
                // While inline editing, prevent anything in the tree from stealing focus.
                // This guards against Radix ContextMenu focus restoration and similar.
                const input = treeContainerRef.current?.querySelector<HTMLInputElement>(
                  'input.inline-edit-input',
                );
                if (input && e.target !== input) {
                  e.stopPropagation();
                  requestAnimationFrame(() => {
                    input.focus({ preventScroll: true });
                    input.select();
                  });
                }
              }
            : undefined
        }
        className="outline-none"
      >
        {treeContent}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteConfirm?.isBatch
                ? t("fileExplorer.confirmBatchDeleteTitle", "Delete {{count}} items?", { count: deleteConfirm?.count })
                : t("fileExplorer.confirmDeleteTitle", "Delete \"{{name}}\"?", { name: deleteConfirm?.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm?.isBatch
                ? t("fileExplorer.confirmBatchDeleteDesc", "This will permanently delete all selected items. This action cannot be undone for directories.")
                : deleteConfirm?.isDirectory
                  ? t("fileExplorer.confirmDeleteDirDesc", "This will permanently delete this folder and all its contents.")
                  : t("fileExplorer.confirmDeleteFileDesc", "This will permanently delete this file.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={executeDelete}>
              {t("fileExplorer.delete", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
