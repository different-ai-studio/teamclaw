import * as React from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Search,
  Download,
  TrendingUp,
  Clock,
  Award,
  Package,
  Github,
  Flame,
  Loader2,
  RefreshCw,
  AlertCircle,
  ArrowUpCircle,
  Check,
  FolderOpen,
  Globe,
  ChevronDown,
  Trash2,
} from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { useWorkspaceStore } from "@/stores/workspace"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SettingCard } from "./shared"
import { ClawHubMarketplace } from "./ClawHubMarketplace"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

function formatTauriInvokeError(err: unknown): string {
  if (err == null) return String(err)
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message
  }
  return String(err)
}

interface SkillsMarketplaceProps {
  onInstalled?: () => void | Promise<void>
  linkedInstalledSlugs?: Set<string>
  compact?: boolean
  sharedSearchQuery?: string
  onSharedSearchQueryChange?: (value: string) => void
  externalSearch?: boolean
  externalRefreshSignal?: number
  activeSource?: "clawhub" | "skillssh"
  onActiveSourceChange?: (value: "clawhub" | "skillssh") => void
  externalSourceControl?: boolean
}

type SkillsShCategory = "all-time" | "trending" | "hot"

interface SkillsShEntry {
  rank: number
  slug: string
  owner: string
  repo: string
  installs: number
  category?: string
}

interface SkillsShLeaderboard {
  skills: SkillsShEntry[]
  totalInstalls: number
  lastUpdated: number
}

