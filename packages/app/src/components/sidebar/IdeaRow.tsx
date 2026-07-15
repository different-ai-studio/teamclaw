import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, Copy, Eye, Pencil, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
} from '@/components/ui/context-menu'
import type { IdeaRow as IdeaRowData } from '@/components/panel/IdeasView'
import type { IdeaStatus } from '@/lib/idea-mutations'
import { cn } from '@/lib/utils'

interface Props {
  idea: IdeaRowData
  active: boolean
  onSelect: (idea: IdeaRowData) => void
  onView: (idea: IdeaRowData) => void
  onChangeStatus: (idea: IdeaRowData, status: IdeaStatus) => void
  onRequestRename: (idea: IdeaRowData) => void
  onCopyId: (idea: IdeaRowData) => void
  onRequestDelete: (idea: IdeaRowData) => void
}

function statusDot(status: IdeaRowData['status']): { label: string; tone: string } {
  if (status === 'in_progress') return { label: 'in progress', tone: 'bg-amber-500' }
  if (status === 'done') return { label: 'done', tone: 'bg-emerald-500' }
  return { label: 'open', tone: 'bg-faint' }
}

export function IdeaRow({
  idea,
  active,
  onSelect,
  onView,
  onChangeStatus,
  onRequestRename,
  onCopyId,
  onRequestDelete,
}: Props) {
  const { t } = useTranslation()
  const { label, tone } = statusDot(idea.status)
  const radioValue: IdeaStatus = (idea.status as IdeaStatus | null) ?? 'open'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(idea)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-[9px] py-[5px] text-left text-[12.5px] transition-colors',
            active ? 'bg-selected font-semibold text-foreground' : 'text-ink-2 hover:bg-selected/60',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{idea.title}</span>
          <span
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone)}
            aria-label={label}
          />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onView(idea)}>
          <Eye className="h-4 w-4" />
          {t('ideas.contextMenu.view', 'View')}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Circle className="h-4 w-4" />
            {t('ideas.contextMenu.status', 'Status')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={radioValue}
              onValueChange={(v) => onChangeStatus(idea, v as IdeaStatus)}
            >
              <ContextMenuRadioItem value="open">
                {t('ideas.contextMenu.statusOpen', 'Open')}
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="in_progress">
                {t('ideas.contextMenu.statusInProgress', 'In progress')}
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="done">
                {t('ideas.contextMenu.statusDone', 'Done')}
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => onRequestRename(idea)}>
          <Pencil className="h-4 w-4" />
          {t('ideas.contextMenu.rename', 'Rename')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyId(idea)}>
          <Copy className="h-4 w-4" />
          {t('ideas.contextMenu.copyId', 'Copy ID')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRequestDelete(idea)}>
          <Trash2 className="h-4 w-4" />
          {t('ideas.contextMenu.delete', 'Delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
