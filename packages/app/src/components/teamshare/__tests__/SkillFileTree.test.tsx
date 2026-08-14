import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const t = (k: string, d?: string) => d ?? k

const { mockReadDir, mockCreateFile, mockDelete } = vi.hoisted(() => ({
  mockReadDir: vi.fn(),
  mockCreateFile: vi.fn(async () => true),
  mockDelete: vi.fn(async () => true),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: mockReadDir }))
vi.mock('@/components/workspace/file-tree-operations', () => ({
  createNewFile: mockCreateFile,
  createNewFolder: vi.fn(async () => true),
  deleteItem: mockDelete,
  revealInFinder: vi.fn(),
}))
// The real one drags in the tabs store, git status and team permissions; none
// of that is what this tree is being tested for.
vi.mock('@/components/workspace/FileTreeNode', () => ({
  InlineInput: ({ onConfirm }: { onConfirm: (v: string) => void }) => (
    <input data-testid="inline-input" onKeyDown={(e) => e.key === 'Enter' && onConfirm('run.sh')} />
  ),
}))

import { SkillFileTree } from '../SkillFileTree'

const PACK = '/home/u/.agents/skills/deploy-check'

function dirEntry(name: string) {
  return { name, isDirectory: true, isFile: false, isSymlink: false }
}
function fileEntry(name: string) {
  return { name, isDirectory: false, isFile: true, isSymlink: false }
}

describe('SkillFileTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadDir.mockImplementation(async (path: string) => {
      if (path === PACK) {
        return [
          fileEntry('README.md'),
          dirEntry('scripts'),
          fileEntry('SKILL.md'),
          dirEntry('.clawhub'),
        ]
      }
      if (path === `${PACK}/scripts`) return [fileEntry('check.sh')]
      return []
    })
  })

  it('puts SKILL.md first, folders before files, and hides the bookkeeping dir', async () => {
    render(<SkillFileTree packDir={PACK} selectedRel={null} onSelectFile={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('SKILL.md')).toBeTruthy())
    const names = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter(Boolean)
    expect(names).toEqual(['SKILL.md', 'scripts', 'README.md'])
    expect(screen.queryByText('.clawhub')).toBeNull()
  })

  it('reports the clicked file as a path relative to the package root', async () => {
    const onSelectFile = vi.fn()
    render(<SkillFileTree packDir={PACK} selectedRel={null} onSelectFile={onSelectFile} />)

    await waitFor(() => expect(screen.getByText('scripts')).toBeTruthy())
    fireEvent.click(screen.getByText('scripts'))
    await waitFor(() => expect(screen.getByText('check.sh')).toBeTruthy())

    fireEvent.click(screen.getByText('check.sh'))
    expect(onSelectFile).toHaveBeenCalledWith('scripts/check.sh')
  })

  it('creates at the package root and opens what it just made', async () => {
    const onSelectFile = vi.fn()
    const onMutated = vi.fn()
    render(
      <SkillFileTree
        packDir={PACK}
        selectedRel={null}
        onSelectFile={onSelectFile}
        onMutated={onMutated}
        rootCreate="file"
      />,
    )

    await waitFor(() => expect(screen.getByTestId('inline-input')).toBeTruthy())
    fireEvent.keyDown(screen.getByTestId('inline-input'), { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith(PACK, 'run.sh'))
    expect(onMutated).toHaveBeenCalled()
    expect(onSelectFile).toHaveBeenCalledWith('run.sh')
  })
})
