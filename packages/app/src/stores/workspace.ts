import { create } from "zustand";
import { UNSUPPORTED_BINARY_EXTENSIONS } from "@/components/viewers/UnsupportedFileViewer";
import { isTauri } from '@/lib/utils'
import { ensureGitignoreEntries } from '@/lib/gitignore-manager'

// Directories to hide from file tree (system directories)
const HIDDEN_DIRECTORIES = new Set(['.teamclaw', '.opencode'])

// Start watching a directory for file changes
async function startWatching(path: string): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<boolean>("watch_directory", { path });
    console.log("[Workspace] Started file watcher for:", path);
    return result;
  } catch (error) {
    console.error("[Workspace] Failed to start file watcher:", error);
    return false;
  }
}

// Stop watching a directory
async function stopWatching(path: string): Promise<boolean> {
  if (!isTauri()) return false;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<boolean>("unwatch_directory", { path });
    console.log("[Workspace] Stopped file watcher for:", path);
    return result;
  } catch (error) {
    console.error("[Workspace] Failed to stop file watcher:", error);
    return false;
  }
}

// Expand ~ to home directory
async function expandPath(path: string): Promise<string> {
  if (!path.startsWith("~")) return path;

  if (isTauri()) {
    try {
      const { homeDir } = await import("@tauri-apps/api/path");
      const home = await homeDir();
      return path.replace(/^~/, home.replace(/\/$/, ""));
    } catch {
      return path;
    }
  }
  return path;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

// Right panel tab type
export type RightPanelTab = "tasks" | "diff" | "files" | "shortcuts";

// Undo operation types for file operations
interface UndoOperation {
  type: 'delete' | 'rename' | 'move';
  description: string;
  // For delete: original path + content backup
  originalPath: string;
  isDirectory: boolean;
  // For rename/move: new path
  newPath?: string;
  // For delete files: backed-up content (text only, binary files can't be undone)
  content?: string;
}

interface WorkspaceState {
  // Workspace state
  workspacePath: string | null;
  workspaceName: string | null;
  isLoadingWorkspace: boolean;

  // OpenCode server state
  openCodeReady: boolean;
  openCodeUrl: string | null;
  setOpenCodeReady: (ready: boolean, url?: string) => void;

  // Right panel state
  isPanelOpen: boolean;
  activeTab: RightPanelTab;

  // File browser state
  fileTree: FileNode[];
  expandedPaths: Set<string>; // Tracks which directories are expanded (decoupled from tree data)
  loadingPaths: Set<string>; // Tracks which directories are currently loading
  selectedFile: string | null;
  selectedFiles: string[]; // Multi-select support
  lastSelectedFile: string | null; // Track last selected file for range selection
  fileContent: string | null;
  isLoadingFile: boolean;
  targetLine: number | null; // Line number to scroll to after file loads
  targetHeading: string | null; // Heading text to scroll to (for Markdown files)
  focusedPath: string | null; // Keyboard navigation focused item

  // Undo stack
  undoStack: UndoOperation[];

  // Actions
  setWorkspace: (path: string) => Promise<void>;
  clearWorkspace: () => Promise<void>;

  // Panel actions
  openPanel: (tab?: RightPanelTab) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setActiveTab: (tab: RightPanelTab) => void;

  // File tree actions
  loadDirectory: (path: string) => Promise<FileNode[]>;
  expandDirectory: (path: string) => Promise<void>;
  collapseDirectory: (path: string) => void;
  collapseAll: () => void;
  refreshFileTree: () => Promise<void>;
  revealFile: (path: string) => Promise<void>;

  // File actions
  selectFile: (path: string, line?: number, heading?: string) => Promise<void>;
  selectFileRange: (path: string) => void; // Shift+Click range selection
  toggleFileSelection: (path: string) => void; // Ctrl/Cmd+Click toggle selection
  reloadSelectedFile: () => Promise<void>;
  clearSelection: () => void;
  setFocusedPath: (path: string | null) => void;

  // Undo
  pushUndo: (op: UndoOperation) => void;
  undo: () => Promise<boolean>;

  // Helpers
  flattenVisibleFileTree: (nodes: FileNode[]) => string[];
}

// Extract folder name from path
function getFolderName(path: string): string {
  const parts = path.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export const WORKSPACE_STORAGE_KEY = "teamclaw-workspace-path";

// Update only the target node's children, creating new references only along
// the path from root to target. Siblings and unrelated subtrees keep their
// original references, preserving React.memo effectiveness.
function updateNodeChildren(
  nodes: FileNode[],
  targetPath: string,
  children: FileNode[],
): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children };
    }
    // Only recurse into directories whose path is a prefix of targetPath
    if (node.children && targetPath.startsWith(node.path + "/")) {
      return {
        ...node,
        children: updateNodeChildren(node.children, targetPath, children),
      };
    }
    return node; // unchanged reference
  });
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  // Initial state
  workspacePath: null,
  workspaceName: null,
  isLoadingWorkspace: false,
  openCodeReady: false,
  openCodeUrl: null,
  setOpenCodeReady: (ready: boolean, url?: string) =>
    set({ openCodeReady: ready, ...(url ? { openCodeUrl: url } : {}) }),
  isPanelOpen: false,
  activeTab: "tasks",
  fileTree: [],
  expandedPaths: new Set<string>(),
  loadingPaths: new Set<string>(),
  selectedFile: null,
  selectedFiles: [], // Multi-select support
  lastSelectedFile: null, // Track last selected file for range selection
  fileContent: null,
  isLoadingFile: false,
  targetLine: null,
  targetHeading: null,
  focusedPath: null,
  undoStack: [],

  // Set workspace and load file tree
  setWorkspace: async (path: string) => {
    // Expand ~ to home directory
    const expandedPath = await expandPath(path);
    console.log("[Workspace] Setting workspace:", path, "->", expandedPath);

    // If selecting the same workspace, just refresh the file tree — don't reset OpenCode
    const currentPath = get().workspacePath;
    if (currentPath === expandedPath) {
      console.log("[Workspace] Same workspace selected, skipping reset");
      await get().refreshFileTree();
      return;
    }

    // Stop watching previous workspace if any
    if (currentPath) {
      await stopWatching(currentPath);
    }

    set({
      isLoadingWorkspace: true,
      openCodeReady: false,
      openCodeUrl: null,
      workspacePath: expandedPath,
      workspaceName: getFolderName(expandedPath),
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      fileContent: null,
      targetLine: null,
      targetHeading: null,
      focusedPath: null,
      undoStack: [],
    });

    // Persist workspace path for auto-restore on next launch
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, expandedPath);
    } catch {
      /* ignore storage errors */
    }

    try {
      // Load root directory
      await get().refreshFileTree();

      // Ensure .gitignore has required entries
      await ensureGitignoreEntries(expandedPath);

      // Start watching the new workspace for file changes
      await startWatching(expandedPath);

      // Load contacts from knowledge/contacts.md
      try {
        const { useContactsStore } = await import("./contacts");
        const loadContacts = useContactsStore.getState().loadContacts;
        await loadContacts(expandedPath);
      } catch (error) {
        // Contacts loading is optional, don't fail workspace loading
        console.warn("[Workspace] Failed to load contacts:", error);
      }

      // Trigger team data export to ensure .leaderboard directory exists
      try {
        const { useTelemetryStore } = await import("./telemetry");
        useTelemetryStore.getState().exportTeamData(true);
      } catch (error) {
        console.warn("[Workspace] Failed to trigger team data export:", error);
      }

      // Load local stats for this workspace
      try {
        const { loadLocalStatsForWorkspace } = await import("./local-stats");
        loadLocalStatsForWorkspace(expandedPath);
      } catch (error) {
        console.warn("[Workspace] Failed to load local stats:", error);
      }

      set({ isLoadingWorkspace: false });
    } catch (error) {
      console.error("Failed to load workspace:", error);
      set({ isLoadingWorkspace: false });
    }
  },

  clearWorkspace: async () => {
    // Stop watching current workspace
    const currentPath = get().workspacePath;
    if (currentPath) {
      await stopWatching(currentPath);
    }

    // Clear contacts
    try {
      const { useContactsStore } = await import("./contacts");
      useContactsStore.getState().clearContacts();
    } catch {
      // Ignore if contacts store not available
    }

    // Remove persisted workspace path
    try {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    } catch {
      /* ignore storage errors */
    }

    set({
      workspacePath: null,
      workspaceName: null,
      openCodeReady: false,
      openCodeUrl: null,
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      fileContent: null,
      targetLine: null,
      targetHeading: null,
      focusedPath: null,
      undoStack: [],
    });
  },

  // Panel actions
  openPanel: (tab?: RightPanelTab) =>
    set({
      isPanelOpen: true,
      ...(tab ? { activeTab: tab } : {}),
    }),
  closePanel: () => set({ isPanelOpen: false }),
  togglePanel: () => set((state) => ({ isPanelOpen: !state.isPanelOpen })),
  setActiveTab: (tab: RightPanelTab) => set({ activeTab: tab }),

  // Load directory contents using Tauri FS plugin
  loadDirectory: async (path: string): Promise<FileNode[]> => {
    const { workspacePath } = get();
    if (!workspacePath) {
      console.log("[Workspace] No workspace path set");
      return [];
    }

    // In web mode, skip file system operations
    if (!isTauri()) {
      console.log("[Web Mode] File browser not available");
      return [];
    }

    try {
      const { readDir } = await import("@tauri-apps/plugin-fs");
      const fullPath = path === "." ? workspacePath : path;
      console.log("[Workspace] Loading directory:", fullPath);
      const entries = await readDir(fullPath);
      console.log("[Workspace] Found", entries.length, "entries");

      const nodes: FileNode[] = entries
        .filter(entry => !HIDDEN_DIRECTORIES.has(entry.name))
        .map(
          (entry) =>
            ({
              name: entry.name,
              path: `${fullPath}/${entry.name}`,
              type: entry.isDirectory ? "directory" : "file",
            }) as FileNode,
        )
        .sort((a, b) => {
          // Always put teamclaw-team first
          if (a.name === 'teamclaw-team' && b.name !== 'teamclaw-team') return -1;
          if (b.name === 'teamclaw-team' && a.name !== 'teamclaw-team') return 1;
          
          // Then directories before files
          if (a.type !== b.type) {
            return a.type === "directory" ? -1 : 1;
          }
          
          // Then alphabetical
          return a.name.localeCompare(b.name);
        });

      return nodes;
    } catch (error) {
      console.error("[Workspace] Failed to load directory:", error);
      return [];
    }
  },

  // Expand a directory node
  expandDirectory: async (path: string) => {
    const { loadDirectory, expandedPaths } = get();

    // If already expanded (e.g. re-expand after creating a file), just reload children
    const alreadyExpanded = expandedPaths.has(path);

    // Mark as loading via loadingPaths Set (O(1), no tree copy)
    const nextLoading = new Set(get().loadingPaths);
    nextLoading.add(path);
    set({ loadingPaths: nextLoading });

    // Load children
    const children = await loadDirectory(path);

    // Update only the target node's children in the tree (minimal copy)
    const updatedTree = updateNodeChildren(get().fileTree, path, children);

    // Update expanded/loading sets
    const nextExpanded = alreadyExpanded
      ? expandedPaths
      : new Set(get().expandedPaths);
    nextExpanded.add(path);
    const doneLoading = new Set(get().loadingPaths);
    doneLoading.delete(path);

    set({
      fileTree: updatedTree,
      expandedPaths: nextExpanded,
      loadingPaths: doneLoading,
    });
  },

  // Collapse a directory node
  collapseDirectory: (path: string) => {
    // O(1) set operation, zero tree copy
    const nextExpanded = new Set(get().expandedPaths);
    nextExpanded.delete(path);
    set({ expandedPaths: nextExpanded });
  },

  // Collapse all directories
  collapseAll: () => {
    set({ expandedPaths: new Set<string>() });
  },

  setFocusedPath: (path: string | null) => {
    set({ focusedPath: path });
  },

  pushUndo: (op: UndoOperation) => {
    const stack = get().undoStack;
    // Keep max 20 undo operations
    set({ undoStack: [...stack.slice(-19), op] });
  },

  undo: async () => {
    const stack = get().undoStack;
    if (stack.length === 0) return false;

    const op = stack[stack.length - 1];
    const newStack = stack.slice(0, -1);
    set({ undoStack: newStack });

    if (!isTauri()) return false;

    try {
      if (op.type === 'rename' || op.type === 'move') {
        // Reverse: move newPath back to originalPath
        if (op.newPath) {
          const { rename } = await import("@tauri-apps/plugin-fs");
          await rename(op.newPath, op.originalPath);
        }
      } else if (op.type === 'delete' && op.content !== undefined && !op.isDirectory) {
        // Restore deleted file with backed-up content
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(op.originalPath, op.content);
      } else {
        // Can't undo directory delete or binary file delete
        return false;
      }
      await get().refreshFileTree();
      return true;
    } catch (error) {
      console.error("[Workspace] Undo failed:", error);
      return false;
    }
  },

  // Reveal a file in the tree: expand all ancestor directories and set focus
  revealFile: async (path: string) => {
    const { workspacePath, expandDirectory } = get();
    if (!workspacePath || !path.startsWith(workspacePath)) return;

    // Build list of ancestor directories to expand
    const relativePath = path.slice(workspacePath.length + 1);
    const segments = relativePath.split("/");
    let currentPath = workspacePath;

    // Expand each ancestor directory
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = `${currentPath}/${segments[i]}`;
      await expandDirectory(currentPath);
    }

    set({ focusedPath: path });
  },

  // Refresh file tree from root, preserving expand states and selection
  refreshFileTree: async () => {
    const { loadDirectory, expandedPaths } = get();
    const rootNodes = await loadDirectory(".");

    // Re-expand previously expanded directories
    const stillValid = new Set<string>();
    const refreshExpanded = async (tree: FileNode[]): Promise<FileNode[]> => {
      return Promise.all(
        tree.map(async (node) => {
          if (node.type === "directory" && expandedPaths.has(node.path)) {
            const children = await loadDirectory(node.path);
            stillValid.add(node.path);
            return {
              ...node,
              children: await refreshExpanded(children),
            };
          }
          return node;
        }),
      );
    };

    const refreshedTree = await refreshExpanded(rootNodes);
    set({
      fileTree: refreshedTree,
      expandedPaths: stillValid,
    });
  },

  // Helper function to flatten visible file tree into ordered list of file paths
  flattenVisibleFileTree: (nodes: FileNode[]): string[] => {
    const { expandedPaths } = get();
    const result: string[] = [];
    const traverse = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") {
          result.push(node.path);
        }
        if (
          node.type === "directory" &&
          expandedPaths.has(node.path) &&
          node.children
        ) {
          traverse(node.children);
        }
      }
    };
    traverse(nodes);
    return result;
  },

  // Select and load a file using Tauri FS plugin
  selectFile: async (path: string, line?: number, heading?: string) => {
    // Update both single and multi-select state for backward compatibility
    set({
      selectedFile: path,
      selectedFiles: [path], // Single selection clears multi-select
      lastSelectedFile: path,
      isLoadingFile: true,
      fileContent: null,
      targetLine: line ?? null,
      targetHeading: heading ?? null,
    });

    // In web mode, skip file system operations
    if (!isTauri()) {
      set({
        fileContent: "[Web Mode] File preview not available",
        isLoadingFile: false,
      });
      return;
    }

    // Check file type for appropriate reading strategy
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const previewableBinaryExtensions = [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "ico",
      "svg",
      "pdf",
    ];
    const isPreviewableBinary = previewableBinaryExtensions.includes(ext);
    const isUnsupportedBinary = UNSUPPORTED_BINARY_EXTENSIONS.has(ext);

    try {
      if (isUnsupportedBinary) {
        // For unsupported binary files, don't read content - just mark as loaded
        // The viewer will detect the file type from filename and show an appropriate message
        set({ fileContent: "", isLoadingFile: false });
      } else if (isPreviewableBinary) {
        // For images/PDFs, read as bytes and convert to base64
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(path);

        // Convert to base64
        let binary = "";
        const len = bytes.length;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        // Determine MIME type
        const mimeTypes: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
          ico: "image/x-icon",
          svg: "image/svg+xml",
          pdf: "application/pdf",
        };
        const mimeType = mimeTypes[ext] || "application/octet-stream";

        // Store as data URL
        set({
          fileContent: `data:${mimeType};base64,${base64}`,
          isLoadingFile: false,
        });
      } else {
        // For text files, read as text
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const content = await readTextFile(path);
        set({ fileContent: content, isLoadingFile: false });
      }
    } catch (error) {
      console.error("Failed to load file:", error);
      set({
        fileContent: `Error loading file: ${error}`,
        isLoadingFile: false,
      });
    }
  },

  // Reload the currently selected file (useful when file is modified externally)
  // Unlike selectFile, this does NOT set fileContent: null or isLoadingFile: true,
  // so the editor stays mounted and can apply the change incrementally.
  reloadSelectedFile: async () => {
    const { selectedFile } = get();
    if (!selectedFile) return;

    // In web mode, nothing to reload
    if (!isTauri()) return;

    try {
      const ext = selectedFile.split(".").pop()?.toLowerCase() || "";
      const previewableBinaryExtensions = [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "bmp",
        "ico",
        "svg",
        "pdf",
      ];

      if (previewableBinaryExtensions.includes(ext)) {
        // Binary files: fall back to full selectFile (rare case for agent writes)
        const { selectFile } = get();
        await selectFile(selectedFile);
      } else {
        // Text files: just re-read content and update — no unmount cycle
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const content = await readTextFile(selectedFile);
        set({ fileContent: content });
      }
    } catch (error) {
      console.error("[Workspace] Failed to reload file:", error);
    }
  },

  // Shift+Click range selection
  selectFileRange: (path: string) => {
    const { fileTree, lastSelectedFile, flattenVisibleFileTree } = get();

    // Flatten visible file tree to get ordered list
    const visibleFiles = flattenVisibleFileTree(fileTree);

    // If no lastSelectedFile, treat as single selection
    if (!lastSelectedFile) {
      set({
        selectedFile: path,
        selectedFiles: [path],
        lastSelectedFile: path,
      });
      return;
    }

    // Find indices of lastSelectedFile and clicked file
    const lastIndex = visibleFiles.indexOf(lastSelectedFile);
    const clickedIndex = visibleFiles.indexOf(path);

    // If either file not found, treat as single selection
    if (lastIndex === -1 || clickedIndex === -1) {
      set({
        selectedFile: path,
        selectedFiles: [path],
        lastSelectedFile: path,
      });
      return;
    }

    // Select all files between lastIndex and clickedIndex (inclusive)
    const startIndex = Math.min(lastIndex, clickedIndex);
    const endIndex = Math.max(lastIndex, clickedIndex);
    const rangeFiles = visibleFiles.slice(startIndex, endIndex + 1);

    set({
      selectedFile: path, // Still update selectedFile for editor
      selectedFiles: rangeFiles,
      lastSelectedFile: path,
    });
  },

  toggleFileSelection: (path: string) => {
    const { selectedFiles } = get();
    const isSelected = selectedFiles.includes(path);
    if (isSelected) {
      const newFiles = selectedFiles.filter(f => f !== path);
      set({
        selectedFile: newFiles.length > 0 ? newFiles[newFiles.length - 1] : null,
        selectedFiles: newFiles,
        lastSelectedFile: path,
      });
    } else {
      set({
        selectedFile: path,
        selectedFiles: [...selectedFiles, path],
        lastSelectedFile: path,
      });
    }
  },

  clearSelection: () =>
    set({
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      fileContent: null,
      targetLine: null,
      targetHeading: null,
    }),
}));
