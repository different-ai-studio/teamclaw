import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  Bookmark,
  Ellipsis,
  FolderOpen,
  Loader2,
  MessageSquare,
  Settings,
  Clock,
  Shapes,
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

  const workspaceBusy = isLoadingWorkspace || isSwitchingWorkspace

  return (
    <div className="border-t border-border/60 px-1 pt-2">
      <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted/20 p-1">
        {PRIMARY_TABS.map(({ id, labelKey, fallback, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            variant="ghost"
            className={cn(
              'flex h-11 min-w-0 flex-col justify-center gap-0.5 rounded-lg border border-transparent px-1 text-muted-foreground/85 transition-colors',
              'hover:bg-background/80 hover:text-foreground',
              activeTab === id && 'border-border/70 bg-background text-foreground shadow-sm',
            )}
            onClick={() => selectDefaultPrimaryTab(id)}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate text-[11px] font-medium">{t(labelKey, fallback)}</span>
          </Button>
        ))}

        <Popover open={moreOpen} onOpenChange={setDefaultMoreOpen}>
          <PopoverTrigger asChild>
            <Button
            type="button"
            variant="ghost"
            className={cn(
                'flex h-11 min-w-0 flex-col justify-center gap-0.5 rounded-lg border border-transparent px-1 text-muted-foreground/85 transition-colors',
                'hover:bg-background/80 hover:text-foreground',
                moreOpen && 'border-border/70 bg-background text-foreground shadow-sm',
              )}
            >
              <Ellipsis className="h-4 w-4 shrink-0" />
              <span className="truncate text-[11px] font-medium">{t('common.more', 'More')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            sideOffset={10}
            className="w-64 rounded-xl border border-border/80 bg-popover/98 p-1.5 shadow-lg backdrop-blur"
          >
            <div className="rounded-lg bg-muted/25 p-2.5">
              <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
                {t('workspace.currentWorkspace', 'Workspace')}
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/90 text-muted-foreground">
                  <FolderOpen className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground" data-testid="default-more-workspace-name">
                    {workspaceName || t('workspace.selectWorkspace', 'Select Workspace')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('workspace.switchWorkspaceHint', 'Choose a different workspace')}
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="mt-2.5 h-8 w-full justify-start gap-2 rounded-md border-border/70 bg-background/80 px-2.5 text-xs font-medium shadow-none hover:bg-background"
                disabled={!isTauri() || workspaceBusy}
                onClick={() => void handleSwitchWorkspace()}
              >
                {workspaceBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
                {t('workspace.switchWorkspace', 'Switch Workspace')}
              </Button>
            </div>

            <div className="mt-1.5 grid gap-0.5">
              {MORE_ITEMS.map(({ id, labelKey, fallback, icon: Icon }) => (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  className="h-9 justify-start gap-2 rounded-lg px-2.5 text-sm font-medium text-foreground/90 hover:bg-muted/55"
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
