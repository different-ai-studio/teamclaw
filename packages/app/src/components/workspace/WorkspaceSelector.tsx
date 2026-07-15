import { useTranslation } from 'react-i18next'
import { FolderOpen, Loader2 } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'

import { useWorkspaceStore } from '@/stores/workspace'
import { Button } from '@/components/ui/button'

export function WorkspaceSelector() {
  const { t } = useTranslation()
  const workspaceName = useWorkspaceStore(s => s.workspaceName)
  const isLoadingWorkspace = useWorkspaceStore(s => s.isLoadingWorkspace)
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)

  const handleOpenFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Project Folder',
      })
      
      if (selected && typeof selected === 'string') {
        await setWorkspace(selected)
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-2 px-2 text-muted-foreground hover:text-foreground"
      disabled={isLoadingWorkspace}
      onClick={handleOpenFolder}
    >
      {isLoadingWorkspace ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <FolderOpen className="h-4 w-4" />
      )}
      <span className="max-w-[150px] truncate text-sm">
        {workspaceName || t('workspace.noProject', 'No Project')}
      </span>
    </Button>
  )
}
