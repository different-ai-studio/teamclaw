import * as React from 'react'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Sparkles,
  Loader2,
  Plus,
  RefreshCw,
  FileText,
  Trash2,
  Edit2,
  AlertCircle,
  Eye,
  Save,
  Upload,
  Search,
  Shield,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Lock,
  Store,
  Users,
  Package,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { SKILLS_CHANGED_EVENT } from '@/hooks/useAppInit'
import { useWorkspaceStore } from '@/stores/workspace'
import { initOpenCodeClient } from '@/lib/opencode/sdk-client'
import { cn } from '@/lib/utils'
import { buildConfig } from '@/lib/build-config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard, SectionHeader } from './shared'
import type { SkillPermission, SkillPermissionMap } from '@/lib/opencode/config'
import {
  readSkillPermissions,
  writeSkillPermission,
  removeSkillPermission,
  resolveSkillPermission,
} from '@/lib/opencode/config'
import type { SkillSource } from '@/lib/git/types'
import { INHERENT_SKILL_NAMES } from '@/lib/git/types'
import { SkillsMarketplace } from './SkillsMarketplace'


interface Skill {
  filename: string
  name: string
  content: string
  source?: SkillSource
  dirPath?: string
}

type RestartOptions = {
  preserveChangeFlag?: boolean
}

const PERMISSION_META: Record<SkillPermission, { icon: typeof ShieldCheck; colorClass: string }> = {
  allow: { icon: ShieldCheck, colorClass: 'text-emerald-600 dark:text-emerald-400' },
  ask: { icon: ShieldQuestion, colorClass: 'text-amber-600 dark:text-amber-400' },
  deny: { icon: ShieldX, colorClass: 'text-red-600 dark:text-red-400' },
}

type SkillsTab = 'installed' | 'marketplace'

