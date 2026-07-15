import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  Loader2,
  Plus,
  Ellipsis,
  Rocket,
  Eye,
  ExternalLink,
  Copy,
  FolderOpen,
  RotateCw,
  Pencil,
  Trash2,
} from 'lucide-react'
import { cn, isTauri } from '@/lib/utils'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useUIStore } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'
import { getBackend } from '@/lib/backend'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { createSessionShell } from '@/lib/session-create'
import { upsertSessionWorkspacesBatch } from '@/lib/local-cache'
import { revealInFinder } from '@/components/workspace/file-tree-operations'
import { CreateAppDialog } from '@/components/apps/CreateAppDialog'
import type { AppRow, AppSessionRow } from '@/lib/backend/types'

/** Resolve the local daemon's per-app workdir: `~/.amuxd/apps/<appId>`. */
async function appWorkdirPath(appId: string): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const { homeDir } = await import('@tauri-apps/api/path')
    const home = await homeDir()
    return `${home}/.amuxd/apps/${appId}`
  } catch {
    return null
  }
}

async function comingSoon(label: string): Promise<void> {
  const { toast } = await import('sonner')
  toast(`${label}：即将推出`)
}

/**
 * Pick the most-recent session for an app, ordering by `lastMessageAt ?? createdAt`
 * descending. Exported as a pure helper so the selection logic is unit-testable
 * without rendering the component.
 */
export function pickMostRecentSession(rows: AppSessionRow[]): AppSessionRow | null {
  if (rows.length === 0) return null
  const ts = (r: AppSessionRow): number => {
    const v = r.lastMessageAt ?? r.createdAt
    const n = v ? Date.parse(v) : NaN
    return Number.isNaN(n) ? 0 : n
  }
  return rows.reduce((best, r) => (ts(r) > ts(best) ? r : best))
}

/**
 * Whether a "Reseed" action should be offered for an app in the given
 * provision state. Only apps whose repo exists but seed has not completed
 * (`repo_created`) or that failed (`error`) can be reseeded — `ready`,
 * `seeding`, and `pending` are excluded. Exported as a pure predicate so the
 * gating logic is unit-testable without rendering the component.
 */
export function canReseed(status: string): boolean {
  return status === 'repo_created' || status === 'error'
}

interface RowProps {
  app: AppRow
  onClick: () => void
  onRename: (app: AppRow) => void
}

function provisionMeta(status: string): { dot: 'ready' | 'failed' | 'idle'; key: string; fallback: string } {
  if (status === 'ready') return { dot: 'ready', key: 'apps.ready', fallback: 'Ready' }
  if (status === 'error' || status === 'failed') return { dot: 'failed', key: 'apps.error', fallback: 'Failed' }
  return { dot: 'idle', key: 'apps.provisioning', fallback: 'Provisioning…' }
}

