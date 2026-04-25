import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const fileBrowserMock = vi.hoisted(() => vi.fn(() => <div data-testid="file-browser" />))

const workspaceState = vi.hoisted(() => ({
  workspacePath: '/workspace',
  refreshFileTree: vi.fn(),
  selectFile: vi.fn(),
}))

const teamModeState = vi.hoisted(() => ({
  teamMode: true,
  teamModeType: null as string | null,
}))

const uiState = vi.hoisted(() => ({
  advancedMode: false,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/components/workspace/FileBrowser', () => ({
  FileBrowser: fileBrowserMock,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) => selector(workspaceState),
}))

vi.mock('@/stores/knowledge', () => ({
  useKnowledgeStore: (selector: (state: { createNoteFromLink: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ createNoteFromLink: vi.fn() }),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (selector: (state: typeof teamModeState) => unknown) => selector(teamModeState),
    {
      setState: vi.fn(),
      getState: () => ({
        loadTeamGitFileSyncStatus: vi.fn(),
      }),
    },
  ),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: typeof uiState) => unknown) => selector(uiState),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
}))

vi.mock('@/lib/build-config', () => ({
  TEAM_REPO_DIR: 'teamclaw-team',
}))

import { KnowledgeBrowser } from '../KnowledgeBrowser'

describe('KnowledgeBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceState.workspacePath = '/workspace'
    teamModeState.teamMode = true
    teamModeState.teamModeType = null
    uiState.advancedMode = false
  })

  it('does not render team/personal virtual document roots in basic mode', () => {
    render(<KnowledgeBrowser />)

    const props = fileBrowserMock.mock.calls[0][0] as Record<string, unknown>
    expect(props).not.toHaveProperty('rootPath')
    expect(props).not.toHaveProperty('rootPaths')
    expect(props).not.toHaveProperty('rootLabels')
    expect(props.hideGitStatus).toBe(false)
  })
})