export const SkillsSection = React.memo(function SkillsSection() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [activeTab, setActiveTab] = React.useState<SkillsTab>('installed')
  const [skills, setSkills] = React.useState<Skill[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingSkill, setEditingSkill] = React.useState<Skill | null>(null)
  const [skillName, setSkillName] = React.useState('')
  const [skillContent, setSkillContent] = React.useState('')
  const [isSaving, setIsSaving] = React.useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const [skillToDelete, setSkillToDelete] = React.useState<Skill | null>(null)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [skillPermissions, setSkillPermissions] = React.useState<SkillPermissionMap>({})
  const [hasChanges, setHasChanges] = React.useState(false)
  const [hasSkillRuntimeChanges, setHasSkillRuntimeChanges] = React.useState(false)
  const [isRestarting, setIsRestarting] = React.useState(false)
  const [restartError, setRestartError] = React.useState<string | null>(null)
  const [installLocation, setInstallLocation] = React.useState<'workspace' | 'global'>('workspace')
  const [isViewMode, setIsViewMode] = React.useState(false)
  const [importZipPath, setImportZipPath] = React.useState<string | null>(null)
  const [importZipLabel, setImportZipLabel] = React.useState<string | null>(null)

  const defaultPermission: SkillPermission = skillPermissions['*'] ?? 'allow'

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

  const filteredSkills = React.useMemo(() => {
    if (!searchQuery.trim()) return skills
    const query = searchQuery.toLowerCase()
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.filename.toLowerCase().includes(query) ||
        skill.content.toLowerCase().includes(query)
    )
  }, [skills, searchQuery])

  const loadPermissions = React.useCallback(async () => {
    if (!workspacePath) return
    try {
      const perms = await readSkillPermissions(workspacePath)
      setSkillPermissions(perms)
    } catch (err) {
      console.error('[SkillsSection] Failed to load permissions:', err)
    }
  }, [workspacePath])

  const loadSkills = React.useCallback(async () => {
    if (!workspacePath) return
    
    setIsLoading(true)
    setError(null)
    
    try {
      const { exists, mkdir } = await import('@tauri-apps/plugin-fs')
      const skillsDir = `${workspacePath}/.opencode/skills`
      
      if (!(await exists(skillsDir))) {
        await mkdir(skillsDir, { recursive: true })
      }
      
      const { loadAllSkills } = await import('@/lib/git/skill-loader')
      const [{ skills: loadedSkills }] = await Promise.all([
        loadAllSkills(workspacePath),
        loadPermissions(),
      ])
      
      setSkills(loadedSkills.map(s => ({
        filename: s.filename,
        name: s.name,
        content: s.content,
        source: s.source,
        dirPath: s.dirPath,
      })))
    } catch (err) {
      console.error('Failed to load skills:', err)
      setError(err instanceof Error ? err.message : 'Failed to load skills')
    } finally {
      setIsLoading(false)
    }
  }, [workspacePath, loadPermissions])

  React.useEffect(() => {
    loadSkills()
  }, [loadSkills])

  React.useEffect(() => {
    const onTeamSynced = () => loadSkills()
    const onSkillsChanged = () => {
      setHasSkillRuntimeChanges(true)
      void loadSkills()
    }
    window.addEventListener(TEAM_SYNCED_EVENT, onTeamSynced)
    window.addEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged)
    return () => {
      window.removeEventListener(TEAM_SYNCED_EVENT, onTeamSynced)
      window.removeEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged)
    }
  }, [loadSkills])

  const restartOpenCodeInstance = React.useCallback(
    async (options?: RestartOptions) => {
      if (!workspacePath) return

      await invoke('stop_opencode')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const status = await invoke<{ url: string }>('start_opencode', {
        config: { workspace_path: workspacePath },
      })
      initOpenCodeClient({ baseUrl: status.url, workspacePath })

      if (!options?.preserveChangeFlag) {
        setHasChanges(false)
      }
    },
    [workspacePath]
  )

  // Skills file watching is disabled - users can manually refresh if needed

  const pickImportZip = async () => {
    setError(null)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path || typeof path !== 'string') {
        return
      }
      setImportZipPath(path)
      const base = path.split(/[/\\]/).pop() ?? path
      setImportZipLabel(base)
    } catch (err) {
      console.error('Failed to pick zip:', err)
      setError(err instanceof Error ? err.message : 'Failed to pick file')
    }
  }

  const importSkillFromZip = async () => {
    if (!importZipPath) return
    if (installLocation === 'workspace' && !workspacePath) return

    setIsSaving(true)
    setError(null)
    try {
      await invoke<string>('import_skill_from_zip', {
        workspacePath: installLocation === 'global' ? null : workspacePath,
        zipPath: importZipPath,
        isGlobal: installLocation === 'global',
      })
      await loadSkills()
      await restartOpenCodeInstance()
      setDialogOpen(false)
      setImportZipPath(null)
      setImportZipLabel(null)
      setInstallLocation('workspace')
    } catch (err) {
      console.error('Failed to import skill zip:', err)
      setError(err instanceof Error ? err.message : 'Failed to import skill')
    } finally {
      setIsSaving(false)
    }
  }

  const saveSkill = async () => {
    if (!skillName.trim()) return
    if (installLocation === 'workspace' && !workspacePath) return
    
    setIsSaving(true)
    setError(null)
    
    try {
      const { writeTextFile, exists, mkdir } = await import('@tauri-apps/plugin-fs')
      const { homeDir } = await import('@tauri-apps/api/path')
      
      // Determine base directory based on install location
      let skillsDir: string
      if (installLocation === 'global') {
        const home = await homeDir()
        skillsDir = `${home.replace(/\/$/, '')}/.config/opencode/skills`
      } else {
        skillsDir = `${workspacePath}/.opencode/skills`
      }
      
      if (!(await exists(skillsDir))) {
        await mkdir(skillsDir, { recursive: true })
      }
      
      const skillDirName = editingSkill?.filename || 
        skillName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      
      const skillDir = `${skillsDir}/${skillDirName}`
      
      if (!(await exists(skillDir))) {
        await mkdir(skillDir, { recursive: true })
      }
      
      let finalContent = skillContent.trim()
      if (!finalContent.startsWith('---')) {
        const description = skillContent.split('\n').slice(0, 3).join(' ').slice(0, 200) || skillName
        finalContent = `---
name: ${skillDirName}
description: ${description.replace(/\n/g, ' ')}
---

# ${skillName}

${skillContent.trim()}`
      }
      
      await writeTextFile(`${skillDir}/SKILL.md`, finalContent)
      await loadSkills()
      setHasSkillRuntimeChanges(true)
      
      setDialogOpen(false)
      setEditingSkill(null)
      setSkillName('')
      setSkillContent('')
      setInstallLocation('workspace')
    } catch (err) {
      console.error('Failed to save skill:', err)
      setError(err instanceof Error ? err.message : 'Failed to save skill')
    } finally {
      setIsSaving(false)
    }
  }

  const deleteSkill = async () => {
    if (!workspacePath || !skillToDelete) return

    try {
      if (skillToDelete.source === 'clawhub') {
        await invoke<string>('clawhub_uninstall', {
          workspacePath,
          slug: skillToDelete.filename,
        })
      } else {
        const { remove } = await import('@tauri-apps/plugin-fs')
        const baseDir = skillToDelete.dirPath ?? `${workspacePath}/.opencode/skills`
        await remove(`${baseDir}/${skillToDelete.filename}`, { recursive: true })
      }
      await loadSkills()
      setHasSkillRuntimeChanges(true)
      setDeleteConfirmOpen(false)
      setSkillToDelete(null)
    } catch (err) {
      console.error('Failed to delete skill:', err)
      setError(err instanceof Error ? err.message : 'Failed to delete skill')
    }
  }

  const openEditDialog = (skill: Skill) => {
    setEditingSkill(skill)
    setSkillName(skill.name)
    setSkillContent(skill.content)
    // Set location based on skill source
    setInstallLocation(skill.source?.startsWith('global-') ? 'global' : 'workspace')
    // Set view mode for non-editable skills (not local or clawhub)
    const isEditable = skill.source === 'local' || skill.source === 'clawhub'
    setIsViewMode(!isEditable)
    setDialogOpen(true)
  }

  const openCreateDialog = () => {
    setEditingSkill(null)
    setSkillName('')
    setSkillContent('')
    setInstallLocation('workspace')
    setIsViewMode(false)
    setImportZipPath(null)
    setImportZipLabel(null)
    setDialogOpen(true)
  }

  const handleDefaultPermissionChange = async (value: SkillPermission) => {
    if (!workspacePath) return
    try {
      await writeSkillPermission(workspacePath, '*', value)
      setSkillPermissions(prev => ({ ...prev, '*': value }))
      setHasChanges(true)
    } catch (err) {
      console.error('[SkillsSection] Failed to update default permission:', err)
    }
  }

  const handleSkillPermissionChange = async (skillName: string, value: string) => {
    if (!workspacePath) return
    try {
      if (value === '__inherited__') {
        await removeSkillPermission(workspacePath, skillName)
        setSkillPermissions(prev => {
          const next = { ...prev }
          delete next[skillName]
          return next
        })
      } else {
        await writeSkillPermission(workspacePath, skillName, value as SkillPermission)
        setSkillPermissions(prev => ({ ...prev, [skillName]: value as SkillPermission }))
      }
      setHasChanges(true)
    } catch (err) {
      console.error('[SkillsSection] Failed to update skill permission:', err)
    }
  }

  const handleRestartOpenCode = async () => {
    if (!workspacePath) return
    setIsRestarting(true)
    setRestartError(null)
    try {
      await restartOpenCodeInstance()
      setHasSkillRuntimeChanges(false)
    } catch (err) {
      console.error('[SkillsSection] Failed to restart OpenCode:', err)
      setRestartError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRestarting(false)
    }
  }

  if (!workspacePath) {
    return (
      <div className="space-y-6">
        <SectionHeader 
          icon={Sparkles} 
          title={t('settings.skills.title', 'Skills')} 
          description={t('settings.skills.description', 'Custom AI skills for your workspace')}
          iconColor="text-yellow-500"
        />
        <SettingCard>
          <div className="flex items-center gap-3 text-muted-foreground">
            <AlertCircle className="h-5 w-5" />
            <span>{t('settings.skills.selectWorkspace', 'Please select a workspace directory first')}</span>
          </div>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SectionHeader 
        icon={Sparkles} 
        title={t('settings.skills.title', 'Skills')} 
        description={t('settings.skills.descriptionDetail', 'AI skills from workspace and global directories (~/.config/opencode/skills, ~/.claude/skills, ~/.agents/skills)')}
        iconColor="text-yellow-500"
      />

      {/* Installed / Marketplace tabs */}
      <div className="flex items-center rounded-lg border border-input overflow-hidden w-fit">
        <button
          onClick={() => setActiveTab('installed')}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors",
            activeTab === 'installed'
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50"
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t('settings.skills.installed', 'Installed')}
          {skills.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground">({skills.length})</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('marketplace')}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors",
            activeTab === 'marketplace'
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50"
          )}
        >
          <Store className="h-3.5 w-3.5" />
          {t('settings.skills.marketplace', 'Marketplace')}
        </button>
      </div>

      {/* Marketplace tab */}
      {activeTab === 'marketplace' && (
        <SkillsMarketplace
          onInstalled={async () => {
            await loadSkills()
            setHasSkillRuntimeChanges(true)
          }}
        />
      )}

      {/* Installed tab content */}
      {activeTab === 'installed' && <>
      
      {/* Restart Warning */}
      {hasChanges && (
        <SettingCard className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border-amber-200 dark:border-amber-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                {t('settings.skills.configChanged', 'Skill Permission Changed')}
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                {t('settings.skills.restartToApply', 'Restart OpenCode to apply the new skill permission configuration.')}
              </p>
              {restartError && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-2">
                  {t('common.error', 'Error')}: {restartError}
                </p>
              )}
            </div>
            <Button
              size="sm"
              onClick={handleRestartOpenCode}
              disabled={isRestarting || !workspacePath}
              className="gap-2"
            >
              {isRestarting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('settings.mcp.restarting', 'Restarting...')}
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3" />
                  {t('settings.mcp.restart', 'Restart')}
                </>
              )}
            </Button>
          </div>
        </SettingCard>
      )}

      {hasSkillRuntimeChanges && (
        <SettingCard className="bg-gradient-to-br from-sky-50 to-cyan-50 dark:from-sky-950/30 dark:to-cyan-950/30 border-sky-200 dark:border-sky-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-sky-600 dark:text-sky-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-sky-900 dark:text-sky-100">
                {t('settings.skills.runtimeChanged', 'Detected Skill Changes')}
              </p>
              <p className="text-sm text-sky-700 dark:text-sky-300 mt-1">
                {t('settings.skills.restartToLoadNewSkills', 'New or updated skills were detected. Restart OpenCode to load them in the current runtime.')}
              </p>
              {restartError && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-2">
                  {t('common.error', 'Error')}: {restartError}
                </p>
              )}
            </div>
            <Button
              size="sm"
              onClick={handleRestartOpenCode}
              disabled={isRestarting || !workspacePath}
              className="gap-2"
            >
              {isRestarting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('settings.mcp.restarting', 'Restarting...')}
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3" />
                  {t('settings.mcp.restart', 'Restart')}
                </>
              )}
            </Button>
          </div>
        </SettingCard>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Default permission */}
      <SettingCard>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Shield className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('settings.skills.defaultPermission', 'Default Permission')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.skills.defaultPermissionHint', 'Controls the wildcard (*) rule for all skills without a specific override')}</p>
            </div>
          </div>
          <div className="flex items-center rounded-lg border border-input overflow-hidden shrink-0">
            {(['allow', 'ask', 'deny'] as const).map((perm) => {
              const meta = PERMISSION_META[perm]
              const Icon = meta.icon
              const isActive = defaultPermission === perm
              return (
                <button
                  key={perm}
                  onClick={() => handleDefaultPermissionChange(perm)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                    isActive
                      ? cn("bg-accent", meta.colorClass)
                      : "text-muted-foreground hover:bg-accent/50"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {perm === 'allow' ? t('settings.skills.permAllow', 'Allow') :
                   perm === 'ask' ? t('settings.skills.permAsk', 'Ask') :
                   t('settings.skills.permDeny', 'Deny')}
                </button>
              )
            })}
          </div>
        </div>
      </SettingCard>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('settings.skills.searchPlaceholder', 'Search skills...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button onClick={openCreateDialog} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          {t('settings.skills.addSkill', 'Add Skill')}
        </Button>
        <Button onClick={loadSkills} variant="outline" size="sm" className="gap-2" disabled={isLoading}>
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          {t('settings.llm.refresh', 'Refresh')}
        </Button>
      </div>
      
      {/* Skills list */}
      <div className="space-y-3">
        {isLoading ? (
          <SettingCard>
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          </SettingCard>
        ) : skills.length === 0 ? (
          <SettingCard>
            <div className="text-center py-6 text-muted-foreground">
              <Sparkles className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="font-medium">{t('settings.skills.noSkills', 'No skills yet')}</p>
              <p className="text-sm">{t('settings.skills.noSkillsHint', 'Create your first skill to enhance AI capabilities')}</p>
            </div>
          </SettingCard>
        ) : filteredSkills.length === 0 ? (
          <SettingCard>
            <div className="text-center py-6 text-muted-foreground">
              <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="font-medium">{t('settings.skills.noMatchingSkills', 'No matching skills')}</p>
              <p className="text-sm">{t('settings.skills.noMatchingSkillsHint', 'Try a different search term')}</p>
            </div>
          </SettingCard>
        ) : (
          (() => {
            const builtinSkills = filteredSkills.filter((s) => INHERENT_SKILL_NAMES.has(s.filename))
            const teamSkills = filteredSkills.filter((s) => !INHERENT_SKILL_NAMES.has(s.filename) && s.source === 'team')
            const workspaceSkills = filteredSkills.filter((s) => !INHERENT_SKILL_NAMES.has(s.filename) && !s.source?.startsWith('global-') && s.source !== 'team')
            const globalSkills = filteredSkills.filter((s) => !INHERENT_SKILL_NAMES.has(s.filename) && s.source?.startsWith('global-'))

            const renderSkillCard = (skill: Skill) => {
              const resolved = resolveSkillPermission(skill.filename, skillPermissions)
              const hasExplicitOverride = resolved.isExact
              const permColor = PERMISSION_META[resolved.permission].colorClass
              const isBuiltin = INHERENT_SKILL_NAMES.has(skill.filename)

              const SOURCE_BADGE: Record<string, string> = {
                local: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
                claude: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
                clawhub: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300',
                shared: 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300',
                personal: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
                team: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
                'global-opencode': 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300',
                'global-claude': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
                'global-agent': 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300',
              }
              const SOURCE_LABEL: Record<string, string> = {
                local: t('settings.mcp.local', 'Local'),
                claude: 'Claude',
                clawhub: 'ClawHub',
                shared: t('settings.skills.shared', 'Shared'),
                personal: t('settings.skills.personal', 'Personal'),
                team: 'Team',
                'global-opencode': t('settings.skills.globalOpencode', 'Global'),
                'global-claude': t('settings.skills.globalClaude', 'Global Claude'),
                'global-agent': t('settings.skills.globalAgent', 'Global Agent'),
              }

              return (
                <SettingCard
                  key={skill.filename}
                  className={isBuiltin ? 'border-blue-200/60 dark:border-blue-800/40 bg-blue-50/30 dark:bg-blue-950/10' : ''}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-yellow-500 shrink-0" />
                        <span className="font-medium truncate">{skill.name}</span>
                        {isBuiltin && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 border border-blue-200/60 dark:border-blue-700/50">
                            <Shield className="h-2.5 w-2.5" />
                            {t('settings.skills.inherent', 'Inherent')}
                          </span>
                        )}
                        {skill.source && !isBuiltin && SOURCE_BADGE[skill.source] && (
                          <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', SOURCE_BADGE[skill.source])}>
                            {SOURCE_LABEL[skill.source] ?? skill.source}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {skill.filename}
                      </p>
                      <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                        {skill.content.split('\n').slice(1).join(' ').slice(0, 150)}...
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={hasExplicitOverride ? resolved.permission : '__inherited__'}
                        onValueChange={(v) => handleSkillPermissionChange(skill.filename, v)}
                      >
                        <SelectTrigger className={cn("h-8 w-[150px] text-xs gap-1", permColor)}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__inherited__">
                            <span className="flex items-center gap-1.5">
                              <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                              {t('settings.skills.permInherited', 'Default')}
                              <span className="text-muted-foreground">
                                ({skillPermissions['*'] ?? 'allow'})
                              </span>
                            </span>
                          </SelectItem>
                          <SelectItem value="allow">
                            <span className="flex items-center gap-1.5">
                              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                              {t('settings.skills.permAllow', 'Allow')}
                            </span>
                          </SelectItem>
                          <SelectItem value="ask">
                            <span className="flex items-center gap-1.5">
                              <ShieldQuestion className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                              {t('settings.skills.permAsk', 'Ask')}
                            </span>
                          </SelectItem>
                          <SelectItem value="deny">
                            <span className="flex items-center gap-1.5">
                              <ShieldX className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                              {t('settings.skills.permDeny', 'Deny')}
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {isBuiltin ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditDialog(skill)}
                            className="h-8 w-8 p-0"
                            title={t('settings.skills.viewSkillTooltip', 'View skill (read-only)')}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <div
                            className="h-8 w-8 flex items-center justify-center text-blue-400/60 dark:text-blue-500/50 cursor-not-allowed"
                            title={t('settings.skills.inherentCannotDelete', 'Inherent skills cannot be deleted')}
                          >
                            <Lock className="h-3.5 w-3.5" />
                          </div>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditDialog(skill)}
                            className="h-8 w-8 p-0"
                            title={skill.source === 'local' || skill.source === 'clawhub' ? undefined : t('settings.skills.viewSkillTooltip', 'View skill (read-only)')}
                          >
                            {skill.source === 'local' ? <Edit2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSkillToDelete(skill)
                              setDeleteConfirmOpen(true)
                            }}
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </SettingCard>
              )
            }

            return (
              <>
                {/* Builtin skills group */}
                {builtinSkills.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Shield className="h-3.5 w-3.5 text-blue-500" />
                      <span className="text-xs font-medium text-blue-600 dark:text-blue-400 uppercase tracking-wide">
                        {t('settings.skills.inherentSkills', 'Inherent Skills')}
                      </span>
                      <div className="flex-1 h-px bg-blue-200/60 dark:bg-blue-800/40" />
                      <span className="text-xs text-muted-foreground">{t('settings.skills.managedByTeamClaw', { defaultValue: 'Managed by {{appName}}', appName: buildConfig.app.name })}</span>
                    </div>
                    {builtinSkills.map(renderSkillCard)}
                  </div>
                )}

                {/* Team skills group */}
                {teamSkills.length > 0 && (
                  <div className="space-y-3">
                    {builtinSkills.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Users className="h-3.5 w-3.5 text-purple-500" />
                        <span className="text-xs font-medium text-purple-600 dark:text-purple-400 uppercase tracking-wide">
                          {t('settings.skills.teamSkills', 'Team Skills')}
                        </span>
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-xs text-muted-foreground">{t('settings.skills.fromTeamConfig', 'From opencode.json → skills.paths')}</span>
                      </div>
                    )}
                    {teamSkills.map(renderSkillCard)}
                  </div>
                )}

                {/* Workspace skills group */}
                {workspaceSkills.length > 0 && (
                  <div className="space-y-3">
                    {(builtinSkills.length > 0 || teamSkills.length > 0) && (
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                        <span className="text-xs font-medium text-violet-600 dark:text-violet-400 uppercase tracking-wide">
                          {t('settings.skills.workspaceSkills', 'Workspace Skills')}
                        </span>
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-xs text-muted-foreground">{t('settings.skills.projectLevel', 'Project Level')}</span>
                      </div>
                    )}
                    {workspaceSkills.map(renderSkillCard)}
                  </div>
                )}

                {/* Global skills group */}
                {globalSkills.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-cyan-500" />
                      <span className="text-xs font-medium text-cyan-600 dark:text-cyan-400 uppercase tracking-wide">
                        {t('settings.skills.globalSkills', 'Global Skills')}
                      </span>
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground">{t('settings.skills.userLevel', 'User Level')}</span>
                    </div>
                    {globalSkills.map(renderSkillCard)}
                  </div>
                )}
              </>
            )
          })()
        )}
      </div>

      </>}

      {/* Create/Edit Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) {
            setImportZipPath(null)
            setImportZipLabel(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {isViewMode
                ? t('settings.skills.viewSkill', 'View Skill')
                : editingSkill
                  ? t('settings.skills.edit', 'Edit Skill')
                  : t('settings.skills.importFromZip', 'Import Skill from ZIP')}
            </DialogTitle>
            <DialogDescription>
              {isViewMode
                ? t('settings.skills.viewDescription', 'Read-only view of skill content')
                : editingSkill
                  ? t('settings.skills.dialogDescription', 'Skills are SKILL.md files with YAML frontmatter. Saved to .opencode/skills/<name>/SKILL.md (OpenCode format).')
                  : t('settings.skills.importZipDescription', 'Upload a .zip that contains exactly one SKILL.md. The entire skill folder is copied to your skills directory. Archives without SKILL.md are rejected.')}
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 space-y-4 overflow-y-auto py-4">
            {!isViewMode && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">{t('settings.skills.installLocation', 'Install Location')}</label>
                  <Select value={installLocation} onValueChange={(v) => setInstallLocation(v as 'workspace' | 'global')}>
                    <SelectTrigger className="h-9">
                      <SelectValue>
                        {installLocation === 'workspace' 
                          ? t('settings.skills.locationWorkspace', 'Workspace')
                          : t('settings.skills.locationGlobal', 'Global')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="w-[400px]">
                      <SelectItem value="workspace" className="cursor-pointer">
                        <div className="flex flex-col gap-0.5 py-1">
                          <span className="font-medium">{t('settings.skills.locationWorkspace', 'Workspace')}</span>
                          <span className="text-xs text-muted-foreground whitespace-normal">.opencode/skills/ - {t('settings.skills.projectOnly', 'Current project only')}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="global" className="cursor-pointer">
                        <div className="flex flex-col gap-0.5 py-1">
                          <span className="font-medium">{t('settings.skills.locationGlobal', 'Global')}</span>
                          <span className="text-xs text-muted-foreground whitespace-normal">~/.config/opencode/skills/ - {t('settings.skills.allProjects', 'All projects')}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {!editingSkill ? (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('settings.skills.skillArchive', 'Skill archive (.zip)')}</label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" size="sm" className="gap-2 shrink-0" onClick={pickImportZip}>
                        <Upload className="h-4 w-4" />
                        {t('settings.skills.chooseZip', 'Choose ZIP…')}
                      </Button>
                      <span className="text-sm text-muted-foreground truncate min-w-0 flex-1">
                        {importZipLabel ?? t('settings.skills.noZipSelected', 'No file selected')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('settings.skills.importZipHint', 'Folder name comes from the parent of SKILL.md, or from the zip file name if SKILL.md is at the archive root.')}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{t('settings.skills.name', 'Skill Name')}</label>
                      <Input
                        placeholder={t('settings.skills.namePlaceholder', 'e.g., Git Workflow Guide')}
                        value={skillName}
                        onChange={(e) => setSkillName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2 flex-1">
                      <label className="text-sm font-medium">{t('settings.skills.content', 'Content (Markdown)')}</label>
                      <textarea
                        className="w-full min-h-[300px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="# My Skill&#10;&#10;Describe what this skill does and provide instructions for the AI..."
                        value={skillContent}
                        onChange={(e) => setSkillContent(e.target.value)}
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {isViewMode && (
              <div className="space-y-5">
                {(() => {
                  const { metadata, markdownContent } = parseFrontmatter(skillContent)
                  return (
                    <>
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
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {markdownContent}
                        </ReactMarkdown>
                      </div>
                    </>
                  )
                })()}
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {isViewMode ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
            </Button>
            {!isViewMode && (
              <Button
                onClick={editingSkill ? saveSkill : importSkillFromZip}
                disabled={
                  isSaving ||
                  (editingSkill ? !skillName.trim() : !importZipPath)
                }
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {editingSkill
                      ? t('settings.mcp.saving', 'Saving...')
                      : t('settings.skills.importing', 'Importing...')}
                  </>
                ) : editingSkill ? (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    {t('settings.skills.saveSkill', 'Save Skill')}
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    {t('settings.skills.importButton', 'Import')}
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.skills.deleteTitle', 'Delete Skill')}</DialogTitle>
            <DialogDescription>
              {t('settings.skills.deleteConfirm', { name: skillToDelete?.name ?? '', defaultValue: `Are you sure you want to delete "${skillToDelete?.name}"? This action cannot be undone.` })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={deleteSkill}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('fileExplorer.delete', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
