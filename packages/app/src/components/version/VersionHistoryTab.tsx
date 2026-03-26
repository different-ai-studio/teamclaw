import { useEffect, useState } from 'react'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useWorkspaceStore } from '@/stores/workspace'
import { VersionedFileList } from '@/components/version/VersionedFileList'
import { VersionList } from '@/components/version/VersionList'
import { VersionPreview } from '@/components/version/VersionPreview'

export function VersionHistoryTab() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const {
    versionedFiles,
    fileVersions,
    selectedFile,
    selectedVersionIndex,
    loading,
    loadVersionedFiles,
    loadFileVersions,
    restoreFileVersion,
    selectFile,
    selectVersion,
  } = useVersionHistoryStore()

  const [docTypeFilter, setDocTypeFilter] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (workspacePath) {
      loadVersionedFiles(workspacePath)
    }
  }, [workspacePath, loadVersionedFiles])

  const handleFileSelect = (path: string, docType: string) => {
    selectFile(path, docType)
    if (workspacePath) {
      loadFileVersions(workspacePath, docType, path)
    }
  }

  const handleFilterChange = (filter: string | null) => {
    setDocTypeFilter(filter)
    if (workspacePath) {
      loadVersionedFiles(workspacePath, filter ?? undefined)
    }
  }

  const handleVersionSelect = (index: number) => {
    if (index === -1) {
      selectVersion(null)
    } else {
      selectVersion(index)
    }
  }

  const handleRestore = async () => {
    if (!workspacePath || !selectedFile || selectedVersionIndex === null) return
    setRestoring(true)
    try {
      await restoreFileVersion(
        workspacePath,
        selectedFile.docType,
        selectedFile.path,
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

  const selectedFileInfo = selectedFile
    ? versionedFiles.find(
        (f) => f.path === selectedFile.path && f.docType === selectedFile.docType,
      )
    : null

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Versioned file list */}
      <div className="w-[220px] shrink-0 border-r flex flex-col overflow-hidden">
        <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          文件列表
          {loading && <span className="ml-2 text-[10px] font-normal normal-case">加载中...</span>}
        </div>
        <div className="flex-1 overflow-hidden">
          <VersionedFileList
            files={versionedFiles}
            selectedPath={selectedFile?.path ?? null}
            selectedDocType={selectedFile?.docType ?? null}
            onSelect={handleFileSelect}
            docTypeFilter={docTypeFilter}
            onFilterChange={handleFilterChange}
          />
        </div>
      </div>

      {/* Middle: Version list */}
      <div className="w-[200px] shrink-0 border-r flex flex-col overflow-hidden">
        <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          版本历史
        </div>
        <div className="flex-1 overflow-hidden">
          {selectedFile ? (
            <VersionList
              versions={fileVersions}
              selectedIndex={selectedVersionIndex}
              onSelect={handleVersionSelect}
              currentUpdatedBy={selectedFileInfo?.latestUpdateBy}
              currentUpdatedAt={selectedFileInfo?.latestUpdateAt}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground px-3 text-center">
              请从左侧选择文件
            </div>
          )}
        </div>
      </div>

      {/* Right: Version preview */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <VersionPreview
          version={selectedVersion}
          canRestore={selectedVersionIndex !== null}
          onRestore={handleRestore}
          restoring={restoring}
        />
      </div>
    </div>
  )
}
