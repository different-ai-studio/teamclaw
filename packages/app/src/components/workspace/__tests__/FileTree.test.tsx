import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

// Mutable state that tests can modify
let mockFileTree: any[] = []
let mockExpandedPaths = new Set<string>()

const mockSelectFile = vi.fn()
const mockExpandDirectory = vi.fn().mockResolvedValue(undefined)
const mockCollapseDirectory = vi.fn()

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({
        fileTree: mockFileTree,
        expandedPaths: mockExpandedPaths,
        loadingPaths: new Set<string>(),
        selectedFile: null,
        selectedFiles: [],
        workspacePath: '/workspace',
        focusedPath: null,
        selectFile: mockSelectFile,
        selectFileRange: vi.fn(),
        toggleFileSelection: vi.fn(),
        expandDirectory: mockExpandDirectory,
        collapseDirectory: mockCollapseDirectory,
        setFocusedPath: vi.fn(),
        pushUndo: vi.fn(),
        refreshFileTree: vi.fn().mockResolvedValue(undefined),
        clearSelection: vi.fn(),
      }),
    {
      getState: () => ({
        selectedFiles: [],
        fileTree: mockFileTree,
        clearSelection: vi.fn(),
      }),
    },
  ),
}))

vi.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({ gitStatuses: new Map() }),
}))

vi.mock('@/stores/git-settings', () => ({
  useGitSettingsStore: () => ({
    showGitStatus: false,
    showStatusIcons: false,
    statusColors: {},
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  copyToClipboard: vi.fn(),
}))

// Mock the FileTreeNode and operations
vi.mock('../FileTreeNode', () => ({
  FileTreeItem: ({ node, onSelectFile, onExpandDirectory, isExpanded }: any) => (
    <div
      data-testid={`tree-item-${node.name}`}
      data-path={node.path}
      onClick={() =>
        node.type === 'file'
          ? onSelectFile(node.path)
          : isExpanded
            ? vi.fn()
            : onExpandDirectory(node.path)
      }
    >
      {node.name}
    </div>
  ),
  InlineInput: () => null,
}))

vi.mock('../file-tree-operations', () => ({
  createNewFile: vi.fn(),
  createNewFolder: vi.fn(),
  renameItem: vi.fn(),
  deleteItem: vi.fn(),
  revealInFinder: vi.fn(),
  openWithDefaultApp: vi.fn(),
  openInTerminal: vi.fn(),
  moveItem: vi.fn(),
  readFileContent: vi.fn(),
}))

import { FileTree } from '@/components/workspace/FileTree'

describe('FileTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFileTree = []
    mockExpandedPaths = new Set()
  })

  it('shows "No files found" when file tree is empty', () => {
    mockFileTree = []
    render(<FileTree />)
    expect(screen.getByText('No files found')).toBeDefined()
  })

  it('renders file tree items when tree has entries', () => {
    mockFileTree = [
      { name: 'src', path: '/workspace/src', type: 'directory', children: [] },
      { name: 'package.json', path: '/workspace/package.json', type: 'file' },
    ]

    render(<FileTree />)

    expect(screen.getByTestId('tree-item-src')).toBeDefined()
    expect(screen.getByTestId('tree-item-package.json')).toBeDefined()
  })

  it('shows "No files match filter" when filter has no results', () => {
    mockFileTree = [
      { name: 'src', path: '/workspace/src', type: 'directory', children: [] },
    ]

    render(<FileTree filterText="zzzzzzz_nonexistent" />)

    expect(screen.getByText('No files match filter')).toBeDefined()
  })

  it('renders expanded directory children', () => {
    mockFileTree = [
      {
        name: 'src',
        path: '/workspace/src',
        type: 'directory',
        children: [
          { name: 'main.ts', path: '/workspace/src/main.ts', type: 'file' },
        ],
      },
    ]
    mockExpandedPaths = new Set(['/workspace/src'])

    render(<FileTree />)

    expect(screen.getByTestId('tree-item-src')).toBeDefined()
    expect(screen.getByTestId('tree-item-main.ts')).toBeDefined()
  })
})
