import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

// Mock all heavy dependencies
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string) => fallback,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      reloadSelectedFile: vi.fn(),
      targetLine: null,
      targetHeading: null,
      workspacePath: '/workspace',
    }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ sessionDiff: [] }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    { getState: () => ({ setFileModeRightTab: vi.fn() }) },
  ),
}))

vi.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({ gitStatuses: new Map() }),
}))

vi.mock('@/lib/git/manager', () => ({
  gitManager: { showFile: vi.fn().mockRejectedValue(new Error('not tracked')) },
}))

vi.mock('@/components/editors/utils', () => ({
  getEditorType: () => 'code',
  supportsPreview: () => null,
}))

vi.mock('@/components/editors/useAutoSave', () => ({
  useAutoSave: () => ({
    saveStatus: 'saved',
    isSelfWrite: vi.fn().mockResolvedValue(false),
    saveNow: vi.fn(),
    cancelPendingSave: vi.fn(),
  }),
}))

vi.mock('@/components/editors/ConflictBanner', () => ({
  ConflictBanner: () => null,
}))

vi.mock('@/components/viewers/UnsupportedFileViewer', () => ({
  default: () => <div>Unsupported</div>,
  UNSUPPORTED_BINARY_EXTENSIONS: new Set(['exe', 'dll']),
}))

import { getFileType, FileContentViewer } from '@/components/FileEditor'

describe('FileEditor', () => {
  it('getFileType classifies images correctly', () => {
    expect(getFileType('photo.png')).toBe('image')
    expect(getFileType('logo.svg')).toBe('image')
    expect(getFileType('pic.jpg')).toBe('image')
  })

  it('getFileType classifies text files as text', () => {
    expect(getFileType('main.ts')).toBe('text')
    expect(getFileType('readme.md')).toBe('text')
  })

  it('getFileType classifies pdf files', () => {
    expect(getFileType('doc.pdf')).toBe('pdf')
  })

  it('FileContentViewer shows empty state when no file selected', () => {
    render(
      <FileContentViewer
        selectedFile={null}
        fileContent={null}
        isLoadingFile={false}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Select a file from the explorer')).toBeDefined()
  })

  it('FileContentViewer shows unable-to-load when content is null but file selected', () => {
    render(
      <FileContentViewer
        selectedFile="/workspace/src/main.ts"
        fileContent={null}
        isLoadingFile={false}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Unable to load file content')).toBeDefined()
  })
})
