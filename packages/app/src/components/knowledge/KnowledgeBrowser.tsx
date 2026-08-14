import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'

interface KnowledgeBrowserProps {
  hidePanelToolbar?: boolean
  filterText?: string
  onFilterTextChange?: (value: string) => void
  searchExpanded?: boolean
  onSearchExpandedChange?: (value: boolean) => void
}

export function KnowledgeBrowser({
  hidePanelToolbar = false,
  filterText,
  onFilterTextChange,
  searchExpanded,
  onSearchExpandedChange,
}: KnowledgeBrowserProps = {}) {
  const workspacePath = useWorkspaceStore(s => s.workspacePath)

  if (!workspacePath) return null

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <FileBrowser
        variant="panel"
        hideToolbar={hidePanelToolbar}
        filterText={filterText}
        onFilterTextChange={onFilterTextChange}
        searchExpanded={searchExpanded}
        onSearchExpandedChange={onSearchExpandedChange}
      />
    </div>
  )
}
