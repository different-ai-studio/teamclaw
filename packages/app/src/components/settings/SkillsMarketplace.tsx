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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
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

interface SkillsMarketplaceProps {
  onInstalled?: () => void | Promise<void>
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
}: SkillsMarketplaceProps) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [activeSource, setActiveSource] = React.useState<"clawhub" | "skillssh">("clawhub")
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
      setError(err instanceof Error ? err.message : String(err))
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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [isTauri, fetchLeaderboard])

  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = React.useCallback((value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }
    searchTimerRef.current = setTimeout(() => {
      doSearchSkillSh(value)
    }, 400)
  }, [doSearchSkillSh])

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
    if (activeSource === "skillssh" && !searchQuery.trim()) {
      fetchLeaderboard()
    }
  }, [activeSource, skillsShCategory, fetchLeaderboard, searchQuery, loadInstalled])

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
      setError(err instanceof Error ? err.message : String(err))
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
    <div className="space-y-4">
      {/* Source Tabs */}
      <Tabs value={activeSource} onValueChange={(v) => setActiveSource(v as typeof activeSource)}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="clawhub" className="flex items-center gap-2">
            <Package className="h-4 w-4" />
            ClawHub Marketplace
          </TabsTrigger>
          <TabsTrigger value="skillssh" className="flex items-center gap-2">
            <Award className="h-4 w-4" />
            skills.sh Marketplace
          </TabsTrigger>
        </TabsList>

        {/* ClawHub Tab – forceMount keeps state alive across tab switches */}
        <TabsContent value="clawhub" className="mt-4" forceMount style={{ display: activeSource === 'clawhub' ? undefined : 'none' }}>
          <ClawHubMarketplace onInstalled={onInstalled} />
        </TabsContent>

        {/* skills.sh Tab */}
        <TabsContent value="skillssh" className="mt-4 space-y-4" forceMount style={{ display: activeSource === 'skillssh' ? undefined : 'none' }}>
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
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("skillssh.searchPlaceholder", "Search skills...")}
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchLeaderboard()}
              disabled={isLoading}
              className="gap-1.5"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
              {t("common.refresh", "Refresh")}
            </Button>
            {!searchQuery.trim() && (
              <div className="flex items-center rounded-lg border border-input overflow-hidden shrink-0">
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

          {/* Marketplace */}
          <div className="space-y-3">
            {isLoading ? (
              <SettingCard>
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
                  <p className="text-sm text-muted-foreground">{t("skillssh.loading", "Loading skills.sh marketplace...")}</p>
                </div>
              </SettingCard>
            ) : filteredSkillsSh.length === 0 ? (
              <SettingCard>
                <div className="text-center py-6 text-muted-foreground">
                  <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p className="font-medium">{t("skillssh.noResults", "No skills found")}</p>
                  <p className="text-sm">{t("skillssh.tryDifferent", "Try a different search term")}</p>
                </div>
              </SettingCard>
            ) : (
              filteredSkillsSh.map((skill) => {
                return (
                  <SettingCard
                    key={skill.slug}
                    className="hover:border-primary/30 transition-colors cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-3">
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
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
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
                      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
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
              <div className="flex items-center gap-2">
                <Input
                  placeholder={t("skillssh.sourcePlaceholder", "owner/repo or https://github.com/owner/repo")}
                  className="flex-1 h-9 font-mono text-xs"
                  id="npx-source-input"
                />
                <Input
                  placeholder={t("skillssh.skillNamePlaceholder", "skill-name (optional)")}
                  className="w-40 h-9 text-xs"
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
                      setError(err instanceof Error ? err.message : String(err))
                    } finally {
                      setInstallingSlugs((prev) => {
                        const next = new Set(prev)
                        next.delete(tag)
                        return next
                      })
                    }
                  }}
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
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <ArrowUpCircle className="h-4 w-4" />
                  {t("skillssh.manageInstalled", "Manage Installed Skills")}
                </h4>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("skillssh.manageDesc", "Check for updates or update all installed skills via npx skills")}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
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
                    {(leaderboard.totalInstalls / 1000).toFixed(0)}K+
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
                    {new Date(leaderboard.lastUpdated * 1000).toLocaleDateString()}
                  </span>
                  <span className="text-xs text-muted-foreground">{t("skillssh.lastSync", "last sync")}</span>
                </div>
              </div>
            </SettingCard>
          )}
        </TabsContent>
      </Tabs>

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
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
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
                  const { metadata, markdownContent } = parseFrontmatter(skillContent)
                  return (
                    <div className="space-y-5">
                      {/* Metadata Table */}
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
                      
                      {/* Markdown Content */}
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
            {selectedSkill && !installedSlugs.has(selectedSkill.slug) && (
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
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