function AppItemRow({ app, onClick, onRename }: RowProps) {
  const { t } = useTranslation()
  const meta = provisionMeta(app.provisionStatus)
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const isLive = app.fcStatus === 'live' && !!app.fcEndpoint

  const handleReveal = React.useCallback(async (e: React.SyntheticEvent) => {
    e.stopPropagation()
    const path = await appWorkdirPath(app.id)
    if (path) await revealInFinder(path)
  }, [app.id])

  const handleOpenUrl = React.useCallback(async (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (!app.fcEndpoint) return
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(app.fcEndpoint)
  }, [app.fcEndpoint])

  const handleCopyUrl = React.useCallback(async (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (!app.fcEndpoint) return
    await navigator.clipboard.writeText(app.fcEndpoint)
    const { toast } = await import('sonner')
    toast.success(t('apps.urlCopied', '已复制部署地址'))
  }, [app.fcEndpoint, t])

  return (
    <div className="group relative flex items-stretch">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 border-l-2 border-transparent py-2.5 pl-4 pr-10 text-left transition-colors hover:bg-selected/40"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
          {deploying ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <AppWindow className="h-[15px] w-[15px]" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold text-foreground">{app.name}</span>
          <span className="flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                isLive && 'bg-emerald-500',
                !isLive && meta.dot === 'ready' && 'bg-emerald-500',
                !isLive && meta.dot === 'failed' && 'bg-amber-500',
                !isLive && meta.dot === 'idle' && 'bg-muted-foreground/40',
              )}
            />
            <span className="truncate">
              {deploying
                ? t('apps.deploying', '部署中…')
                : isLive
                  ? t('apps.live', '已上线')
                  : t(meta.key, meta.fallback)}
            </span>
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('apps.actions', '操作')}
            className="absolute right-2 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-black/10 dark:hover:bg-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            className="text-[13px]"
            disabled={deploying || app.provisionStatus !== 'ready'}
            onClick={(e) => {
              e.stopPropagation()
              void useAppsStore.getState().deploy(app.id)
            }}
          >
            <Rocket className="mr-2 h-3.5 w-3.5" />
            {t('apps.deploy', '部署')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[13px]"
            onClick={(e) => {
              e.stopPropagation()
              void comingSoon(t('apps.localPreview', '本地预览'))
            }}
          >
            <Eye className="mr-2 h-3.5 w-3.5" />
            {t('apps.localPreview', '本地预览')}
          </DropdownMenuItem>
          {isLive && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-[13px]" onClick={handleOpenUrl}>
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {t('apps.openUrl', '打开部署地址')}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-[13px]" onClick={handleCopyUrl}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                {t('apps.copyUrl', '复制部署地址')}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-[13px]" onClick={handleReveal}>
            <FolderOpen className="mr-2 h-3.5 w-3.5" />
            {t('apps.revealInFinder', '在 Finder 打开目录')}
          </DropdownMenuItem>
          {canReseed(app.provisionStatus) && (
            <DropdownMenuItem
              className="text-[13px]"
              onClick={(e) => {
                e.stopPropagation()
                void useAppsStore.getState().reseed(app.id)
              }}
            >
              <RotateCw className="mr-2 h-3.5 w-3.5" />
              {t('apps.reseed', 'Reseed')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-[13px]"
            onClick={(e) => {
              e.stopPropagation()
              onRename(app)
            }}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t('apps.rename', '重命名')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[13px] text-destructive focus:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              void comingSoon(t('apps.delete', '删除应用'))
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {t('apps.delete', '删除应用')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function RenameAppDialog({
  app,
  onClose,
}: {
  app: AppRow | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  React.useEffect(() => {
    if (app) setName(app.name)
  }, [app])

  const submit = React.useCallback(() => {
    if (!app) return
    const trimmed = name.trim()
    if (trimmed && trimmed !== app.name) {
      void useAppsStore.getState().rename(app.id, trimmed)
    }
    onClose()
  }, [app, name, onClose])

  return (
    <Dialog open={!!app} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>{t('apps.rename', '重命名')}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit() }
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel', '取消')}</Button>
          <Button onClick={submit}>{t('common.save', '保存')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AppsListColumn() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'

  const teamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const items = useAppsStore((s) => s.items)
  const loading = useAppsStore((s) => s.loading)
  const load = useAppsStore((s) => s.load)

  const [createOpen, setCreateOpen] = React.useState(false)
  const [renameApp, setRenameApp] = React.useState<AppRow | null>(null)

  React.useEffect(() => {
    if (!teamId) return
    void load(teamId)
  }, [teamId, load])

  const openApp = React.useCallback(async (app: AppRow) => {
    try {
      const t = useCurrentTeamStore.getState()
      const linkTeamId = t.team?.id ?? app.teamId
      const authUserId = useAuthStore.getState().session?.user?.id ?? null

      const sessions = await getBackend().apps.listAppSessions(app.id)
      const recent = pickMostRecentSession(sessions)
      const sessionId = recent
        ? recent.id
        : await (async () => {
            // No session yet — create one linked to the app.
            if (!authUserId) {
              console.error('[AppsListColumn] cannot create app session: not signed in')
              return null
            }
            const creatorActorId = await resolveCurrentMemberActorId(linkTeamId, authUserId, {
              currentTeamId: linkTeamId,
              currentMemberId: t.currentMember?.id ?? null,
            })
            if (!creatorActorId) {
              console.error('[AppsListColumn] cannot create app session: no current actor')
              return null
            }
            const result = await createSessionShell({
              teamId: linkTeamId,
              creatorActorId,
              title: app.name,
              additionalActorIds: [],
              appId: app.id,
            })
            return result.sessionId
          })()
      if (!sessionId) return

      // The daemon seeds app repos into ~/.amuxd/apps/<appId>.
      let appWorkdir: string | null = null
      try {
        const { homeDir } = await import('@tauri-apps/api/path')
        const home = await homeDir()
        appWorkdir = `${home}/.amuxd/apps/${app.id}`
      } catch (e) {
        console.warn('[AppsListColumn] could not resolve home dir (non-fatal):', e)
      }

      if (appWorkdir) {
        const viewerMemberId = t.currentMember?.id ?? null
        const { getLocalDaemonActorId } = await import('@/lib/daemon-agent-admin')
        const localDaemonActorId = await getLocalDaemonActorId()

        // 1. Bind session → app workdir in local libsql so the UI (file
        //    browser, workspace switch) opens the right directory.
        if (viewerMemberId && localDaemonActorId) {
          try {
            await upsertSessionWorkspacesBatch([{
              sessionId,
              teamId: linkTeamId,
              viewerMemberId,
              agentId: localDaemonActorId,
              workspaceId: app.workspaceId ?? null,
              workspacePath: appWorkdir,
              updatedAt: new Date().toISOString(),
            }])
          } catch (e) {
            console.warn('[AppsListColumn] could not bind session workspace (non-fatal):', e)
          }
        }

        // 2. Register the app workdir as a cloud daemon workspace bound to the
        //    local daemon agent. Runtime-start workspace resolution matches
        //    cloud workspaces by path; without this row the local daemon falls
        //    back to its default workspace instead of the app's code dir.
        try {
          if (localDaemonActorId) {
            const { listDaemonWorkspaces, createDaemonWorkspace } = await import('@/lib/daemon-workspaces')
            const { workspacePathsMatch } = await import('@/stores/session-utils')
            const existing = (await listDaemonWorkspaces(linkTeamId, localDaemonActorId))
              .find((w) => !w.archived && w.path && workspacePathsMatch(w.path, appWorkdir!))
            if (!existing) {
              const createdByMemberId = authUserId
                ? await resolveCurrentMemberActorId(linkTeamId, authUserId, {
                    currentTeamId: linkTeamId,
                    currentMemberId: t.currentMember?.id ?? null,
                  }).catch(() => null)
                : null
              await createDaemonWorkspace({
                teamId: linkTeamId,
                agentId: localDaemonActorId,
                createdByMemberId,
                name: app.name,
                path: appWorkdir,
              })
            }
          }
        } catch (e) {
          console.warn('[AppsListColumn] could not register app daemon workspace (non-fatal):', e)
        }
      }

      await useUIStore.getState().switchToSession(sessionId)
    } catch (e) {
      console.error('[AppsListColumn] failed to open app', e)
    }
  }, [])

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        {sidebarCollapsed && (
          <div className="flex shrink-0 items-center gap-1">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {t('apps.title', 'Apps')}
            <span className="font-mono text-[11px] font-normal text-faint"> · {items.length}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={!teamId}
          title={t('apps.create', 'New App')}
          aria-label={t('apps.create', 'New App')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-selected/40 hover:text-foreground disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            {t('apps.empty', 'No apps yet')}
          </div>
        ) : (
          items.map((app) => (
            <AppItemRow
              key={app.id}
              app={app}
              onClick={() => void openApp(app)}
              onRename={setRenameApp}
            />
          ))
        )}
      </div>

      <CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} teamId={teamId} />
      <RenameAppDialog app={renameApp} onClose={() => setRenameApp(null)} />
    </div>
  )
}
