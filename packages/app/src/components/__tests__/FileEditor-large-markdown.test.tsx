import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

const mermaidInitializeMock = vi.fn()
const mermaidRenderMock = vi.fn(async (id: string, code: string) => ({
  svg: `<svg data-testid="mermaid-svg" data-diagram-id="${id}"><text>${code}</text></svg>`,
}))
const codeToHtmlMock = vi.fn((code: string) =>
  `<pre data-testid="highlighted-code"><code><span style="color:#cf222e">${code}</span></code></pre>`,
)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      targetLine: null,
      targetHeading: null,
      workspacePath: '/workspace',
    }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ sessionDiff: [] }),
    { getState: () => ({ sendMessage: vi.fn() }) },
  ),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    { getState: () => ({ setFileModeRightTab: vi.fn() }) },
  ),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ myRole: 'owner' }),
}))

vi.mock('@/lib/git/manager', () => ({
  gitManager: {
    showFile: vi.fn().mockRejectedValue(new Error('not tracked')),
    logFile: vi.fn().mockResolvedValue([]),
  },
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

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogContent: ({ children, className }: React.PropsWithChildren<{ className?: string }>) =>
    React.createElement('div', { className, 'data-testid': 'dialog-content' }, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}))

vi.mock('@/components/editors/TiptapMarkdownEditor', () => ({
  default: React.forwardRef(() => <div data-testid="tiptap-markdown-editor" />),
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidInitializeMock,
    render: mermaidRenderMock,
  },
}))

vi.mock('@/components/diff/shiki-renderer', () => ({
  getHighlighter: vi.fn(async () => ({
    codeToHtml: codeToHtmlMock,
  })),
  mapLanguage: (language: string) => (language === 'ts' ? 'typescript' : language),
}))

vi.mock('@/components/editors/CodeEditor', () => ({
  default: () => <div data-testid="code-editor" />,
}))

vi.mock('@/components/diff/DiffRenderer', () => ({
  default: () => <div data-testid="diff-renderer" />,
}))

vi.mock('@/components/version/FileHistoryView', () => ({
  default: () => <div data-testid="file-history-view" />,
}))

import { MAX_MARKDOWN_WYSIWYG_CHARS } from '@/components/editors/utils'
import { FileEditor } from '@/components/FileEditor'

describe('FileEditor large markdown routing', () => {
  it('uses CodeMirror for large markdown documents', async () => {
    const content = '# Issue Review\n\n' + 'A'.repeat(MAX_MARKDOWN_WYSIWYG_CHARS + 1)

    render(
      <FileEditor
        content={content}
        filename="SPAYS-17321.md"
        filePath="/workspace/knowledge/SPAYS-17321.md"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('code-editor')).toBeTruthy()
    expect(screen.queryByTestId('tiptap-markdown-editor')).toBeNull()
  })

  it('opens small markdown documents in preview and can switch to the Tiptap editor', async () => {
    render(
      <FileEditor
        content="# Notes\n\nSmall file"
        filename="README.md"
        filePath="/workspace/README.md"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('markdown-preview')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Edit mode'))
    expect(await screen.findByTestId('tiptap-markdown-editor')).toBeTruthy()
    expect(screen.queryByTestId('code-editor')).toBeNull()
  })

  it('renders mermaid diagrams in the markdown file preview', async () => {
    render(
      <FileEditor
        content={[
          '### Runtime Matching',
          '',
          '```mermaid',
          'sequenceDiagram',
          '    participant Runtime as Upstream Runtime Job',
          '    participant CondDB as Upstream Condition DB',
          '    Runtime->>CondDB: Load enabled NodeCondition list',
          '```',
        ].join('\n')}
        filename="README.md"
        filePath="/workspace/README.md"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('markdown-preview')).toBeTruthy()
    expect(await screen.findByTestId('mermaid-block')).toBeTruthy()
    expect(await screen.findByTestId('mermaid-svg')).toBeTruthy()
    expect(screen.queryByTestId('tiptap-markdown-editor')).toBeNull()
    expect(mermaidRenderMock).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      expect.stringContaining('sequenceDiagram'),
    )
  })

  it('syntax highlights code blocks in the markdown file preview', async () => {
    render(
      <FileEditor
        content={[
          '# Example',
          '',
          '```ts',
          'const answer: number = 42',
          '```',
        ].join('\n')}
        filename="README.md"
        filePath="/workspace/README.md"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('markdown-preview')).toBeTruthy()
    expect(await screen.findByTestId('highlighted-code')).toBeTruthy()
    expect(codeToHtmlMock).toHaveBeenCalledWith(
      'const answer: number = 42',
      { lang: 'typescript', theme: 'github-light' },
    )
  })
})
