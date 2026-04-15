import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  Loader2,
  Upload,
  RefreshCw,
  Trash2,
  Edit2,
  AlertCircle,
  Eye,
  Search,
  FolderPlus,
  Folder,
  File,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Check as CheckboxIcon,
} from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspace'
import { useUIStore } from '@/stores/ui'
import { useKnowledgeStore } from '@/stores/knowledge'
import { cn, isTauri } from '@/lib/utils'
import { markTeamFileDeleted } from '@/components/workspace/file-tree-operations'
import { classifyFileType, filterKnowledgeItems, type KnowledgeItem } from '@/lib/knowledge-utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard, SectionHeader } from './shared'
import { toast } from 'sonner'
import { IndexStatusPanel } from '../knowledge/IndexStatusPanel'
import { KnowledgeSearchPreview } from '../knowledge/KnowledgeSearchPreview'
import { KnowledgeConfigPanel } from './KnowledgeConfigPanel'

export const KnowledgeSection = React.memo(function KnowledgeSection() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const selectFile = useWorkspaceStore((s) => s.selectFile)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const { startIndex, needsReindex, isIndexing } = useKnowledgeStore()
  
  const [items, setItems] = React.useState<KnowledgeItem[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedItems, setSelectedItems] = React.useState<Set<string>>(new Set())
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(new Set(['knowledge']))
  const [searchQuery, setSearchQuery] = React.useState('')
  const [isUploading, setIsUploading] = React.useState(false)
  
  // Dialog states
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const [itemsToDelete, setItemsToDelete] = React.useState<string[]>([])
  const [newFolderDialogOpen, setNewFolderDialogOpen] = React.useState(false)
  const [newFolderName, setNewFolderName] = React.useState('')
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [itemToRename, setItemToRename] = React.useState<string>('')
  const [newName, setNewName] = React.useState('')

  const loadKnowledgeFiles = React.useCallback(async () => {
    if (!workspacePath || !isTauri()) return
    
    setIsLoading(true)
    setError(null)
    
    try {
      const { exists, readDir } = await import('@tauri-apps/plugin-fs')
      const knowledgeDir = `${workspacePath}/knowledge`
      
      if (!(await exists(knowledgeDir))) {
        const { mkdir } = await import('@tauri-apps/plugin-fs')
        await mkdir(knowledgeDir, { recursive: true })
        setItems([])
        return
      }
      
      const loadDirectory = async (path: string): Promise<KnowledgeItem[]> => {
        const entries = await readDir(path)
        const items: KnowledgeItem[] = []
        
        for (const entry of entries) {
          const fullPath = `${path}/${entry.name}`
          const item: KnowledgeItem = {
            path: fullPath,
            name: entry.name,
            type: entry.isDirectory ? 'directory' : 'file',
          }
          
          if (entry.isDirectory) {
            item.children = await loadDirectory(fullPath)
          }
          
          items.push(item)
        }
        
        return items.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1
          }
          return a.name.localeCompare(b.name)
        })
      }
      
      const rootItems = await loadDirectory(knowledgeDir)
      setItems(rootItems)
    } catch (err) {
      console.error('Failed to load knowledge files:', err)
      setError(err instanceof Error ? err.message : 'Failed to load knowledge files')
    } finally {
      setIsLoading(false)
    }
  }, [workspacePath])

  React.useEffect(() => {
    loadKnowledgeFiles()
  }, [loadKnowledgeFiles])

  const handleFileUpload = async () => {
    if (!workspacePath || !isTauri()) return

    setIsUploading(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const { invoke } = await import('@tauri-apps/api/core')
      const { readFile, writeFile } = await import('@tauri-apps/plugin-fs')

      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Documents',
          extensions: ['md', 'txt', 'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'html', 'htm', 'xml', 'rss', 'atom', 'zip', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'mp3', 'wav', 'ogg', 'flac']
        }]
      })

      if (!selected) {
        setIsUploading(false)
        return
      }

      const files = Array.isArray(selected) ? selected : [selected]
      const filesToConvert: string[] = []
      const filesToCopy: string[] = []

      for (const filePath of files) {
        const fileType = classifyFileType(filePath)
        if (fileType === 'convert') {
          filesToConvert.push(filePath)
        } else if (fileType === 'copy') {
          filesToCopy.push(filePath)
        } else {
          toast.error(
            t('settings.knowledge.unsupportedFormat', 'Unsupported format') +
            ': ' + filePath.split('/').pop()
          )
        }
      }
      
      let successCount = 0
      let failCount = 0
      
      // Convert PDF/Word/Excel files
      if (filesToConvert.length > 0) {
        try {
          const results = await invoke<Array<[string, { Ok?: string; Err?: string }]>>(
            'batch_convert_to_markdown',
            { 
              filePaths: filesToConvert, 
              outputDir: `${workspacePath}/knowledge` 
            }
          )
          
          for (const [filePath, result] of results) {
            if (result.Ok) {
              successCount++
            } else {
              failCount++
              console.error(`Failed to convert ${filePath}:`, result.Err)
            }
          }
        } catch (err) {
          console.error('Batch conversion failed:', err)
          failCount += filesToConvert.length
        }
      }
      
      // Copy text files
      for (const filePath of filesToCopy) {
        try {
          const content = await readFile(filePath)
          const filename = filePath.split('/').pop() || 'file.md'
          await writeFile(`${workspacePath}/knowledge/${filename}`, content)
          successCount++
        } catch (err) {
          console.error(`Failed to copy ${filePath}:`, err)
          failCount++
        }
      }
      
      if (successCount > 0) {
        toast.success(
          t('settings.knowledge.uploadSuccess', 'Upload successful') + 
          ' - ' + 
          t('settings.knowledge.uploadedCount', `Uploaded ${successCount} file(s)`, { count: successCount })
        )
        
        // Trigger incremental indexing for uploaded files
        try {
          await startIndex()
          toast.success(t('settings.knowledge.autoIndexed', 'Files auto-indexed to knowledge base'))
        } catch (error) {
          console.error('Auto-indexing failed:', error)
        }
      }
      
      if (failCount > 0) {
        toast.error(
          t('settings.knowledge.uploadFailed', 'Some files failed') + 
          ' - ' + 
          t('settings.knowledge.failedCount', `${failCount} file(s) failed`, { count: failCount })
        )
      }
      
      await loadKnowledgeFiles()
    } catch (err) {
      console.error('Upload failed:', err)
      toast.error(
        t('settings.knowledge.uploadFailed', 'Upload failed') + 
        ': ' + 
        (err instanceof Error ? err.message : 'Unknown error')
      )
    } finally {
      setIsUploading(false)
    }
  }

  const handleDelete = async () => {
    if (!workspacePath || !isTauri() || itemsToDelete.length === 0) return
    
    try {
      const { remove } = await import('@tauri-apps/plugin-fs')
      
      for (const path of itemsToDelete) {
        await remove(path, { recursive: true })
        markTeamFileDeleted(path, workspacePath ?? undefined)
      }

      toast.success(
        t('settings.knowledge.deleteSuccess', 'Deleted successfully') + 
        ' - ' + 
        t('settings.knowledge.deletedCount', `Deleted ${itemsToDelete.length} item(s)`, { count: itemsToDelete.length })
      )
      
      setSelectedItems(new Set())
      await loadKnowledgeFiles()
    } catch (err) {
      console.error('Delete failed:', err)
      toast.error(
        t('settings.knowledge.deleteFailed', 'Delete failed') + 
        ': ' + 
        (err instanceof Error ? err.message : 'Unknown error')
      )
    } finally {
      setDeleteConfirmOpen(false)
      setItemsToDelete([])
    }
  }

  const handleNewFolder = async () => {
    if (!workspacePath || !isTauri() || !newFolderName.trim()) return
    
    try {
      const { mkdir, exists } = await import('@tauri-apps/plugin-fs')
      const folderPath = `${workspacePath}/knowledge/${newFolderName.trim()}`
      
      if (await exists(folderPath)) {
        toast.error(t('settings.knowledge.folderExists', 'Folder already exists'))
        return
      }
      
      await mkdir(folderPath, { recursive: true })
      
      toast.success(
        t('settings.knowledge.folderCreated', 'Folder created') + 
        ': ' + 
        newFolderName.trim()
      )
      
      setNewFolderDialogOpen(false)
      setNewFolderName('')
      await loadKnowledgeFiles()
    } catch (err) {
      console.error('Create folder failed:', err)
      toast.error(
        t('settings.knowledge.createFolderFailed', 'Failed to create folder') + 
        ': ' + 
        (err instanceof Error ? err.message : 'Unknown error')
      )
    }
  }

  const handleRename = async () => {
    if (!workspacePath || !isTauri() || !itemToRename || !newName.trim()) return
    
    try {
      const { rename, exists } = await import('@tauri-apps/plugin-fs')
      const parentDir = itemToRename.substring(0, itemToRename.lastIndexOf('/'))
      const newPath = `${parentDir}/${newName.trim()}`
      
      if (await exists(newPath)) {
        toast.error(t('settings.knowledge.nameExists', 'Name already exists'))
        return
      }
      
      await rename(itemToRename, newPath)
      
      toast.success(t('settings.knowledge.renameSuccess', 'Renamed successfully'))
      
      setRenameDialogOpen(false)
      setItemToRename('')
      setNewName('')
      await loadKnowledgeFiles()
    } catch (err) {
      console.error('Rename failed:', err)
      toast.error(
        t('settings.knowledge.renameFailed', 'Rename failed') + 
        ': ' + 
        (err instanceof Error ? err.message : 'Unknown error')
      )
    }
  }

  const toggleSelection = (path: string) => {
    const newSelected = new Set(selectedItems)
    if (newSelected.has(path)) {
      newSelected.delete(path)
    } else {
      newSelected.add(path)
    }
    setSelectedItems(newSelected)
  }

  const toggleExpanded = (path: string) => {
    const newExpanded = new Set(expandedDirs)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    setExpandedDirs(newExpanded)
  }

  const handleViewFile = async (path: string) => {
    if (!isTauri()) return
    try {
      await selectFile(path)
      closeSettings()
      toast.success(
        t('settings.knowledge.fileOpened', 'File opened') + 
        ' - ' + 
        t('settings.knowledge.fileOpenedDesc', 'The file is now open in the editor')
      )
    } catch (err) {
      console.error('Failed to open file:', err)
      toast.error(t('settings.knowledge.openFileFailed', 'Failed to open file'))
    }
  }

  const handleShowInFolder = async (path: string) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('show_in_folder', { path })
    } catch (err) {
      console.error('Failed to show in folder:', err)
      toast.error(t('settings.knowledge.showInFolderFailed', 'Failed to show in folder'))
    }
  }

  const renderItem = (item: KnowledgeItem, level: number = 0) => {
    const isExpanded = expandedDirs.has(item.path)
    const isSelected = selectedItems.has(item.path)
    
    return (
      <div key={item.path} className="space-y-1">
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors",
            isSelected && "bg-primary/10",
            level > 0 && "ml-6"
          )}
        >
          {item.type === 'directory' ? (
            <>
              <button
                onClick={() => toggleExpanded(item.path)}
                className="flex items-center gap-2 flex-1 text-left"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <Folder className="h-4 w-4 text-blue-500" />
                <span className="font-medium">{item.name}</span>
                {item.children && (
                  <span className="text-xs text-muted-foreground">
                    ({item.children.length})
                  </span>
                )}
              </button>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    setItemToRename(item.path)
                    setNewName(item.name)
                    setRenameDialogOpen(true)
                  }}
                >
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => {
                    setItemsToDelete([item.path])
                    setDeleteConfirmOpen(true)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </>
          ) : (
            <>
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleSelection(item.path)}
              />
              <File className="h-4 w-4 text-muted-foreground" />
              <button
                onClick={() => handleViewFile(item.path)}
                className="flex-1 text-left hover:underline"
              >
                {item.name}
              </button>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleViewFile(item.path)}
                  title={t('settings.knowledge.view', 'View')}
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleShowInFolder(item.path)}
                  title={t('settings.knowledge.showInFolder', 'Show in folder')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    setItemToRename(item.path)
                    const nameWithoutExt = item.name.substring(0, item.name.lastIndexOf('.')) || item.name
                    setNewName(nameWithoutExt)
                    setRenameDialogOpen(true)
                  }}
                  title={t('settings.knowledge.rename', 'Rename')}
                >
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => {
                    setItemsToDelete([item.path])
                    setDeleteConfirmOpen(true)
                  }}
                  title={t('settings.knowledge.delete', 'Delete')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </>
          )}
        </div>
        {item.type === 'directory' && isExpanded && item.children && (
          <div className="space-y-1">
            {item.children.map(child => renderItem(child, level + 1))}
          </div>
        )}
      </div>
    )
  }

  if (!workspacePath) {
    return (
      <div className="space-y-6">
        <SectionHeader 
          icon={BookOpen} 
          title={t('settings.knowledge.title', 'Knowledge Base')} 
          description={t('settings.knowledge.description', 'Manage project knowledge documents')}
          iconColor="text-cyan-500"
        />
        <SettingCard>
          <div className="flex items-center gap-3 text-muted-foreground">
            <AlertCircle className="h-5 w-5" />
            <span>{t('settings.knowledge.selectWorkspace', 'Please select a workspace directory first')}</span>
          </div>
        </SettingCard>
      </div>
    )
  }

  const filteredItems = filterKnowledgeItems(items, searchQuery)
  const selectedCount = selectedItems.size

  return (
    <div className="space-y-6">
      <SectionHeader 
        icon={BookOpen} 
        title={t('settings.knowledge.title', 'Knowledge Base')} 
        description={t('settings.knowledge.descriptionDetail', 'Manage documents in knowledge/ directory')}
        iconColor="text-cyan-500"
      />
      
      {/* Index Status Panel */}
      <SettingCard>
        <h4 className="font-medium mb-4 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          {t('knowledge.stats.title', 'Index Status')}
        </h4>
        <IndexStatusPanel />
      </SettingCard>

      {/* Reindex Warning Banner */}
      {needsReindex && (
        <SettingCard className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                {t('settings.knowledge.configChanged', 'Index configuration changed')}
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                {t('settings.knowledge.needsReindex', 'Configuration changes detected (embedding model or chunking parameters). A full re-index is required for changes to take effect.')}
              </p>
            </div>
            <Button
              size="sm"
              onClick={async () => {
                await startIndex(undefined, false, true)
              }}
              disabled={isIndexing}
              className="gap-2 shrink-0"
            >
              {isIndexing ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('settings.knowledge.rebuilding', 'Rebuilding...')}
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3" />
                  {t('settings.knowledge.rebuildNow', 'Rebuild Now')}
                </>
              )}
            </Button>
          </div>
        </SettingCard>
      )}
      
      {/* Knowledge Search */}
      <SettingCard>
        <h4 className="font-medium mb-4 flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          {t('settings.knowledge.searchTitle', 'Knowledge Search')}
        </h4>
        <KnowledgeSearchPreview />
      </SettingCard>

      {/* Knowledge Configuration */}
      <KnowledgeConfigPanel />
      
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('settings.knowledge.searchPlaceholder', 'Search files...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button 
          onClick={handleFileUpload} 
          size="sm" 
          className="gap-2"
          disabled={isUploading}
        >
          {isUploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {t('settings.knowledge.upload', 'Upload')}
        </Button>
        <Button 
          onClick={() => setNewFolderDialogOpen(true)} 
          variant="outline" 
          size="sm" 
          className="gap-2"
        >
          <FolderPlus className="h-4 w-4" />
          {t('settings.knowledge.newFolder', 'New Folder')}
        </Button>
        <Button 
          onClick={loadKnowledgeFiles} 
          variant="outline" 
          size="sm" 
          className="gap-2" 
          disabled={isLoading}
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          {t('settings.llm.refresh', 'Refresh')}
        </Button>
      </div>

      {/* Batch actions bar */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-3 p-3 bg-primary/10 rounded-lg">
          <CheckboxIcon className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">
            {t('settings.knowledge.selectedCount', `Selected ${selectedCount} item(s)`, { count: selectedCount })}
          </span>
          <div className="flex-1" />
          <Button
            variant="destructive"
            size="sm"
            className="gap-2"
            onClick={() => {
              setItemsToDelete(Array.from(selectedItems))
              setDeleteConfirmOpen(true)
            }}
          >
            <Trash2 className="h-4 w-4" />
            {t('settings.knowledge.batchDelete', 'Delete Selected')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedItems(new Set())}
          >
            {t('settings.knowledge.clearSelection', 'Clear Selection')}
          </Button>
        </div>
      )}
      
      {/* Files list */}
      <div className="space-y-2">
        {isLoading ? (
          <SettingCard>
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          </SettingCard>
        ) : filteredItems.length === 0 ? (
          <SettingCard>
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <BookOpen className="h-12 w-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchQuery.trim() 
                  ? t('settings.knowledge.noResults', 'No files match your search')
                  : t('settings.knowledge.empty', 'No documents yet. Upload some files to get started.')}
              </p>
            </div>
          </SettingCard>
        ) : (
          <SettingCard>
            <div className="space-y-1">
              {filteredItems.map(item => renderItem(item))}
            </div>
          </SettingCard>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.knowledge.confirmDelete', 'Confirm Delete')}</DialogTitle>
            <DialogDescription>
              {t('settings.knowledge.deleteMessage', 'Are you sure you want to delete the following items?')}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-48 overflow-y-auto">
            <ul className="list-disc list-inside text-sm space-y-1">
              {itemsToDelete.map(path => (
                <li key={path} className="text-muted-foreground">
                  {path.replace(`${workspacePath}/knowledge/`, '')}
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {t('common.delete', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New folder dialog */}
      <Dialog open={newFolderDialogOpen} onOpenChange={setNewFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.knowledge.newFolder', 'New Folder')}</DialogTitle>
            <DialogDescription>
              {t('settings.knowledge.newFolderDesc', 'Enter a name for the new folder')}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t('settings.knowledge.folderName', 'Folder name')}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleNewFolder()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleNewFolder} disabled={!newFolderName.trim()}>
              {t('common.create', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.knowledge.rename', 'Rename')}</DialogTitle>
            <DialogDescription>
              {t('settings.knowledge.renameDesc', 'Enter a new name')}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t('settings.knowledge.newName', 'New name')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRename()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={handleRename} disabled={!newName.trim()}>
              {t('common.rename', 'Rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
