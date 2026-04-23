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
    <div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="grid grid-cols-4 gap-1 px-2 py-2">
        {PRIMARY_TABS.map(({ id, labelKey, fallback, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            variant="ghost"
            className={cn(
              'flex h-14 flex-col gap-1 rounded-xl text-muted-foreground',
              activeTab === id && 'bg-muted text-foreground',
            )}
            onClick={() => selectDefaultPrimaryTab(id)}
          >
            <Icon className="h-4 w-4" />
            <span className="text-[11px]">{t(labelKey, fallback)}</span>
          </Button>
        ))}

        <Popover open={moreOpen} onOpenChange={setDefaultMoreOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className={cn(
                'flex h-14 flex-col gap-1 rounded-xl text-muted-foreground',
                moreOpen && 'bg-muted text-foreground',
              )}
            >
              <Ellipsis className="h-4 w-4" />
              <span className="text-[11px]">{t('common.more', 'More')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-72 rounded-2xl p-2">
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('workspace.currentWorkspace', 'Workspace')}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-background text-muted-foreground">
                  <FolderOpen className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" data-testid="default-more-workspace-name">
                    {workspaceName || t('workspace.selectWorkspace', 'Select Workspace')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('workspace.switchWorkspaceHint', 'Choose a different workspace')}
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="mt-3 w-full justify-start gap-2"
                disabled={!isTauri() || workspaceBusy}
                onClick={() => void handleSwitchWorkspace()}
              >
                {workspaceBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderOpen className="h-4 w-4" />
                )}
                {t('workspace.switchWorkspace', 'Switch Workspace')}
              </Button>
            </div>

            <div className="mt-2 grid gap-1">
              {MORE_ITEMS.map(({ id, labelKey, fallback, icon: Icon }) => (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  className="justify-start gap-2 rounded-xl px-3"
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
