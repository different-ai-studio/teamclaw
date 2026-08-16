import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionSelectionStore } from '../session-selection-store'
import { useTabsStore } from '../tabs'
import { useUIStore, type SidebarFilter } from '../ui'
import { useWorkspaceStore } from '../workspace'

const OTHER_DESTINATIONS: SidebarFilter[] = [
  { kind: 'all' },
  { kind: 'actors' },
  { kind: 'ideas' },
  { kind: 'apps' },
  { kind: 'shortcuts' },
  { kind: 'teamShare', section: 'skills' },
  { kind: 'teamShare', section: 'mcp' },
  { kind: 'teamShare', section: 'env' },
]

describe('sidebar navigation from a knowledge file', () => {
  beforeEach(() => {
    useTabsStore.getState().closeAll()
    useUIStore.setState({
      sidebarFilter: { kind: 'teamShare', section: 'knowledge' },
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  it.each(OTHER_DESTINATIONS)('hides the file viewer when navigating to $kind', (destination) => {
    useTabsStore.getState().openTab({
      type: 'file',
      target: '/workspace/teamclu-team/knowledge/spec.md',
      label: 'spec.md',
    })

    useUIStore.getState().setSidebarFilter(destination)

    expect(useTabsStore.getState().activeTabId).toBeNull()
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(useUIStore.getState().sidebarFilter).toEqual(destination)
  })

  it('keeps the active file visible when Knowledge is selected again', () => {
    useTabsStore.getState().openTab({
      type: 'file',
      target: '/workspace/teamclu-team/knowledge/spec.md',
      label: 'spec.md',
    })
    const activeTabId = useTabsStore.getState().activeTabId

    useUIStore.getState().setSidebarFilter({ kind: 'teamShare', section: 'knowledge' })

    expect(useTabsStore.getState().activeTabId).toBe(activeTabId)
  })

  it('hides the file viewer when switching to the already-active session', async () => {
    useTabsStore.getState().openTab({
      type: 'file',
      target: '/workspace/teamclu-team/knowledge/spec.md',
      label: 'spec.md',
    })
    useWorkspaceStore.setState({
      selectedFile: '/workspace/teamclu-team/knowledge/spec.md',
      selectedFiles: ['/workspace/teamclu-team/knowledge/spec.md'],
      fileContent: '# Spec',
    })
    useSessionSelectionStore.setState({ activeSessionId: 'session-1' })

    await useUIStore.getState().switchToSession('session-1')

    expect(useTabsStore.getState().activeTabId).toBeNull()
    expect(useWorkspaceStore.getState().selectedFile).toBeNull()
    expect(useUIStore.getState().currentView).toBe('chat')
  })
})
