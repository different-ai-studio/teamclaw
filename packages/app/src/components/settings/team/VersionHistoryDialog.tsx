import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useWorkspaceStore } from '@/stores/workspace'
import { VersionList } from '@/components/version/VersionList'
import { VersionPreview } from '@/components/version/VersionPreview'
import type { VersionedFileInfo } from '@/stores/version-history'

interface VersionHistoryDialogProps {
  file: VersionedFileInfo
  onClose: () => void
}

export function VersionHistoryDialog({ file, onClose }: VersionHistoryDialogProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const {
    fileVersions,
    selectedVersionIndex,
    loading,
    loadFileVersions,
    restoreFileVersion,
    selectFile,
    selectVersion,
  } = useVersionHistoryStore()

  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    selectFile(file.path, file.docType)
    if (workspacePath) {
      loadFileVersions(workspacePath, file.docType, file.path)
    }
  }, [file.path, file.docType, workspacePath, selectFile, loadFileVersions])

  const handleVersionSelect = (index: number) => {
    if (index === -1) {
      selectVersion(null)
    } else {
      selectVersion(index)
    }
  }

  const handleRestore = async () => {
    if (!workspacePath || selectedVersionIndex === null) return
    setRestoring(true)
    try {
      await restoreFileVersion(
        workspacePath,
        file.docType,
        file.path,
        selectedVersionIndex,
      )
    } finally {
      setRestoring(false)
    }
  }

  const selectedVersion =
    selectedVersionIndex !== null
      ? (fileVersions.find((v) => v.index === selectedVersionIndex) ?? null)
      : null

  const fileName = file.path.split('/').pop() ?? file.path

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative flex h-[70vh] w-[800px] max-w-[90vw] flex-col rounded-xl border bg-background shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
          <div>
            <h3 className="text-sm font-semibold">{fileName}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings.team.historicalVersions', { count: file.versionCount })}
            </p>
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
                selectedIndex={selectedVersionIndex}
                onSelect={handleVersionSelect}
                currentUpdatedBy={file.latestUpdateBy}
                currentUpdatedAt={file.latestUpdateAt}
              />
            )}
          </div>

          {/* Right: Version preview */}
          <div className="flex-1 overflow-hidden">
            <VersionPreview
              version={selectedVersion}
              canRestore={selectedVersionIndex !== null}
              onRestore={handleRestore}
              restoring={restoring}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
