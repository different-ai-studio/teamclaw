import React from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderPlus, Layers, Users, User } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useTeamModeStore } from '@/stores/team-mode'
import { TEAM_REPO_DIR } from '@/lib/build-config'
import { cn } from '@/lib/utils'

function KnowledgeSection({
  label,
  icon: Icon,
  rootPath,
  showAll,
  devUnlocked,
  onToggleShowAll,
}: {
  label: string
  icon: React.ElementType
  rootPath: string
  showAll?: boolean
  devUnlocked?: boolean
  onToggleShowAll?: () => void
}) {
  const { t } = useTranslation()
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const selectFile = useWorkspaceStore(s => s.selectFile)
  const createNoteFromLink = useKnowledgeStore(s => s.createNoteFromLink)
  const workspacePath = useWorkspaceStore(s => s.workspacePath)

  const [rootCreating, setRootCreating] = React.useState<'file' | 'folder' | null>(null)

  const handleCreateConfirm = React.useCallback(async (name: string) => {
    const type = rootCreating
    setRootCreating(null)
    try {
      if (type === 'file') {
        const filePath = await createNoteFromLink(name, rootPath)
        selectFile(filePath)
      } else {
        const { mkdir } = await import('@tauri-apps/plugin-fs')
        await mkdir(`${rootPath}/${name}`, { recursive: true })
        await refreshFileTree()
      }
    } catch (err) {
      const key = type === 'file' ? 'knowledge.newNoteError' : 'knowledge.newFolderError'
      const fallback = type === 'file' ? 'Failed to create note: {{err}}' : 'Failed to create folder: {{err}}'
      toast.error(t(key, fallback, { err: String(err) }))
    }
  }, [rootPath, rootCreating, createNoteFromLink, selectFile, refreshFileTree, t])

  const iconButtonClass = 'flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground'

  const actionIcons = (
    <>
      {!showAll && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => setRootCreating('file')} className={iconButtonClass}>
                <FilePlus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('knowledge.newNote', 'New Note')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => setRootCreating('folder')} className={iconButtonClass}>
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('knowledge.newFolder', 'New Folder')}</TooltipContent>
          </Tooltip>
        </>
      )}
      {devUnlocked && onToggleShowAll && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleShowAll}
              className={cn(iconButtonClass, showAll && 'bg-primary/10 text-primary')}
            >
              <Layers className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {showAll
              ? t('knowledge.showKnowledgeOnly', 'Show knowledge only')
              : t('knowledge.showAllFiles', 'Show all workspace files')}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  )

  const effectiveRootPath = showAll ? (workspacePath ?? undefined) : rootPath

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Section header */}
      <div className="flex items-center gap-1.5 px-3 py-1 bg-muted/40 border-b shrink-0">
        <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
      </div>
      <div className="flex-1 min-h-0">
        <FileBrowser
          variant="panel"
          rootPath={effectiveRootPath}
          hideGitStatus={!showAll}
          actionIcons={actionIcons}
          rootCreating={showAll ? undefined : rootCreating}
          onRootCreateConfirm={handleCreateConfirm}
          onRootCreateCancel={() => setRootCreating(null)}
        />
      </div>
    </div>
  )
}

export function KnowledgeBrowser() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const teamMode = useTeamModeStore(s => s.teamMode)
  const devUnlocked = useTeamModeStore(s => s.devUnlocked)

  const [showAllPersonal, setShowAllPersonal] = React.useState(false)
  const [showAllTeam, setShowAllTeam] = React.useState(false)

  // Reset on devUnlocked change
  React.useEffect(() => {
    if (!devUnlocked) {
      setShowAllPersonal(false)
      setShowAllTeam(false)
    }
  }, [devUnlocked])

  if (!workspacePath) return null

  const personalKnowledgePath = `${workspacePath}/knowledge`
  const teamKnowledgePath = `${workspacePath}/${TEAM_REPO_DIR}/knowledge`

  if (teamMode) {
    return (
      <div className="flex flex-col h-full">
        <KnowledgeSection
          label={t('knowledge.teamDocs', '团队文档')}
          icon={Users}
          rootPath={teamKnowledgePath}
          showAll={showAllTeam}
          devUnlocked={devUnlocked}
          onToggleShowAll={() => setShowAllTeam(v => !v)}
        />
        <div className="border-t" />
        <KnowledgeSection
          label={t('knowledge.personalDocs', '个人文档')}
          icon={User}
          rootPath={personalKnowledgePath}
          showAll={showAllPersonal}
          devUnlocked={devUnlocked}
          onToggleShowAll={() => setShowAllPersonal(v => !v)}
        />
      </div>
    )
  }

  return (
    <KnowledgeSection
      label={t('knowledge.personalDocs', '个人文档')}
      icon={User}
      rootPath={personalKnowledgePath}
      showAll={showAllPersonal}
      devUnlocked={devUnlocked}
      onToggleShowAll={() => setShowAllPersonal(v => !v)}
    />
  )
}
