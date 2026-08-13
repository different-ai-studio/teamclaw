import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, History } from 'lucide-react'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { Button } from '@/components/ui/button'
import { VersionList } from '@/components/version/VersionList'
import { VersionPreview } from '@/components/version/VersionPreview'

/**
 * Version history for one knowledge document, inside the detail pane.
 *
 * The workspace tree's own entry point opens a main-area tab, which this view
 * has no room for: in team-share mode the main area *is* this pane. It also
 * drops the file list of the tab version — the user right-clicked a specific
 * document, so picking one again would be asking a question they answered.
 */
export function KnowledgeVersionHistory({ path }: { path: string }) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id)
  const selectedFile = useWorkspaceStore((s) => s.selectedFile)
  const close = useTeamShareBrowserStore((s) => s.closeKnowledgeVersions)

  const fileVersions = useVersionHistoryStore((s) => s.fileVersions)
  const selectedRef = useVersionHistoryStore((s) => s.selectedRef)
  const loading = useVersionHistoryStore((s) => s.loading)
  const selectFile = useVersionHistoryStore((s) => s.selectFile)
  const selectVersion = useVersionHistoryStore((s) => s.selectVersion)
  const loadFileVersions = useVersionHistoryStore((s) => s.loadFileVersions)
  const fetchVersionContent = useVersionHistoryStore((s) => s.fetchVersionContent)
  const restoreFileVersion = useVersionHistoryStore((s) => s.restoreFileVersion)

  const [versionContent, setVersionContent] = React.useState<string | null>(null)
  const [restoring, setRestoring] = React.useState(false)

  const name = path.slice(path.lastIndexOf('/') + 1)

  // Opening on a document that isn't the selected one is normal — a right-click
  // does not have to move the selection. So close on the selection *changing*
  // from whatever it was at open time, not on it merely differing from `path`.
  const openedWith = React.useRef(selectedFile)
  React.useEffect(() => {
    if (selectedFile !== openedWith.current) close()
  }, [selectedFile, close])

  React.useEffect(() => {
    selectFile(path)
    if (teamId) void loadFileVersions(teamId, path)
  }, [path, teamId, selectFile, loadFileVersions])

  React.useEffect(() => {
    let cancelled = false
    if (teamId && selectedRef) {
      void fetchVersionContent(teamId, path, selectedRef).then((content) => {
        if (!cancelled) setVersionContent(content)
      })
    } else {
      setVersionContent(null)
    }
    return () => {
      cancelled = true
    }
  }, [teamId, path, selectedRef, fetchVersionContent])

  const handleRestore = React.useCallback(async () => {
    if (!teamId || !selectedRef) return
    setRestoring(true)
    try {
      await restoreFileVersion(teamId, path, selectedRef)
    } finally {
      setRestoring(false)
    }
  }, [teamId, path, selectedRef, restoreFileVersion])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={close}
          title={t('common.back', 'Back')}
          data-testid="knowledge-versions-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
            <History className="h-3 w-3" />
            {t('versionHistory.title', 'Version history')}
          </div>
          <div className="truncate text-[15px] font-bold text-foreground">{name}</div>
        </div>
        {loading && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t('common.loading', 'Loading...')}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-[200px] shrink-0 flex-col overflow-hidden border-r border-border">
          <VersionList
            versions={fileVersions}
            selectedRef={selectedRef}
            onSelect={selectVersion}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <VersionPreview
            hasSelection={selectedRef !== null}
            content={versionContent}
            canRestore={selectedRef !== null}
            onRestore={handleRestore}
            restoring={restoring}
          />
        </div>
      </div>
    </div>
  )
}
