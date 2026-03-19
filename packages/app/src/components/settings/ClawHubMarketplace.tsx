import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Search,
  Loader2,
  Download,
  Star,
  ArrowUpCircle,
  Check,
  ExternalLink,
  ShieldAlert,
  Ban,
  TrendingUp,
  Clock,
  ChevronDown,
  AlertTriangle,
  FolderOpen,
  Globe,
} from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { useWorkspaceStore } from "@/stores/workspace"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SettingCard } from "./shared"
import type {
  ClawHubSearchResults,
  ClawHubExploreResults,
  ClawHubSkillListItem,
  ClawHubSearchResultEntry,
  ClawHubSkillDetail,
  ClawHubLockfile,
} from "@/lib/clawhub/types"
import { parseStats } from "@/lib/clawhub/types"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type SortOption = "updated" | "downloads" | "stars" | "trending" | "installsCurrent"

const SORT_OPTIONS: { value: SortOption; labelKey: string; fallback: string; icon: typeof Clock }[] = [
  { value: "updated", labelKey: "clawhub.sortNewest", fallback: "Newest", icon: Clock },
  { value: "trending", labelKey: "clawhub.sortTrending", fallback: "Trending", icon: TrendingUp },
  { value: "downloads", labelKey: "clawhub.sortDownloads", fallback: "Downloads", icon: Download },
  { value: "stars", labelKey: "clawhub.sortStars", fallback: "Stars", icon: Star },
]

interface ClawHubMarketplaceProps {
  onInstalled?: () => void | Promise<void>
}

