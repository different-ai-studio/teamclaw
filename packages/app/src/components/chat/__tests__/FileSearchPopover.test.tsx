import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileSearchPopover } from '../FileSearchPopover'

const mockFiles = [
  '/workspace/src/App.tsx',
  '/workspace/src/index.ts',
  '/workspace/package.json',
]

const mockFlatten = vi.fn(() => mockFiles)

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      fileTree: [],
      flattenVisibleFileTree: mockFlatten,
      workspacePath: '/workspace',
    }),
}))

describe('FileSearchPopover', () => {
  let resizeObserverMock: { observe: typeof vi.fn; unobserve: typeof vi.fn; disconnect: typeof vi.fn }

  beforeEach(() => {
    vi.clearAllMocks()
    mockFlatten.mockReturnValue(mockFiles)
    Element.prototype.scrollIntoView = vi.fn()
    resizeObserverMock = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }
    global.ResizeObserver = vi.fn(() => resizeObserverMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders file list when open', () => {
    render(
      <FileSearchPopover
        open={true}
        onOpenChange={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('App.tsx')).toBeDefined()
  })

  it('filters files by search query', () => {
    render(
      <FileSearchPopover
        open={true}
        onOpenChange={vi.fn()}
        searchQuery="package"
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getAllByText('package.json').length).toBeGreaterThan(0)
    expect(screen.queryByText('App.tsx')).toBeNull()
  })

  it('calls onSelect when file is clicked', () => {
    const onSelect = vi.fn()
    render(
      <FileSearchPopover
        open={true}
        onOpenChange={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByText('App.tsx'))
    expect(onSelect).toHaveBeenCalledWith({
      name: 'App.tsx',
      path: '/workspace/src/App.tsx',
    })
  })

  it('does not render when closed', () => {
    render(
      <FileSearchPopover
        open={false}
        onOpenChange={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    expect(screen.queryByText('Search files...')).toBeNull()
  })
})