export const SkillsMarketplace = React.memo(function SkillsMarketplace({
  onInstalled,
  linkedInstalledSlugs = new Set<string>(),
  compact = false,
  sharedSearchQuery,
  onSharedSearchQueryChange,
  externalSearch = false,
  externalRefreshSignal = 0,
  activeSource: controlledActiveSource,
  onActiveSourceChange,
  externalSourceControl = false,
}: SkillsMarketplaceProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [activeSource, setActiveSource] = React.useState<"clawhub" | "skillssh">("clawhub")
  const [sourceContentReady, setSourceContentReady] = React.useState(true)
  const [skillsShCategory, setSkillsShCategory] = React.useState<SkillsShCategory>("trending")
  const [searchQuery, setSearchQuery] = React.useState("")
  const [leaderboard, setLeaderboard] = React.useState<SkillsShLeaderboard | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [installingSlugs, setInstallingSlugs] = React.useState<Set<string>>(new Set())
  const [installedSlugs, setInstalledSlugs] = React.useState<Set<string>>(new Set())
  const [installDialogOpen, setInstallDialogOpen] = React.useState(false)
  const [installLocation, setInstallLocation] = React.useState<'workspace' | 'global'>('workspace')
  const [pendingInstall, setPendingInstall] = React.useState<{ owner: string; repo: string; slug: string } | null>(null)
  
  // Detail dialog
  const [detailDialogOpen, setDetailDialogOpen] = React.useState(false)
  const [selectedSkill, setSelectedSkill] = React.useState<SkillsShEntry | null>(null)
  const [skillContent, setSkillContent] = React.useState<string | null>(null)
  const [isLoadingContent, setIsLoadingContent] = React.useState(false)
  const effectiveSearchQuery = externalSearch ? (sharedSearchQuery ?? "") : searchQuery
  const effectiveActiveSource = controlledActiveSource ?? activeSource

  const switchSource = React.useCallback((nextSource: "clawhub" | "skillssh") => {
    setSourceContentReady(false)
    if (onActiveSourceChange) {
      onActiveSourceChange(nextSource)
    } else {
      setActiveSource(nextSource)
    }
  }, [onActiveSourceChange])

  // Check if running in Tauri
  const isTauri = React.useMemo(() => {
    return typeof window !== 'undefined' &&
      !!(window as unknown as { __TAURI__: unknown }).__TAURI__
  }, [])

  // Fetch leaderboard data
  const fetchLeaderboard = React.useCallback(async (category?: SkillsShCategory) => {
    if (!isTauri) {
      setError(t("skillssh.tauriRequired", "This feature requires the desktop app"))
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const categoryParam = category || skillsShCategory
      const data = await invoke<SkillsShLeaderboard>("fetch_skillssh_leaderboard", {
        category: categoryParam,
      })
      setLeaderboard(data)
    } catch (err) {
      console.error("[SkillsMarketplace] Failed to fetch leaderboard:", err)
      setError(formatTauriInvokeError(err))
    } finally {
      setIsLoading(false)
    }
  }, [isTauri, t, skillsShCategory])

  const doSearchSkillSh = React.useCallback(async (query: string) => {
    if (!isTauri) return
    if (!query.trim()) {
      fetchLeaderboard()
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const data = await invoke<SkillsShLeaderboard>("search_skillssh_skills", {
        query: query.trim(),
      })
      setLeaderboard(data)
    } catch (err) {
      console.error("[SkillsMarketplace] Failed to search skills:", err)
      setError(formatTauriInvokeError(err))
    } finally {
      setIsLoading(false)
    }
  }, [isTauri, fetchLeaderboard])

  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = React.useCallback((value: string) => {
    if (externalSearch) {
      onSharedSearchQueryChange?.(value)
    } else {
      setSearchQuery(value)
    }
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }
    searchTimerRef.current = setTimeout(() => {
      doSearchSkillSh(value)
    }, 400)
  }, [doSearchSkillSh, externalSearch, onSharedSearchQueryChange])

  const loadInstalled = React.useCallback(async () => {
    if (!workspacePath) return

    try {
      const [fsModule, pathModule] = await Promise.all([
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path"),
      ])
      const home = await pathModule.homeDir()
      const allSlugs = new Set<string>()

      const homeNorm = home.replace(/\/$/, '')
      const dirsToCheck = [
        `${workspacePath}/.agents/skills`,
        `${workspacePath}/.opencode/skills`,
        `${workspacePath}/.claude/skills`,
        `${homeNorm}/.config/opencode/skills`,
        `${homeNorm}/.claude/skills`,
        `${homeNorm}/.agents/skills`,
      ]

      await Promise.allSettled(dirsToCheck.map(async (dir) => {
        if (await fsModule.exists(dir)) {
          const entries = await fsModule.readDir(dir)
          entries
            .filter((e: { isDirectory?: boolean; name?: string }) => e.isDirectory && e.name)
            .forEach((e: { name?: string }) => allSlugs.add(e.name!))
        }
      }))

      setInstalledSlugs(allSlugs)
    } catch {
      setInstalledSlugs(new Set())
    }
  }, [workspacePath])

  // Load on mount or when category changes
  React.useEffect(() => {
    loadInstalled()
    if (effectiveActiveSource === "skillssh" && !effectiveSearchQuery.trim()) {
      fetchLeaderboard()
    }
  }, [effectiveActiveSource, effectiveSearchQuery, skillsShCategory, fetchLeaderboard, loadInstalled])

  React.useEffect(() => {
    if (!externalSearch || effectiveActiveSource !== "skillssh") return
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }
    searchTimerRef.current = setTimeout(() => {
      void doSearchSkillSh(effectiveSearchQuery)
    }, 300)
  }, [effectiveActiveSource, doSearchSkillSh, effectiveSearchQuery, externalSearch])

  React.useEffect(() => {
    if (!externalRefreshSignal || effectiveActiveSource !== "skillssh") return
    if (effectiveSearchQuery.trim()) {
      void doSearchSkillSh(effectiveSearchQuery)
    } else {
      void fetchLeaderboard()
    }
  }, [effectiveActiveSource, doSearchSkillSh, effectiveSearchQuery, externalRefreshSignal, fetchLeaderboard])

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSourceContentReady(true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [effectiveActiveSource])

  const filteredSkillsSh = React.useMemo(() => {
    return leaderboard?.skills ?? []
  }, [leaderboard])

  const handleInstallSkillSh = React.useCallback(async (owner: string, repo: string, slug: string, location: 'workspace' | 'global') => {
    setInstallingSlugs((prev) => new Set(prev).add(slug))
    try {
      await invoke<string>("npx_skills_add", {
        workspacePath: location === 'workspace' ? workspacePath : null,
        source: `${owner}/${repo}`,
        skill: slug,
        isGlobal: location === 'global',
      })
      setInstalledSlugs((prev) => new Set(prev).add(slug))
      await onInstalled?.()
    } catch (err) {
      console.error("[SkillsMarketplace] Failed to install skill:", err)
      setError(formatTauriInvokeError(err))
    } finally {
      setInstallingSlugs((prev) => {
        const next = new Set(prev)
        next.delete(slug)
        return next
      })
    }
  }, [workspacePath, onInstalled])

  const openInstallDialog = React.useCallback((owner: string, repo: string, slug: string) => {
    setPendingInstall({ owner, repo, slug })
    setInstallLocation('workspace')
    setInstallDialogOpen(true)
  }, [])

  const confirmInstall = React.useCallback(async () => {
    if (!pendingInstall) return
    setInstallDialogOpen(false)
    await handleInstallSkillSh(pendingInstall.owner, pendingInstall.repo, pendingInstall.slug, installLocation)
    setPendingInstall(null)
  }, [pendingInstall, installLocation, handleInstallSkillSh])

  const handleReinstallSkillSh = React.useCallback(
    async (owner: string, repo: string, slug: string) => {
      if (!workspacePath) return
      setInstallingSlugs((prev) => new Set(prev).add(slug))
      try {
        await invoke<string>("npx_skills_remove", {
          workspacePath,
          skillName: slug,
          isGlobal: false,
        }).catch(() => {})
        await invoke<string>("npx_skills_add", {
          workspacePath,
          source: `${owner}/${repo}`,
          skill: slug,
          isGlobal: false,
        })
        await onInstalled?.()
      } catch (err) {
        console.error("[SkillsMarketplace] Failed to reinstall skill:", err)
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

  const handleUninstallSkillSh = React.useCallback(
    async (slug: string) => {
      if (!workspacePath) return
      setInstallingSlugs((prev) => new Set(prev).add(slug))
      try {
        await invoke<string>("npx_skills_remove", {
          workspacePath,
          skillName: slug,
          isGlobal: false,
        })
        setInstalledSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
        await onInstalled?.()
      } catch (err) {
        console.error("[SkillsMarketplace] Failed to uninstall skill:", err)
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

  // Parse YAML frontmatter from skill content
  const parseFrontmatter = (content: string): { metadata: Record<string, string> | null, markdownContent: string } => {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
    const match = content.match(frontmatterRegex)
    
    if (!match) {
      return { metadata: null, markdownContent: content }
    }
    
    const yamlContent = match[1]
    const markdownContent = match[2]
    
    const metadata: Record<string, string> = {}
    yamlContent.split('\n').forEach(line => {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim()
        const value = line.substring(colonIndex + 1).trim()
        if (key && value) {
          metadata[key] = value
        }
      }
    })
    
    return { metadata: Object.keys(metadata).length > 0 ? metadata : null, markdownContent }
  }

  const openSkillDetail = React.useCallback(async (skill: SkillsShEntry) => {
    setSelectedSkill(skill)
    setDetailDialogOpen(true)
    setIsLoadingContent(true)
    setSkillContent(null)

    try {
      const content = await invoke<string>("fetch_skillssh_content", {
        owner: skill.owner,
        repo: skill.repo,
        slug: skill.slug,
      })
      setSkillContent(content)
    } catch (err) {
      console.error("[SkillsMarketplace] Failed to fetch skill content:", err)
      setSkillContent(null)
    } finally {
      setIsLoadingContent(false)
    }
  }, [])

  return (
    <div className="min-w-0 space-y-4">
      {compact && !externalSourceControl ? (
        <div className="grid gap-3 rounded-xl border bg-muted/20 p-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-center">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="text-sm font-medium">{t("settings.skills.marketplace", "Marketplace")}</div>
            <div className="text-xs text-muted-foreground">
              {t("settings.skills.marketplaceSourceHint", "Choose a source and install workspace-ready skills.")}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {t("settings.skills.sourceLabel", "Source")}
            </div>
              <Select
              value={effectiveActiveSource}
              onValueChange={(value) => switchSource(value as "clawhub" | "skillssh")}
            >
              <SelectTrigger className="h-11 rounded-xl border-border/70 bg-background text-sm shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="clawhub">
                  <span className="inline-flex items-center gap-2">
                    <Package className="h-4 w-4" />
                    ClawHub
                  </span>
                </SelectItem>
                <SelectItem value="skillssh">
                  <span className="inline-flex items-center gap-2">
                    <Award className="h-4 w-4" />
                    skills.sh
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : !externalSourceControl ? (
        <div className="inline-flex rounded-xl border border-border/70 bg-background p-1">
          <button
            type="button"
            onClick={() => switchSource("clawhub")}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              effectiveActiveSource === "clawhub"
                ? "bg-accent text-accent-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Package className="h-4 w-4" />
            ClawHub Marketplace
          </button>
          <button
            type="button"
            onClick={() => switchSource("skillssh")}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              effectiveActiveSource === "skillssh"
                ? "bg-accent text-accent-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Award className="h-4 w-4" />
            skills.sh Marketplace
          </button>
        </div>
      ) : null}

      {!sourceContentReady ? (
        <SettingCard className={compact ? "" : "mt-4"}>
          <div className="flex min-h-[180px] items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{t('settings.skills.marketplaceLoading', 'Loading marketplace...')}</span>
          </div>
        </SettingCard>
      ) : effectiveActiveSource === 'clawhub' ? (
        <div className={compact ? "" : "mt-4"}>
          <ClawHubMarketplace
            onInstalled={onInstalled}
            externalSearch={externalSearch}
            sharedSearchQuery={externalSearch ? effectiveSearchQuery : undefined}
            onSharedSearchQueryChange={externalSearch ? onSharedSearchQueryChange : undefined}
            externalRefreshSignal={externalRefreshSignal}
          />
        </div>
      ) : (
        <div className={cn("min-w-0 space-y-4", compact ? "" : "mt-4")}>
          {/* Error */}
          {error && (
            <SettingCard className="bg-destructive/10 border-destructive/50">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-destructive">{t("common.error", "Error")}</p>
                  <p className="text-sm text-destructive/80 mt-1">{error}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fetchLeaderboard()}
                  disabled={isLoading}
                  className="gap-1.5"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
                  {t("common.retry", "Retry")}
                </Button>
              </div>
            </SettingCard>
          )}

          {/* Search + Category Filters */}
          <div className="grid gap-2">
            {!externalSearch ? (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="relative min-w-0">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t("skillssh.searchPlaceholder", "Search skills...")}
                    value={searchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    className="pl-9 h-9"
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => fetchLeaderboard()}
                  disabled={isLoading}
                  title={t("common.refresh", "Refresh")}
                >
                  <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
                </Button>
              </div>
            ) : null}
            {!effectiveSearchQuery.trim() && (
              <div className="flex max-w-full flex-wrap items-center rounded-lg border border-input overflow-hidden shrink-0 sm:col-span-2">
                <button
                  onClick={() => setSkillsShCategory("all-time")}
                  disabled={isLoading}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                    skillsShCategory === "all-time"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                    isLoading && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <Clock className="h-3 w-3" />
                  {t("skillssh.allTime", "All Time")}
                </button>
                <button
                  onClick={() => setSkillsShCategory("trending")}
                  disabled={isLoading}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                    skillsShCategory === "trending"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                    isLoading && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <TrendingUp className="h-3 w-3" />
                  {t("skillssh.trending", "Trending")}
                </button>
                <button
                  onClick={() => setSkillsShCategory("hot")}
                  disabled={isLoading}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                    skillsShCategory === "hot"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                    isLoading && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <Flame className="h-3 w-3" />
                  {t("skillssh.hot", "Hot")}
                </button>
              </div>
            )}
          </div>

          {/* npx skills install */}
          <SettingCard className="bg-muted/30">
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Package className="h-4 w-4" />
                {t("skillssh.installFromSource", "Install from Source")}
              </h4>
              <p className="text-sm text-muted-foreground">
                {t("skillssh.installFromSourceDesc", "Install skills via npx skills add — supports GitHub shorthand (owner/repo), full URLs, and direct skill paths")}
              </p>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_auto] md:items-center">
                <Input
                  placeholder={t("skillssh.sourcePlaceholder", "owner/repo or https://github.com/owner/repo")}
                  className="h-9 min-w-0 font-mono text-xs"
                  id="npx-source-input"
                />
                <Input
                  placeholder={t("skillssh.skillNamePlaceholder", "skill-name (optional)")}
                  className="h-9 w-full text-xs"
                  id="npx-skill-input"
                />
                <Button
                  size="sm"
                  className="gap-1.5 h-9"
                  onClick={async () => {
                    const srcInput = document.getElementById('npx-source-input') as HTMLInputElement
                    const skillInput = document.getElementById('npx-skill-input') as HTMLInputElement
                    const source = srcInput?.value.trim()
                    const skillName = skillInput?.value.trim() || undefined

                    if (!source) {
                      setError(t("skillssh.sourceRequired", "Please enter a source (owner/repo or URL)"))
                      return
                    }

                    if (!workspacePath) {
                      setError(
                        t(
                          "skillssh.workspaceRequiredForGit",
                          "Open a workspace folder first — skills install into .opencode/skills in that project.",
                        ),
                      )
                      return
                    }

                    const tag = skillName || source
                    setInstallingSlugs((prev) => new Set(prev).add(tag))
                    try {
                      await invoke<string>("npx_skills_add", {
                        workspacePath,
                        source,
                        skill: skillName ?? null,
                        isGlobal: false,
                      })
                      if (skillName) {
                        setInstalledSlugs((prev) => new Set(prev).add(skillName))
                      }
                      onInstalled?.()
                      srcInput.value = ''
                      skillInput.value = ''
                    } catch (err) {
                      console.error("[SkillsMarketplace] npx skills add failed:", err)
                      setError(formatTauriInvokeError(err))
                    } finally {
                      setInstallingSlugs((prev) => {
                        const next = new Set(prev)
                        next.delete(tag)
                        return next
                      })
                    }
                  }}
                  disabled={!workspacePath}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("skillssh.install", "Install")}
                </Button>
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p className="font-medium">{t("skillssh.supportedFormats", "Supported formats:")}</p>
                <ul className="list-disc list-inside space-y-0.5 pl-2">
                  <li>GitHub shorthand: <code className="bg-muted px-1 rounded text-[11px]">owner/repo</code></li>
                  <li>Full URL: <code className="bg-muted px-1 rounded text-[11px]">https://github.com/owner/repo</code></li>
                  <li>Direct skill path: <code className="bg-muted px-1 rounded text-[11px]">https://github.com/owner/repo/tree/main/skills/my-skill</code></li>
                  <li>GitLab / Gitee / Bitbucket / any git URL</li>
                </ul>
              </div>
            </div>
          </SettingCard>

          {/* Update / Check skills */}
          <SettingCard className="bg-muted/30">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <ArrowUpCircle className="h-4 w-4" />
                  {t("skillssh.manageInstalled", "Manage Installed Skills")}
                </h4>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("skillssh.manageDesc", "Check for updates or update all installed skills via npx skills")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={isLoading}
                  onClick={async () => {
                    setIsLoading(true)
                    setError(null)
                    try {
                      const result = await invoke<string>("npx_skills_check", { workspacePath })
                      setError(null)
                      console.log("[SkillsMarketplace] npx skills check:", result)
                      alert(result || t("skillssh.allUpToDate", "All skills are up to date"))
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err))
                    } finally {
                      setIsLoading(false)
                    }
                  }}
                >
                  <Search className="h-3.5 w-3.5" />
                  {t("skillssh.checkUpdates", "Check Updates")}
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={isLoading}
                  onClick={async () => {
                    setIsLoading(true)
                    setError(null)
                    try {
                      await invoke<string>("npx_skills_update", { workspacePath })
                      await loadInstalled()
                      await onInstalled?.()
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err))
                    } finally {
                      setIsLoading(false)
                    }
                  }}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {t("skillssh.updateAll", "Update All")}
                </Button>
              </div>
            </div>
          </SettingCard>

          {/* Footer stats */}
          {leaderboard && (
            <SettingCard className="bg-gradient-to-r from-slate-50 to-gray-50 dark:from-slate-900/50 dark:to-gray-900/50">
              <div className="flex items-center justify-around gap-4 py-2">
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Award className="h-4 w-4" />
                    <span className="text-xs">{t("skillssh.showing", "Showing")}</span>
                  </div>
                  <span className="text-2xl font-bold text-foreground">{leaderboard.skills.length}</span>
                  <span className="text-xs text-muted-foreground">{t("skillssh.topSkills", "top skills")}</span>
                </div>
                <div className="h-12 w-px bg-border" />
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Download className="h-4 w-4" />
                    <span className="text-xs">{t("skillssh.total", "Total")}</span>
                  </div>
                  <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {Number.isFinite(leaderboard.totalInstalls) && leaderboard.totalInstalls >= 0
                      ? `${Math.round(leaderboard.totalInstalls / 1000)}K+`
                      : '—'}
                  </span>
                  <span className="text-xs text-muted-foreground">{t("skillssh.totalInstalls", "installs")}</span>
                </div>
                <div className="h-12 w-px bg-border" />
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span className="text-xs">{t("skillssh.updated", "Updated")}</span>
                  </div>
                  <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                    {Number.isFinite(leaderboard.lastUpdated) && leaderboard.lastUpdated > 0
                      ? new Date(leaderboard.lastUpdated * 1000).toLocaleDateString()
                      : t('skillssh.unknownDate', '—')}
                  </span>
                  <span className="text-xs text-muted-foreground">{t("skillssh.lastSync", "last sync")}</span>
                </div>
              </div>
            </SettingCard>
          )}

          {/* Marketplace */}
          <div className="space-y-3">
            {isLoading ? (
              <SettingCard>
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              </SettingCard>
            ) : filteredSkillsSh.length === 0 ? (
              <SettingCard>
                <div className="text-center py-6 text-muted-foreground">
                  <Search className="h-8 w-8 mx-auto mb-3 opacity-50" />
                  <p className="font-medium">{t("skillssh.noResults", "No skills found")}</p>
                  <p className="text-sm mt-1">{t("skillssh.tryDifferent", "Try a different search term")}</p>
                </div>
              </SettingCard>
            ) : (
              filteredSkillsSh.map((skill) => {
                return (
                  <SettingCard
                    key={skill.slug}
                    className="cursor-pointer transition-colors hover:border-primary/30"
                  >
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                      <div className="flex-1 min-w-0" onClick={() => openSkillDetail(skill)}>
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{skill.slug}</span>
                          {skill.category && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary shrink-0">
                              {skill.category}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          <a
                            href={`https://github.com/${skill.owner}/${skill.repo}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {skill.owner}/{skill.repo}
                          </a>
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Download className="h-3 w-3" />
                            {skill.installs.toLocaleString()}
                          </span>
                          <span className="flex items-center gap-1">
                            <Award className="h-3 w-3" />
                            #{skill.rank}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex shrink-0 self-start" onClick={(e) => e.stopPropagation()}>
                        {installedSlugs.has(skill.slug) && linkedInstalledSlugs.has(skill.slug) ? (
                          <div className="mb-2 flex justify-end">
                            <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                              {t("settings.skills.linkedToRoles", "Linked to roles")}
                            </span>
                          </div>
                        ) : null}
                        {installedSlugs.has(skill.slug) ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
                                disabled={installingSlugs.has(skill.slug)}
                              >
                                {installingSlugs.has(skill.slug) ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                {t("skillssh.installed", "Installed")}
                                <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => handleReinstallSkillSh(skill.owner, skill.repo, skill.slug)}
                                disabled={installingSlugs.has(skill.slug)}
                              >
                                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                {t("skillssh.reinstall", "Reinstall")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleUninstallSkillSh(skill.slug)}
                                disabled={installingSlugs.has(skill.slug)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-2" />
                                {t("skillssh.uninstall", "Uninstall")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <Button
                            size="sm"
                            className="gap-1.5"
                            disabled={installingSlugs.has(skill.slug)}
                            onClick={() => openInstallDialog(skill.owner, skill.repo, skill.slug)}
                          >
                            {installingSlugs.has(skill.slug) ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5" />
                            )}
                            {t("skillssh.install", "Install")}
                          </Button>
                        )}
                      </div>
                    </div>
                  </SettingCard>
                )
              })
            )}
          </div>
        </div>
      )}

      {/* Install Location Dialog */}
      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.skills.installSkill', 'Install Skill')}</DialogTitle>
            <DialogDescription>
              {t('settings.skills.installSkillDesc', 'Choose where to install')} <span className="font-mono text-foreground">{pendingInstall?.slug}</span>
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
                        <span className="text-xs text-muted-foreground whitespace-normal break-words">.agents/skills/ - {t('settings.skills.projectOnly', 'Current project only')}</span>
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
              {t('skillssh.install', 'Install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Skill Detail Dialog */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedSkill && (
                <>
                  <div
                    className={cn(
                      "flex items-center justify-center h-8 w-8 rounded-lg font-bold text-xs shadow-sm shrink-0",
                      selectedSkill.rank <= 3
                        ? "bg-gradient-to-br from-amber-400 via-amber-500 to-amber-600 text-white"
                        : selectedSkill.rank <= 10
                          ? "bg-gradient-to-br from-slate-300 to-slate-500 text-white"
                          : "bg-muted text-muted-foreground border border-border"
                    )}
                  >
                    {selectedSkill.rank <= 3 ? (
                      <Award className="h-4 w-4" />
                    ) : (
                      <span>#{selectedSkill.rank}</span>
                    )}
                  </div>
                  <span>{selectedSkill.slug}</span>
                </>
              )}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex items-center gap-2 text-sm">
                <Github className="h-3.5 w-3.5 shrink-0" />
                {selectedSkill ? (
                  <a
                    href={`https://github.com/${selectedSkill.owner}/${selectedSkill.repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-primary hover:underline"
                  >
                    {selectedSkill.owner}/{selectedSkill.repo}
                  </a>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>

          {isLoadingContent ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-4 py-2">
              {/* Stats */}
              {selectedSkill && (
                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                    <Download className="h-4 w-4" />
                    <span>{selectedSkill.installs.toLocaleString()} {t("skillssh.installs", "installs")}</span>
                  </div>
                  {selectedSkill.rank <= 3 && (
                    <div className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                      <TrendingUp className="h-4 w-4" />
                      <span>Top {selectedSkill.rank}</span>
                    </div>
                  )}
                  {selectedSkill.category && (
                    <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary">
                      {selectedSkill.category}
                    </span>
                  )}
                </div>
              )}

              {/* Content */}
              {skillContent ? (
                (() => {
                  const isHtml = skillContent.trimStart().startsWith('<')
                  if (isHtml) {
                    return (
                      <div
                        className="prose prose-sm dark:prose-invert max-w-none
                          [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3 [&_h1:first-child]:mt-0
                          [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-6 [&_h2]:mb-3
                          [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-5 [&_h3]:mb-2
                          [&_p]:mb-4 [&_p]:leading-relaxed
                          [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-sm
                          [&_th]:border-b [&_th]:border-border [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-muted/50
                          [&_td]:px-4 [&_td]:py-3 [&_td]:border-b [&_td]:border-border
                          [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono
                          [&_pre]:my-4 [&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:p-4
                          [&_pre_code]:bg-transparent [&_pre_code]:p-0
                          [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-4 [&_ul]:space-y-1
                          [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-4 [&_ol]:space-y-1
                          [&_a]:text-primary [&_a]:hover:underline
                          [&_blockquote]:border-l-4 [&_blockquote]:border-primary [&_blockquote]:pl-4 [&_blockquote]:my-4 [&_blockquote]:text-muted-foreground"
                        dangerouslySetInnerHTML={{ __html: skillContent }}
                      />
                    )
                  }
                  const { metadata, markdownContent } = parseFrontmatter(skillContent)
                  return (
                    <div className="space-y-5">
                      {metadata && (
                        <div className="rounded-lg border border-border overflow-hidden">
                          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 px-4 py-2 border-b border-border">
                            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                              <Package className="h-4 w-4 text-primary" />
                              {t("skillssh.metadata", "Skill Metadata")}
                            </h3>
                          </div>
                          <table className="min-w-full divide-y divide-border">
                            <tbody className="divide-y divide-border">
                              {Object.entries(metadata).map(([key, value]) => (
                                <tr key={key} className="hover:bg-muted/30 transition-colors">
                                  <td className="px-4 py-3 text-sm font-medium text-muted-foreground bg-muted/20 w-1/4">
                                    {key}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-foreground">
                                    {value}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            h1: ({ children }) => (
                              <h1 className="text-xl font-bold mt-6 mb-3 first:mt-0">{children}</h1>
                            ),
                            h2: ({ children }) => (
                              <h2 className="text-lg font-bold mt-6 mb-3 first:mt-0">{children}</h2>
                            ),
                            h3: ({ children }) => (
                              <h3 className="text-base font-semibold mt-5 mb-2 first:mt-0">{children}</h3>
                            ),
                            h4: ({ children }) => (
                              <h4 className="text-sm font-semibold mt-4 mb-2 first:mt-0">{children}</h4>
                            ),
                            p: ({ children }) => (
                              <p className="mb-4 leading-relaxed">{children}</p>
                            ),
                            strong: ({ children }) => (
                              <strong className="font-semibold">{children}</strong>
                            ),
                            table: ({ children }) => (
                              <div className="overflow-x-auto my-5 rounded-lg border border-border">
                                <table className="min-w-full border-collapse text-sm">
                                  {children}
                                </table>
                              </div>
                            ),
                            thead: ({ children }) => (
                              <thead className="bg-muted/50">{children}</thead>
                            ),
                            th: ({ children }) => (
                              <th className="border-b border-border px-4 py-3 text-left font-semibold">
                                {children}
                              </th>
                            ),
                            tr: ({ children }) => (
                              <tr className="border-b border-border last:border-b-0">{children}</tr>
                            ),
                            td: ({ children }) => (
                              <td className="px-4 py-3">{children}</td>
                            ),
                            blockquote: ({ children }) => (
                              <blockquote className="border-l-4 border-primary pl-4 my-4 text-muted-foreground italic">
                                {children}
                              </blockquote>
                            ),
                            pre: ({ children }) => (
                              <pre className="my-4 bg-muted rounded-lg overflow-x-auto">
                                {children}
                              </pre>
                            ),
                            code: ({ className, children, ...props }) => {
                              const isInline = !className
                              return isInline ? (
                                <code
                                  className="bg-muted px-1.5 py-0.5 rounded text-primary text-sm font-mono"
                                  {...props}
                                >
                                  {children}
                                </code>
                              ) : (
                                <code
                                  className={cn('block p-4 font-mono text-sm leading-relaxed', className)}
                                  {...props}
                                >
                                  {children}
                                </code>
                              )
                            },
                            ul: ({ children }) => (
                              <ul className="list-disc pl-5 mb-4 space-y-2">{children}</ul>
                            ),
                            ol: ({ children }) => (
                              <ol className="list-decimal pl-5 mb-4 space-y-2">{children}</ol>
                            ),
                            li: ({ children }) => (
                              <li className="leading-relaxed">{children}</li>
                            ),
                            a: ({ children, href }) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                              >
                                {children}
                              </a>
                            ),
                            hr: () => (
                              <hr className="my-6 border-border" />
                            ),
                          }}
                        >
                          {markdownContent}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )
                })()
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <AlertCircle className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p className="font-medium">{t("skillssh.contentNotAvailable", "Content not available")}</p>
                  <p className="text-sm mt-1">{t("skillssh.contentNotAvailableHint", "Unable to fetch skill content from repository")}</p>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailDialogOpen(false)}>
              {t("common.close", "Close")}
            </Button>
            {selectedSkill && (
              installedSlugs.has(selectedSkill.slug) ? (
                <Button
                  variant="outline"
                  className="gap-1.5 text-destructive"
                  disabled={installingSlugs.has(selectedSkill.slug)}
                  onClick={() => {
                    handleUninstallSkillSh(selectedSkill.slug)
                    setDetailDialogOpen(false)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("skillssh.uninstall", "Uninstall")}
                </Button>
              ) : (
                <Button
                  className="gap-1.5"
                  disabled={installingSlugs.has(selectedSkill.slug)}
                  onClick={() => {
                    openInstallDialog(selectedSkill.owner, selectedSkill.repo, selectedSkill.slug)
                    setDetailDialogOpen(false)
                  }}
                >
                  {installingSlugs.has(selectedSkill.slug) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t("skillssh.install", "Install")}
                </Button>
              )
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
