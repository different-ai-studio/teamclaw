import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, List, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useIdeasForTeam, type IdeaRow as IdeaRowData } from '@/components/panel/IdeasView'
import { CreateIdeaDialog } from '@/components/sidebar/CreateIdeaDialog'
import { IdeaDetailDialog } from '@/components/sidebar/IdeaDetailDialog'
import { IdeaRow } from '@/components/sidebar/IdeaRow'
import { RenameIdeaDialog } from '@/components/sidebar/RenameIdeaDialog'
import { updateIdeaStatus, type IdeaStatus } from '@/lib/idea-mutations'
import { getTopIdeas } from '@/components/sidebar/sidebar-list-helpers'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useUIStore } from '@/stores/ui'

export function IdeasSection() {
  const { t } = useTranslation()
  const collapsed = useUIStore((s) => s.ideasSectionCollapsed)
  const toggle = useUIStore((s) => s.toggleIdeasSection)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const { ideas, loading, teamId, refetch } = useIdeasForTeam()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [detailFor, setDetailFor] = React.useState<IdeaRowData | null>(null)
  const [renameFor, setRenameFor] = React.useState<IdeaRowData | null>(null)
  const [deleteFor, setDeleteFor] = React.useState<IdeaRowData | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const topIdeas = React.useMemo(() => getTopIdeas(ideas), [ideas])

  const handleSelect = (idea: IdeaRowData) => {
    setFilter({ kind: 'idea', ideaId: idea.id, title: idea.title })
  }

  const handleChangeStatus = async (idea: IdeaRowData, status: IdeaStatus) => {
    try {
      await updateIdeaStatus(idea.id, status)
      toast.success(t('ideas.statusUpdated', 'Status updated'))
      refetch()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.statusFailed', 'Status update failed: {{msg}}', { msg }))
    }
  }

  const handleCopyId = async (idea: IdeaRowData) => {
    try {
      await navigator.clipboard.writeText(idea.id)
      toast.success(t('ideas.copiedId', 'Copied idea ID'))
    } catch {
      toast.error(t('ideas.copyFailed', 'Copy failed'))
    }
  }

  const confirmDelete = async () => {
    if (!deleteFor) return
    setDeleting(true)
    try {
      await getBackend().ideas.archiveIdea(deleteFor.id)
      toast.success(t('ideas.archived', 'Idea deleted'))
      if (filter.kind === 'idea' && filter.ideaId === deleteFor.id) {
        setFilter({ kind: 'all' })
      }
      setDeleteFor(null)
      refetch()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('ideas.deleteFailed', 'Delete failed: {{msg}}', { msg }))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={toggle}
          className="group flex flex-1 items-center gap-1.5 rounded-md px-[9px] py-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="h-[10px] w-[10px]" /> : <ChevronDown className="h-[10px] w-[10px]" />}
          <span>{t('sidebar.ideasSection', 'Top Ideas')}</span>
          {ideas.length > 0 && (
            <span className="font-mono font-normal normal-case tracking-normal text-faint/80">
              · {ideas.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setFilter({ kind: 'ideas' }) }}
          className={cn(
            'rounded-md p-0.5 text-faint hover:bg-selected/60 hover:text-foreground',
            filter.kind === 'ideas' && 'bg-selected text-foreground',
          )}
          title={t('ideas.viewAll', 'View all ideas')}
          aria-label={t('ideas.viewAll', 'View all ideas')}
        >
          <List className="h-[11px] w-[11px]" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setCreateOpen(true) }}
          className="rounded-md p-0.5 text-faint hover:bg-selected/60 hover:text-foreground"
          title={t('ideas.newIdea', 'New idea')}
          aria-label={t('ideas.newIdea', 'New idea')}
        >
          <Plus className="h-[11px] w-[11px]" />
        </button>
      </div>
      <CreateIdeaDialog open={createOpen} onOpenChange={setCreateOpen} teamId={teamId} onCreated={refetch} />
      <IdeaDetailDialog
        idea={detailFor}
        onOpenChange={(open) => { if (!open) setDetailFor(null) }}
        onChanged={refetch}
      />
      <RenameIdeaDialog
        ideaId={renameFor?.id ?? null}
        initialTitle={renameFor?.title ?? ''}
        open={!!renameFor}
        onOpenChange={(open) => { if (!open) setRenameFor(null) }}
        onRenamed={refetch}
      />
      <AlertDialog open={!!deleteFor} onOpenChange={(open) => { if (!open) setDeleteFor(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ideas.deleteConfirm.title', 'Delete idea?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ideas.deleteConfirm.body', 'Delete "{{title}}". This archives the idea and removes it from the list.', { title: deleteFor?.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleting}>
              {t('ideas.deleteConfirm.cta', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {!collapsed && (
        <div className="flex flex-col">
          {loading && (
            <div className="px-[9px] py-1 text-[12px] text-faint">{t('ideas.loading', 'Loading ideas...')}</div>
          )}
          {!loading && ideas.length === 0 && (
            <div className="px-[9px] py-1 text-[12px] text-faint">{t('ideas.empty', 'No ideas yet')}</div>
          )}
          {topIdeas.map((idea) => (
            <IdeaRow
              key={idea.id}
              idea={idea}
              active={filter.kind === 'idea' && filter.ideaId === idea.id}
              onSelect={handleSelect}
              onView={setDetailFor}
              onChangeStatus={handleChangeStatus}
              onRequestRename={setRenameFor}
              onCopyId={handleCopyId}
              onRequestDelete={setDeleteFor}
            />
          ))}
        </div>
      )}
    </div>
  )
}
