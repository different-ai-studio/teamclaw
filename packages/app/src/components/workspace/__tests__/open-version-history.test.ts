import { describe, test, expect, vi, beforeEach } from 'vitest'

const { openTab, openKnowledgeVersions, selectFile, loadFileVersions, uiState, teamState } =
  vi.hoisted(() => ({
    openTab: vi.fn(),
    openKnowledgeVersions: vi.fn(),
    selectFile: vi.fn(),
    loadFileVersions: vi.fn(async () => undefined),
    uiState: { sidebarFilter: { kind: 'all' } as { kind: string; section?: string } },
    teamState: { team: { id: 'team-1' } as { id: string } | null },
  }))

vi.mock('@/stores/tabs', () => ({ useTabsStore: { getState: () => ({ openTab }) } }))
vi.mock('@/stores/ui', () => ({ useUIStore: { getState: () => uiState } }))
vi.mock('@/stores/current-team', () => ({ useCurrentTeamStore: { getState: () => teamState } }))
vi.mock('@/stores/version-history', () => ({
  useVersionHistoryStore: { getState: () => ({ selectFile, loadFileVersions }) },
}))
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: { getState: () => ({ openKnowledgeVersions }) },
}))
// The module under test is a leaf helper inside a component file; the rest of
// that file drags in the whole tree UI, which this has nothing to do with.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d }) }))
vi.mock('@/lib/team-permissions', () => ({ useTeamPermissions: () => ({}) }))

import { openVersionHistory } from '../FileTreeNode'

describe('openVersionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uiState.sidebarFilter = { kind: 'all' }
    teamState.team = { id: 'team-1' }
  })

  test('opens in the detail pane while team share owns the main column', () => {
    // App.tsx renders TeamShareDetailPane *instead of* the tab area here, so a
    // tab would exist with nothing to render it — the panel never appears.
    uiState.sidebarFilter = { kind: 'teamShare', section: 'knowledge' }

    openVersionHistory('/team/knowledge/spec.md', 'Version history')

    expect(openKnowledgeVersions).toHaveBeenCalledWith('/team/knowledge/spec.md')
    expect(openTab).not.toHaveBeenCalled()
  })

  test('opens a tab everywhere else, on the file that was right-clicked', () => {
    openVersionHistory('/ws/docs/spec.md', 'Version history')

    expect(openTab).toHaveBeenCalledWith({
      type: 'native',
      target: 'version-history',
      label: 'Version history',
    })
    // Without these two the tab opens on the team-wide file list with nothing
    // selected, which is not what right-clicking one file asks for.
    expect(selectFile).toHaveBeenCalledWith('/ws/docs/spec.md')
    expect(loadFileVersions).toHaveBeenCalledWith('team-1', '/ws/docs/spec.md')
  })

  test('still opens the tab when there is no current team', () => {
    teamState.team = null

    openVersionHistory('/ws/docs/spec.md', 'Version history')

    expect(openTab).toHaveBeenCalled()
    expect(loadFileVersions).not.toHaveBeenCalled()
  })
})
