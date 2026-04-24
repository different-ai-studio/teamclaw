import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  Bookmark,
  ChevronsUpDown,
  Clock,
  Ellipsis,
  FolderOpen,
  Loader2,
  MessageSquare,
  Settings,
  Shapes,
  SquarePlus,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, isTauri } from '@/lib/utils'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'

const PRIMARY_TABS = [
  { id: 'session', labelKey: 'navigation.session', fallback: 'Session', icon: MessageSquare },
  { id: 'knowledge', labelKey: 'navigation.knowledge', fallback: 'Knowledge', icon: BookOpen },
  { id: 'shortcuts', labelKey: 'navigation.shortcuts', fallback: 'Shortcuts', icon: Bookmark },
] as const

const MORE_ITEMS = [
  { id: 'automation', labelKey: 'settings.nav.automation', fallback: 'Automation', icon: Clock },
  { id: 'rolesSkills', labelKey: 'settings.nav.rolesSkills', fallback: 'Roles & Skills', icon: Shapes },
  { id: 'settings', labelKey: 'common.settings', fallback: 'Settings', icon: Settings },
] as const

const noop = () => {}

export function DefaultBottomNav() {
  const { t } = useTranslation()
  const activeTab = useUIStore((s) => s.defaultNavTab) ?? 'session'
  const moreOpen = useUIStore((s) => s.defaultMoreOpen) ?? false
  const selectDefaultPrimaryTab = useUIStore((s) => s.selectDefaultPrimaryTab) ?? noop
  const setDefaultMoreOpen = useUIStore((s) => s.setDefaultMoreOpen) ?? noop
  const openDefaultMoreDestination = useUIStore((s) => s.openDefaultMoreDestination) ?? noop
  const workspaceName = useWorkspaceStore((s) => s.workspaceName)
  const isLoadingWorkspace = useWorkspaceStore((s) => s.isLoadingWorkspace)
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace)
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = React.useState(false)
  const [isOpeningNewWindow, setIsOpeningNewWindow] = React.useState(false)

  const handleSwitchWorkspace = async () => {
    if (!isTauri()) return

    setIsSwitchingWorkspace(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('workspace.switchWorkspace', 'Switch Workspace'),
      })

      if (selected && typeof selected === 'string') {
        await setWorkspace(selected)
        setDefaultMoreOpen(false)
      }
    } catch (error) {
      console.error('[DefaultBottomNav] Failed to switch workspace:', error)
    } finally {
      setIsSwitchingWorkspace(false)
    }
  }

  const handleOpenInNewWindow = async () => {
    if (!isTauri()) return

    setIsOpeningNewWindow(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('workspace.openInNewWindow', 'Open in New Window'),
      })
      if (!selected || typeof selected !== 'string') return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('create_workspace_window', { workspacePath: selected })
      setDefaultMoreOpen(false)
    } catch (error) {
      console.error('[DefaultBottomNav] Failed to open workspace in new window:', error)
    } finally {
      setIsOpeningNewWindow(false)
    }
  }

  const workspaceBusy = isLoadingWorkspace || isSwitchingWorkspace

  return (
    <div className="pb-1.5 pt-1">
      <div className="grid grid-cols-4">
        {PRIMARY_TABS.map(({ id, labelKey, fallback, icon: Icon }) => {
          const isActive = activeTab === id
          return (
            <Button
              key={id}
              type="button"
              variant="ghost"
              className={cn(
                'relative flex h-auto min-w-0 flex-col items-center justify-center gap-1 rounded-none px-1 py-2.5 transition-colors',
                'text-muted-foreground hover:bg-transparent hover:text-foreground',
                isActive && 'text-foreground hover:text-foreground',
              )}
              onClick={() => selectDefaultPrimaryTab(id)}
            >
              {isActive && (
                <span className="pointer-events-none absolute inset-x-3 top-0 h-0.5 rounded-full bg-foreground" />
              )}
              <Icon className={cn('h-4 w-4 shrink-0', isActive && 'stroke-[2.5]')} />
              <span className={cn('truncate text-[11px]', isActive ? 'font-semibold' : 'font-medium')}>
                {t(labelKey, fallback)}
              </span>
            </Button>
          )
        })}

        <Popover open={moreOpen} onOpenChange={setDefaultMoreOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className={cn(
                'relative flex h-auto min-w-0 flex-col items-center justify-center gap-1 rounded-none px-1 py-2.5 transition-colors',
                'text-muted-foreground hover:bg-transparent hover:text-foreground',
                moreOpen && 'text-foreground hover:text-foreground',
              )}
            >
              {moreOpen && (
                <span className="pointer-events-none absolute inset-x-3 top-0 h-0.5 rounded-full bg-foreground" />
              )}
              <Ellipsis className={cn('h-4 w-4 shrink-0', moreOpen && 'stroke-[2.5]')} />
              <span className={cn('truncate text-[11px]', moreOpen ? 'font-semibold' : 'font-medium')}>
                {t('common.more', 'More')}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            sideOffset={8}
            className="w-60 rounded-xl border border-border/80 bg-popover p-1.5 shadow-lg"
          >
            <button
              type="button"
              disabled={!isTauri() || workspaceBusy}
              onClick={() => void handleSwitchWorkspace()}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
                {workspaceBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-xs font-medium text-foreground"
                  data-testid="default-more-workspace-name"
                >
                  {workspaceName || t('workspace.selectWorkspace', 'Select Workspace')}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {t('workspace.switchWorkspace', 'Switch Workspace')}
                </div>
              </div>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>

            <Button
              type="button"
              variant="ghost"
              className="h-8 justify-start gap-2 rounded-md px-2 text-xs font-medium text-foreground/90 hover:bg-muted/60"
              disabled={!isTauri() || isOpeningNewWindow}
              onClick={() => void handleOpenInNewWindow()}
            >
              {isOpeningNewWindow ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <SquarePlus className="h-4 w-4 text-muted-foreground" />
              )}
              <span>{t('workspace.openInNewWindow', 'Open in New Window')}</span>
            </Button>

            <div className="mx-1 my-1 h-px bg-border/60" />

            <div className="grid gap-0.5">
              {MORE_ITEMS.map(({ id, labelKey, fallback, icon: Icon }) => (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  className="h-8 justify-start gap-2 rounded-md px-2 text-xs font-medium text-foreground/90 hover:bg-muted/60"
                  onClick={() => openDefaultMoreDestination(id)}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span>{t(labelKey, fallback)}</span>
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
