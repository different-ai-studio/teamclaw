import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useCurrentTeamStore } from '@/stores/current-team'
import { VersionList } from '@/components/version/VersionList'
import { VersionPreview } from '@/components/version/VersionPreview'
import type { VersionedFileInfo } from '@/stores/version-history'

interface VersionHistoryDialogProps {
  file: VersionedFileInfo
  onClose: () => void
}

export function VersionHistoryDialog({ file, onClose }: VersionHistoryDialogProps) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id)

  const {
    fileVersions,
    selectedRef,
    loading,
    loadFileVersions,
    fetchVersionContent,
    restoreFileVersion,
    selectFile,
    selectVersion,
  } = useVersionHistoryStore()

  const [restoring, setRestoring] = useState(false)
  const [versionContent, setVersionContent] = useState<string | null>(null)

  useEffect(() => {
    selectFile(file.path)
    if (teamId) {
      loadFileVersions(teamId, file.path)
    }
  }, [file.path, teamId, selectFile, loadFileVersions])

  const handleVersionSelect = (ref: string) => {
    selectVersion(ref)
  }

  useEffect(() => {
    let cancelled = false
    if (teamId && selectedRef) {
      fetchVersionContent(teamId, file.path, selectedRef).then((content) => {
        if (!cancelled) setVersionContent(content)
      })
    } else {
      setVersionContent(null)
    }
    return () => {
      cancelled = true
    }
  }, [teamId, file.path, selectedRef, fetchVersionContent])

  const handleRestore = async () => {
    if (!teamId || !selectedRef) return
    setRestoring(true)
    try {
      await restoreFileVersion(teamId, file.path, selectedRef)
    } finally {
      setRestoring(false)
    }
  }

  const fileName = file.path.split('/').pop() ?? file.path

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative flex h-[70vh] w-[800px] max-w-[90vw] flex-col rounded-xl border bg-background shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
          <div>
            <h3 className="text-[13px] font-semibold">{fileName}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{file.status}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Version list */}
          <div className="w-[240px] shrink-0 border-r overflow-hidden">
            {loading && fileVersions.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t('common.loading')}
              </div>
            ) : (
              <VersionList
                versions={fileVersions}
                selectedRef={selectedRef}
                onSelect={handleVersionSelect}
              />
            )}
          </div>

          {/* Right: Version preview */}
          <div className="flex-1 overflow-hidden">
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
    </div>
  )
}
