import * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Shapes, Sparkles, UserRound } from "lucide-react"
import { useWorkspaceStore } from "@/stores/workspace"
import { SettingCard } from "./shared"
import { RolesSection } from "./RolesSection"
import { SkillsSection } from "./SkillsSection"
import { loadRolesSkillsWorkspaceState } from "@/lib/roles/loader"
import type { RolesSkillsWorkspaceState } from "@/lib/roles/types"

type ResourceTab = "roles" | "skills"

export const RolesSkillsSection = React.memo(function RolesSkillsSection() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [activeTab, setActiveTab] = React.useState<ResourceTab>("roles")
  const [focusedRoleSlug, setFocusedRoleSlug] = React.useState<string | null>(null)
  const [focusedSkillName, setFocusedSkillName] = React.useState<string | null>(null)
  const [embeddedSkillSearch, setEmbeddedSkillSearch] = React.useState("")
  const [workspaceState, setWorkspaceState] = React.useState<RolesSkillsWorkspaceState | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refreshWorkspaceState = React.useCallback(async () => {
    if (!workspacePath) {
      setWorkspaceState(null)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const nextState = await loadRolesSkillsWorkspaceState(workspacePath)
      setWorkspaceState(nextState)
    } catch (err) {
      console.error("[RolesSkillsSection] Failed to load workspace state:", err)
      setError(
        err instanceof Error
          ? err.message
          : t("settings.rolesSkills.loadFailed", "Failed to load roles and skills"),
      )
    } finally {
      setIsLoading(false)
    }
  }, [t, workspacePath])

  React.useEffect(() => {
    void refreshWorkspaceState()
  }, [refreshWorkspaceState])

  const handleOpenSkill = React.useCallback((skillName: string) => {
    setFocusedRoleSlug(null)
    setFocusedSkillName(skillName)
    setEmbeddedSkillSearch(skillName)
    setActiveTab("skills")
  }, [])

  const handleOpenRole = React.useCallback((roleSlug: string) => {
    setFocusedSkillName(null)
    setFocusedRoleSlug(roleSlug)
    setActiveTab("roles")
  }, [])

  const metrics = workspaceState?.metrics ?? {
    rolesCount: 0,
    skillsCount: 0,
    linkedSkillsCount: 0,
    unlinkedSkillsCount: 0,
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border bg-background">
            <Shapes className="h-4.5 w-4.5 text-foreground/80" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("settings.rolesSkills.title", "Roles & Skills")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t(
                "settings.rolesSkills.subtitle",
                "Roles define routing and responsibility. Skills provide reusable execution procedures.",
              )}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-2.5 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="relative inline-grid h-11 grid-cols-2 items-center rounded-[14px] border border-border/70 bg-muted/50 p-1">
            <div className="absolute inset-1">
              <div
                aria-hidden="true"
                className={cn(
                  "absolute inset-y-0 left-0 w-1/2 rounded-[10px] border border-border/60 bg-background transition-transform duration-200 ease-out",
                  activeTab === "roles" ? "translate-x-0" : "translate-x-full",
                )}
              />
            </div>
            <button
              type="button"
              onClick={() => setActiveTab("roles")}
              className={cn(
                "relative z-10 inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-5 text-sm font-medium transition-colors",
                activeTab === "roles"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <UserRound className="h-4 w-4" />
              {t("settings.roles.title", "Roles")}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("skills")}
              className={cn(
                "relative z-10 inline-flex h-9 items-center justify-center gap-2 rounded-[10px] px-5 text-sm font-medium transition-colors",
                activeTab === "skills"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Sparkles className="h-4 w-4" />
              {t("settings.skills.title", "Skills")}
            </button>
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-sm text-foreground/85">
            {t("settings.rolesSkills.summaryLine", "{{roles}} roles · {{skills}} skills · {{linked}} linked · {{unlinked}} unlinked", {
              roles: metrics.rolesCount,
              skills: metrics.skillsCount,
              linked: metrics.linkedSkillsCount,
              unlinked: metrics.unlinkedSkillsCount,
            })}
          </div>
        </div>
      </div>

      <div className="min-h-[40rem] min-w-0">
        {activeTab === "roles" ? (
          <RolesSection
            embeddedConsole
            onOpenSkill={handleOpenSkill}
            focusRoleSlug={focusedRoleSlug}
            onFocusHandled={() => setFocusedRoleSlug(null)}
            onDataChange={() => void refreshWorkspaceState()}
          />
        ) : (
          <SkillsSection
            embeddedConsole
            roleUsageBySkill={workspaceState?.roleUsageBySkill ?? {}}
            onOpenRole={handleOpenRole}
            focusSkillName={focusedSkillName}
            onFocusHandled={() => setFocusedSkillName(null)}
            onDataChange={() => void refreshWorkspaceState()}
            sharedSearchQuery={embeddedSkillSearch}
            onSharedSearchQueryChange={setEmbeddedSkillSearch}
          />
        )}
      </div>

      {isLoading && !workspaceState ? (
        <SettingCard className="border-dashed bg-muted/10">
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t("settings.rolesSkills.loading", "Loading roles and skills…")}
          </div>
        </SettingCard>
      ) : null}
    </div>
  )
})
