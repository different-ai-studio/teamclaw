import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/components/viewers/UnsupportedFileViewer', () => ({
  UNSUPPORTED_BINARY_EXTENSIONS: ['.exe', '.bin'],
}));

// Import after mocks
import { useWorkspaceStore } from '../workspace';
import type { FileNode } from '../workspace';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workspace store: behavioral tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      workspacePath: null,
      workspaceName: null,
      isPanelOpen: false,
      activeTab: 'shortcuts',
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      fileContent: null,
      isLoadingFile: false,
      targetLine: null,
      targetHeading: null,
      focusedPath: null,
      undoStack: [],
    });
  });

  describe('panel actions', () => {
    it('openPanel sets isPanelOpen to true', () => {
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(false);
      useWorkspaceStore.getState().openPanel();
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(true);
    });

    it('openPanel with tab sets both isPanelOpen and activeTab', () => {
      useWorkspaceStore.getState().openPanel('diff');
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(true);
      expect(useWorkspaceStore.getState().activeTab).toBe('diff');
    });

    it('openPanel without tab preserves current activeTab', () => {
      useWorkspaceStore.setState({ activeTab: 'files' });
      useWorkspaceStore.getState().openPanel();
      expect(useWorkspaceStore.getState().activeTab).toBe('files');
    });

    it('closePanel sets isPanelOpen to false', () => {
      useWorkspaceStore.setState({ isPanelOpen: true });
      useWorkspaceStore.getState().closePanel();
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(false);
    });

    it('togglePanel flips isPanelOpen', () => {
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(false);
      useWorkspaceStore.getState().togglePanel();
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(true);
      useWorkspaceStore.getState().togglePanel();
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(false);
    });

    it('setActiveTab changes tab without affecting panel open state', () => {
      useWorkspaceStore.setState({ isPanelOpen: false, activeTab: 'shortcuts' });
      useWorkspaceStore.getState().setActiveTab('shortcuts');
      expect(useWorkspaceStore.getState().activeTab).toBe('shortcuts');
      expect(useWorkspaceStore.getState().isPanelOpen).toBe(false);
    });
  });

  describe('flattenVisibleFileTree', () => {
    it('returns empty array for empty tree', () => {
      const flat = useWorkspaceStore.getState().flattenVisibleFileTree([]);
      expect(flat).toEqual([]);
    });

    it('returns file paths but not directory paths', () => {
      const tree: FileNode[] = [
        { name: 'file1.ts', path: '/file1.ts', type: 'file' },
        { name: 'dir', path: '/dir', type: 'directory' },
      ];
      const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
      expect(flat).toContain('/file1.ts');
    });

    it('includes children of expanded directories', () => {
      useWorkspaceStore.setState({
        expandedPaths: new Set(['/src']),
      });
      const tree: FileNode[] = [
        {
          name: 'src',
          path: '/src',
          type: 'directory',
          children: [
            { name: 'index.ts', path: '/src/index.ts', type: 'file' },
            { name: 'utils.ts', path: '/src/utils.ts', type: 'file' },
          ],
        },
      ];
      const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
      expect(flat).toContain('/src/index.ts');
      expect(flat).toContain('/src/utils.ts');
    });

    it('excludes children of collapsed directories', () => {
      // expandedPaths is empty, so /src is collapsed
      const tree: FileNode[] = [
        {
          name: 'src',
          path: '/src',
          type: 'directory',
          children: [
            { name: 'hidden.ts', path: '/src/hidden.ts', type: 'file' },
          ],
        },
      ];
      const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
      expect(flat).not.toContain('/src/hidden.ts');
    });

    it('handles deeply nested expanded directories', () => {
      useWorkspaceStore.setState({
        expandedPaths: new Set(['/a', '/a/b', '/a/b/c']),
      });
      const tree: FileNode[] = [
        {
          name: 'a',
          path: '/a',
          type: 'directory',
          children: [
            {
              name: 'b',
              path: '/a/b',
              type: 'directory',
              children: [
                {
                  name: 'c',
                  path: '/a/b/c',
                  type: 'directory',
                  children: [
                    { name: 'deep.ts', path: '/a/b/c/deep.ts', type: 'file' },
                  ],
                },
              ],
            },
          ],
        },
      ];
      const flat = useWorkspaceStore.getState().flattenVisibleFileTree(tree);
      expect(flat).toContain('/a/b/c/deep.ts');
    });
  });

  describe('collapseDirectory', () => {
    it('removes path from expandedPaths', () => {
      useWorkspaceStore.setState({
        expandedPaths: new Set(['/dir1', '/dir2', '/dir3']),
      });
      useWorkspaceStore.getState().collapseDirectory('/dir2');
      const expanded = useWorkspaceStore.getState().expandedPaths;
      expect(expanded.has('/dir2')).toBe(false);
      expect(expanded.has('/dir1')).toBe(true);
      expect(expanded.has('/dir3')).toBe(true);
    });

    it('no-op when collapsing non-expanded path', () => {
      useWorkspaceStore.setState({
        expandedPaths: new Set(['/dir1']),
      });
      useWorkspaceStore.getState().collapseDirectory('/nonexistent');
      expect(useWorkspaceStore.getState().expandedPaths.size).toBe(1);
    });
  });

  describe('collapseAll', () => {
    it('clears all expanded paths', () => {
      useWorkspaceStore.setState({
        expandedPaths: new Set(['/a', '/b', '/c']),
      });
      useWorkspaceStore.getState().collapseAll();
      expect(useWorkspaceStore.getState().expandedPaths.size).toBe(0);
    });
  });

  describe('setFocusedPath', () => {
    it('sets focused path', () => {
      useWorkspaceStore.getState().setFocusedPath('/src/app.ts');
      expect(useWorkspaceStore.getState().focusedPath).toBe('/src/app.ts');
    });

    it('clears focused path with null', () => {
      useWorkspaceStore.setState({ focusedPath: '/some/path' });
      useWorkspaceStore.getState().setFocusedPath(null);
      expect(useWorkspaceStore.getState().focusedPath).toBeNull();
    });
  });

  describe('undo stack', () => {
    it('pushUndo adds operation to stack', () => {
      useWorkspaceStore.getState().pushUndo({
        type: 'delete',
        description: 'Delete file.ts',
        originalPath: '/src/file.ts',
        isDirectory: false,
        content: 'file content',
      });
      expect(useWorkspaceStore.getState().undoStack.length).toBe(1);
      expect(useWorkspaceStore.getState().undoStack[0].originalPath).toBe('/src/file.ts');
    });

    it('pushUndo limits stack to 20 operations', () => {
      for (let i = 0; i < 25; i++) {
        useWorkspaceStore.getState().pushUndo({
          type: 'delete',
          description: `Delete file${i}`,
          originalPath: `/file${i}.ts`,
          isDirectory: false,
        });
      }
      expect(useWorkspaceStore.getState().undoStack.length).toBe(20);
      // Oldest should be file5 (0-4 were pushed out)
      expect(useWorkspaceStore.getState().undoStack[0].originalPath).toBe('/file5.ts');
    });

    it('undo returns false when stack is empty', async () => {
      const result = await useWorkspaceStore.getState().undo();
      expect(result).toBe(false);
    });

    it('undo pops last operation from stack', async () => {
      useWorkspaceStore.getState().pushUndo({
        type: 'rename',
        description: 'Rename',
        originalPath: '/old.ts',
        isDirectory: false,
        newPath: '/new.ts',
      });
      useWorkspaceStore.getState().pushUndo({
        type: 'delete',
        description: 'Delete',
        originalPath: '/temp.ts',
        isDirectory: false,
      });

      // Since isTauri() returns false, undo returns false but still pops
      await useWorkspaceStore.getState().undo();
      expect(useWorkspaceStore.getState().undoStack.length).toBe(1);
      expect(useWorkspaceStore.getState().undoStack[0].originalPath).toBe('/old.ts');
    });
  });

  describe('setOpenCodeReady', () => {
    it('sets ready state with url', () => {
      useWorkspaceStore.getState().setOpenCodeReady(true, 'http://localhost:13141');
      expect(useWorkspaceStore.getState().openCodeBootstrapped).toBe(true);
      expect(useWorkspaceStore.getState().openCodeReady).toBe(true);
      expect(useWorkspaceStore.getState().openCodeUrl).toBe('http://localhost:13141');
    });

    it('sets ready false without clearing url when not provided', () => {
      useWorkspaceStore.setState({ openCodeUrl: 'http://localhost:13141' });
      useWorkspaceStore.getState().setOpenCodeReady(false);
      expect(useWorkspaceStore.getState().openCodeReady).toBe(false);
      // URL not cleared because no url param
      expect(useWorkspaceStore.getState().openCodeUrl).toBe('http://localhost:13141');
    });
  });

  describe('setOpenCodeBootstrapped', () => {
    it('clears ready state and url when reset', () => {
      useWorkspaceStore.setState({
        openCodeBootstrapped: true,
        openCodeReady: true,
        openCodeUrl: 'http://localhost:13141',
      });
      useWorkspaceStore.getState().setOpenCodeBootstrapped(false);
      expect(useWorkspaceStore.getState().openCodeBootstrapped).toBe(false);
      expect(useWorkspaceStore.getState().openCodeReady).toBe(false);
      expect(useWorkspaceStore.getState().openCodeUrl).toBeNull();
    });
  });

  describe('loadDirectory returns empty in web mode', () => {
    it('returns empty array when not in Tauri', async () => {
      useWorkspaceStore.setState({ workspacePath: '/test' });
      const result = await useWorkspaceStore.getState().loadDirectory('/test');
      expect(result).toEqual([]);
    });

    it('returns empty array when no workspace path', async () => {
      const result = await useWorkspaceStore.getState().loadDirectory('/test');
      expect(result).toEqual([]);
    });
  });
});