export const ClawHubMarketplace = React.memo(function ClawHubMarketplace({
  onInstalled,
}: ClawHubMarketplaceProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const [searchQuery, setSearchQuery] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Explore mode (browse) vs search mode
  const [exploreItems, setExploreItems] = React.useState<ClawHubSkillListItem[]>([])
  const [searchResults, setSearchResults] = React.useState<ClawHubSearchResultEntry[]>([])
  const [isSearchMode, setIsSearchMode] = React.useState(false)
  const [sort, setSort] = React.useState<SortOption>("trending")
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = React.useState(false)

  // Installed skills tracking
  const [installedSlugs, setInstalledSlugs] = React.useState<Set<string>>(new Set())
  const [installingSlugs, setInstallingSlugs] = React.useState<Set<string>>(new Set())

  // Detail dialog
  const [detailSlug, setDetailSlug] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<ClawHubSkillDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = React.useState(false)

  // Install location dialog
  const [installDialogOpen, setInstallDialogOpen] = React.useState(false)
  const [installLocation, setInstallLocation] = React.useState<'workspace' | 'global'>('workspace')
  const [pendingInstallSlug, setPendingInstallSlug] = React.useState<string | null>(null)

  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadInstalled = React.useCallback(async () => {
    if (!workspacePath) return
    try {
      const lock = await invoke<ClawHubLockfile>("clawhub_list_installed", {
        workspacePath,
      })
      setInstalledSlugs(new Set(Object.keys(lock.skills)))
    } catch {
      // no lockfile yet
    }
  }, [workspacePath])

  const loadExplore = React.useCallback(
    async (append?: boolean, cursor?: string) => {
      if (append === true) {
        setIsLoadingMore(true)
      } else {
        setIsLoading(true)
      }
      setError(null)

      try {
        const result = await invoke<ClawHubExploreResults>("clawhub_explore", {
          limit: 25,
          sort,
          cursor: cursor ?? null,
        })
        if (append === true) {
          setExploreItems((prev) => [...prev, ...result.items])
        } else {
          setExploreItems(result.items)
        }
        setNextCursor(result.nextCursor)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    },
    [sort]
  )

  const doSearch = React.useCallback(async (query: string) => {
    if (!query.trim()) {
      setIsSearchMode(false)
      return
    }
    setIsSearchMode(true)
    setIsLoading(true)
    setError(null)

    try {
      const result = await invoke<ClawHubSearchResults>("clawhub_search", {
        query: query.trim(),
        limit: 30,
      })
      setSearchResults(result.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Initial load
  React.useEffect(() => {
    loadInstalled()
    loadExplore()
  }, [loadInstalled, loadExplore])

  // Debounced search
  const handleSearchChange = React.useCallback(
    (value: string) => {
      setSearchQuery(value)
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
      if (!value.trim()) {
        setIsSearchMode(false)
        return
      }
      searchTimerRef.current = setTimeout(() => {
        doSearch(value)
      }, 400)
    },
    [doSearch]
  )

  // Re-fetch when sort changes (explore mode only)
  React.useEffect(() => {
    if (!isSearchMode) {
      loadExplore()
    }
  }, [sort, isSearchMode, loadExplore])

  const handleInstall = React.useCallback(
    async (slug: string, location: 'workspace' | 'global') => {
      setInstallingSlugs((prev) => new Set(prev).add(slug))
      try {
        await invoke<string>("clawhub_install", {
          workspacePath: location === 'workspace' ? workspacePath : null,
          slug,
          version: null,
          force: false,
          isGlobal: location === 'global',
        })
        setInstalledSlugs((prev) => new Set(prev).add(slug))
        await onInstalled?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstallingSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
      }
    },
    [workspacePath, onInstalled]
  )

  const openInstallDialog = React.useCallback((slug: string) => {
    setPendingInstallSlug(slug)
    setInstallLocation('workspace')
    setInstallDialogOpen(true)
  }, [])

  const confirmInstall = React.useCallback(async () => {
    if (!pendingInstallSlug) return
    setInstallDialogOpen(false)
    await handleInstall(pendingInstallSlug, installLocation)
    setPendingInstallSlug(null)
  }, [pendingInstallSlug, installLocation, handleInstall])

  const handleUninstall = React.useCallback(
    async (slug: string) => {
      if (!workspacePath) return
      setInstallingSlugs((prev) => new Set(prev).add(slug))
      try {
        await invoke<string>("clawhub_uninstall", {
          workspacePath,
          slug,
        })
        setInstalledSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
        await onInstalled?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstallingSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
      }
    },
    [workspacePath, onInstalled]
  )

  const openDetail = React.useCallback(async (slug: string) => {
    setDetailSlug(slug)
    setIsLoadingDetail(true)
    setDetail(null)
    try {
      const d = await invoke<ClawHubSkillDetail>("clawhub_get_skill", { slug })
      setDetail(d)
    } catch {
      // leave detail null
    } finally {
      setIsLoadingDetail(false)
    }
  }, [])

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString()
  }

  const renderSkillCard = (slug: string, name: string, summary?: string | null, version?: string | null, stats?: unknown, updatedAt?: number) => {
    const isInstalled = installedSlugs.has(slug)
    const isInstalling = installingSlugs.has(slug)
    const parsed = parseStats(stats)

    return (
      <SettingCard key={slug} className="hover:border-primary/30 transition-colors cursor-pointer">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0" onClick={() => openDetail(slug)}>
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{name}</span>
              {version && (
                <span className="text-xs text-muted-foreground shrink-0">v{version}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{slug}</p>
            {summary && (
              <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{summary}</p>
            )}
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              {parsed.stars != null && parsed.stars > 0 && (
                <span className="flex items-center gap-1">
                  <Star className="h-3 w-3" />
                  {parsed.stars}
                </span>
              )}
              {parsed.downloads != null && parsed.downloads > 0 && (
                <span className="flex items-center gap-1">
                  <Download className="h-3 w-3" />
                  {parsed.downloads.toLocaleString()}
                </span>
              )}
              {parsed.installsCurrent != null && parsed.installsCurrent > 0 && (
                <span className="flex items-center gap-1">
                  <ArrowUpCircle className="h-3 w-3" />
                  {parsed.installsCurrent.toLocaleString()}
                </span>
              )}
              {updatedAt && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatTime(updatedAt)}
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0">
            {isInstalled ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
                disabled={isInstalling}
                onClick={(e) => {
                  e.stopPropagation()
                  handleUninstall(slug)
                }}
              >
                {isInstalling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {t("clawhub.installed", "Installed")}
              </Button>
            ) : (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={isInstalling}
                onClick={(e) => {
                  e.stopPropagation()
                  openInstallDialog(slug)
                }}
              >
                {isInstalling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {t("clawhub.install", "Install")}
              </Button>
            )}
          </div>
        </div>
      </SettingCard>
    )
  }

  return (
    <div className="space-y-4">
      {/* Search + Sort */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("clawhub.searchPlaceholder", "Search ClawHub skills...")}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        {!isSearchMode && (
          <div className="flex items-center rounded-lg border border-input overflow-hidden shrink-0">
            {SORT_OPTIONS.map((opt) => {
              const Icon = opt.icon
              const isActive = sort === opt.value
              return (
                <button
                  key={opt.value}
                  onClick={() => setSort(opt.value)}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50"
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {t(opt.labelKey, opt.fallback)}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      )}

      {/* Results */}
      {!isLoading && (
        <div className="space-y-3">
          {isSearchMode ? (
            searchResults.length === 0 ? (
              <SettingCard>
                <div className="text-center py-6 text-muted-foreground">
                  <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p className="font-medium">{t("clawhub.noResults", "No skills found")}</p>
                  <p className="text-sm">{t("clawhub.noResultsHint", "Try different search terms")}</p>
                </div>
              </SettingCard>
            ) : (
              searchResults.map((r) =>
                renderSkillCard(
                  r.slug ?? "unknown",
                  r.displayName ?? r.slug ?? "Unknown",
                  r.summary,
                  r.version,
                  undefined,
                  r.updatedAt
                )
              )
            )
          ) : exploreItems.length === 0 ? (
            <SettingCard>
              <div className="text-center py-6 text-muted-foreground">
                <Download className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="font-medium">{t("clawhub.empty", "No skills available")}</p>
              </div>
            </SettingCard>
          ) : (
            <>
              {exploreItems.map((item) =>
                renderSkillCard(
                  item.slug,
                  item.displayName,
                  item.summary,
                  item.latestVersion?.version,
                  item.stats,
                  item.updatedAt
                )
              )}
              {nextCursor && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={isLoadingMore}
                    onClick={() => loadExplore(true, nextCursor)}
                  >
                    {isLoadingMore ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                    {t("clawhub.loadMore", "Load More")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!detailSlug} onOpenChange={(open) => { if (!open) setDetailSlug(null) }}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{detail?.skill?.displayName ?? detailSlug}</DialogTitle>
            <DialogDescription>{detail?.skill?.slug}</DialogDescription>
          </DialogHeader>

          {isLoadingDetail ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : detail ? (
            <div className="flex-1 overflow-y-auto space-y-4 py-2">
              {/* Moderation warnings */}
              {detail.moderation?.isMalwareBlocked && (
                <div className="flex items-center gap-2 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
                  <Ban className="h-4 w-4 shrink-0" />
                  {t("clawhub.malwareBlocked", "This skill is flagged as malware and cannot be installed.")}
                </div>
              )}
              {detail.moderation?.isSuspicious && !detail.moderation?.isMalwareBlocked && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-300">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  {t("clawhub.suspicious", "This skill is flagged as suspicious. Review carefully before installing.")}
                </div>
              )}

              {/* Summary */}
              {detail.skill?.summary && (
                <p className="text-sm text-muted-foreground">{detail.skill.summary}</p>
              )}

              {/* Meta */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                {detail.owner?.handle && (
                  <div>
                    <span className="text-muted-foreground">{t("clawhub.author", "Author")}: </span>
                    <span className="font-medium">{detail.owner.displayName ?? detail.owner.handle}</span>
                  </div>
                )}
                {detail.latestVersion && (
                  <div>
                    <span className="text-muted-foreground">{t("clawhub.version", "Version")}: </span>
                    <span className="font-medium">v{detail.latestVersion.version}</span>
                  </div>
                )}
                {detail.skill && (() => {
                  const s = parseStats(detail.skill.stats)
                  return (
                    <>
                      {s.stars != null && s.stars > 0 && (
                        <div className="flex items-center gap-1">
                          <Star className="h-3.5 w-3.5 text-amber-500" />
                          <span>{s.stars} {t("clawhub.stars", "stars")}</span>
                        </div>
                      )}
                      {s.downloads != null && s.downloads > 0 && (
                        <div className="flex items-center gap-1">
                          <Download className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>{s.downloads.toLocaleString()} {t("clawhub.downloads", "downloads")}</span>
                        </div>
                      )}
                    </>
                  )
                })()}
                {detail.skill?.updatedAt && (
                  <div>
                    <span className="text-muted-foreground">{t("clawhub.updated", "Updated")}: </span>
                    <span>{formatTime(detail.skill.updatedAt)}</span>
                  </div>
                )}
              </div>

              {/* Changelog */}
              {detail.latestVersion?.changelog && (
                <div>
                  <h4 className="text-sm font-medium mb-1">{t("clawhub.changelog", "Changelog")}</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {detail.latestVersion.changelog}
                  </p>
                </div>
              )}

              {/* ClawHub link */}
              <a
                href={`https://clawhub.ai/skills/${detailSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("clawhub.viewOnClawHub", "View on ClawHub")}
              </a>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailSlug(null)}>
              {t("common.close", "Close")}
            </Button>
            {detailSlug && !detail?.moderation?.isMalwareBlocked && (
              installedSlugs.has(detailSlug) ? (
                <Button
                  variant="outline"
                  className="gap-1.5 text-destructive"
                  disabled={installingSlugs.has(detailSlug)}
                  onClick={() => {
                    handleUninstall(detailSlug)
                    setDetailSlug(null)
                  }}
                >
                  {t("clawhub.uninstall", "Uninstall")}
                </Button>
              ) : (
                <Button
                  className="gap-1.5"
                  disabled={installingSlugs.has(detailSlug)}
                  onClick={() => {
                    openInstallDialog(detailSlug)
                    setDetailSlug(null)
                  }}
                >
                  {installingSlugs.has(detailSlug) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t("clawhub.install", "Install")}
                </Button>
              )
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Install Location Dialog */}
      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.skills.installSkill', 'Install Skill')}</DialogTitle>
            <DialogDescription>
              {t('settings.skills.installSkillDesc', 'Choose where to install')} <span className="font-mono text-foreground">{pendingInstallSlug}</span>
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings.skills.installLocation', 'Install Location')}</label>
              <Select value={installLocation} onValueChange={(v) => setInstallLocation(v as 'workspace' | 'global')}>
                <SelectTrigger>
                  <SelectValue>
                    {installLocation === 'workspace' 
                      ? t('settings.skills.locationWorkspace', 'Workspace')
                      : t('settings.skills.locationGlobal', 'Global')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-[380px]">
                  <SelectItem value="workspace" className="cursor-pointer">
                    <div className="flex items-start gap-2 py-1">
                      <FolderOpen className="h-4 w-4 text-violet-500 mt-0.5 shrink-0" />
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="font-medium">{t('settings.skills.locationWorkspace', 'Workspace')}</span>
                        <span className="text-xs text-muted-foreground whitespace-normal break-words">.opencode/skills/ - {t('settings.skills.projectOnly', 'Current project only')}</span>
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem value="global" className="cursor-pointer">
                    <div className="flex items-start gap-2 py-1">
                      <Globe className="h-4 w-4 text-cyan-500 mt-0.5 shrink-0" />
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="font-medium">{t('settings.skills.locationGlobal', 'Global')}</span>
                        <span className="text-xs text-muted-foreground whitespace-normal break-words">~/.config/opencode/skills/ - {t('settings.skills.allProjects', 'All projects')}</span>
                      </div>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={confirmInstall} disabled={installLocation === 'workspace' && !workspacePath}>
              <Download className="mr-2 h-4 w-4" />
              {t('clawhub.install', 'Install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
