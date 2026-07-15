import { readDir, readTextFile, exists } from '@tauri-apps/plugin-fs'
import { collectTeamSkillPaths } from '@/lib/team-skill-paths'
import { homeDir } from '@tauri-apps/api/path'
import type { SkillWithSource, SkillSource } from './types'
import { INHERENT_SKILL_NAMES, shouldIncludeDesktopControlSkill } from './types'
import type { ClawHubLockfile } from '@/lib/clawhub/types'
import { buildConfig, TEAM_REPO_DIR } from '@/lib/build-config'
import i18n from '@/lib/i18n'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract skill name from SKILL.md content (frontmatter or heading) */
function extractSkillName(content: string, fallback: string): string {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?name:\s*(.+?)\n[\s\S]*?---/)
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim()
  }
  const firstLine = content.split('\n').find(line => line.startsWith('#'))
  if (firstLine) {
    return firstLine.replace(/^#+\s*/, '').trim()
  }
  return fallback
}

function getLastPathSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

export function buildSkillInvocationName(parentDir: string, filename: string): string {
  const scope = getLastPathSegment(parentDir)
  return scope && scope !== 'skills' ? `${scope}/${filename}` : filename
}

/** Load skills from a single directory, recording the directory path on each skill */
async function loadSkillsFromDir(
  dirPath: string,
  source: SkillSource,
): Promise<SkillWithSource[]> {
  const skills: SkillWithSource[] = []

  const tryLoadSkill = async (skillRoot: string, skillDirName: string, parentDir: string) => {
    const skillMdPath = `${skillRoot}/SKILL.md`
    if (!(await exists(skillMdPath))) return false

    const content = await readTextFile(skillMdPath)
    const name = extractSkillName(content, skillDirName)
    skills.push({
      filename: skillDirName,
      name,
      invocationName: buildSkillInvocationName(parentDir, skillDirName),
      content,
      source,
      dirPath: parentDir,
    })
    return true
  }

  try {
    if (!(await exists(dirPath))) return skills

    const entries = await readDir(dirPath)

    for (const entry of entries) {
      if (entry.isDirectory && entry.name) {
        try {
          const entryPath = `${dirPath}/${entry.name}`
          if (await tryLoadSkill(entryPath, entry.name, dirPath)) {
            continue
          }

          const nestedEntries = await readDir(entryPath)
          for (const nestedEntry of nestedEntries) {
            if (!nestedEntry.isDirectory || !nestedEntry.name) continue
            await tryLoadSkill(`${entryPath}/${nestedEntry.name}`, nestedEntry.name, entryPath)
          }
        } catch {
          console.warn(`[SkillLoader] Failed to load skill ${entry.name} from ${dirPath}`)
        }
      }
    }
  } catch {
    console.warn(`[SkillLoader] Cannot access ${dirPath}`)
  }

  return skills
}

/** Read .clawhub/lock.json to identify skills installed from ClawHub */
async function readClawHubLockfile(workspacePath: string): Promise<Set<string>> {
  const slugs = new Set<string>()
  const paths = [
    `${workspacePath}/.clawhub/lock.json`,
    `${workspacePath}/.clawdhub/lock.json`,
  ]
  for (const lockPath of paths) {
    try {
      if (!(await exists(lockPath))) continue
      const raw = await readTextFile(lockPath)
      const lock: ClawHubLockfile = JSON.parse(raw)
      if (lock.skills) {
        for (const slug of Object.keys(lock.skills)) {
          slugs.add(slug)
        }
      }
      return slugs
    } catch {
      // try next
    }
  }
  return slugs
}

// ─── Multi-Source Loader ────────────────────────────────────────────────────

export { collectTeamSkillPaths, readConfigSkillPaths } from '@/lib/team-skill-paths'

/** Return all known skill directories for the current workspace/user context. */
export async function getSkillDirectories(workspacePath: string | null): Promise<string[]> {
  const home = trimTrailingPathSeparators(await homeDir())
  const dirs = new Set<string>([
    `${home}/.config/teamclaw/skills`,
    `${home}/.claude/skills`,
    `${home}/.agents/skills`,
  ])

  if (workspacePath) {
    dirs.add(`${workspacePath}/.teamclaw/skills`)
    dirs.add(`${workspacePath}/.claude/skills`)
    dirs.add(`${workspacePath}/.agents/skills`)

    const configPaths = await collectTeamSkillPaths(workspacePath)
    for (const dirPath of configPaths) {
      dirs.add(dirPath)
    }
  }

  return Array.from(dirs)
}

/**
 * Load skills from all sources with priority-based merging.
 *
 * Workspace paths (project-level):
 * 1. `.teamclaw/skills/`   → source: 'local' / 'builtin' / 'clawhub'
 * 2. `.claude/skills/`     → source: 'claude'
 * 3. `.agents/skills/`     → source: 'shared'
 *
 * Global paths (user-level):
 * 4. `~/.config/teamclaw/skills/` → source: 'global-teamclaw'
 * 5. `~/.claude/skills/`          → source: 'global-claude'
 * 6. `~/.agents/skills/`          → source: 'global-agent'
 *
 * Dynamic paths (from teamclaw.json `skills.paths`):
 * 7+. Each configured path → source: 'team'
 *
 * Same-name skills are resolved by priority — workspace > global.
 */
export async function loadAllSkills(
  workspacePath: string | null,
): Promise<{
  skills: SkillWithSource[]
  overrides: Array<{ name: string; winner: SkillSource; loser: SkillSource }>
}> {
  const allSkills: SkillWithSource[] = []
  const overrides: Array<{ name: string; winner: SkillSource; loser: SkillSource }> = []

  const pushSkill = (skill: SkillWithSource) => {
    if (!shouldIncludeDesktopControlSkill(skill.filename)) return
    allSkills.push(skill)
  }

  // Get user home directory
  const home = await homeDir()

  // Read ClawHub lockfile to identify which .teamclaw/skills were installed from ClawHub
  let clawhubSlugs = new Set<string>()
  if (workspacePath) {
    clawhubSlugs = await readClawHubLockfile(workspacePath)
  }

  // ============ Workspace Skills (Project-level) ============

  // 1. Load workspace .teamclaw/skills (highest priority — user local)
  //    Skills whose dirname matches INHERENT_SKILL_NAMES are marked as 'builtin'.
  //    Skills whose dirname matches a ClawHub lockfile entry are marked as 'clawhub'.
  if (workspacePath) {
    const localDir = `${workspacePath}/.teamclaw/skills`
    const localSkills = await loadSkillsFromDir(localDir, 'local')
    for (const skill of localSkills) {
      if (INHERENT_SKILL_NAMES.has(skill.filename)) {
        pushSkill({ ...skill, source: 'builtin' as SkillSource, isGlobal: false })
      } else if (clawhubSlugs.has(skill.filename)) {
        pushSkill({ ...skill, source: 'clawhub' as SkillSource, isGlobal: false })
      } else {
        pushSkill({ ...skill, isGlobal: false })
      }
    }
  }

  // 2. Load workspace .claude/skills (Cursor/Claude skills)
  if (workspacePath) {
    const claudeDir = `${workspacePath}/.claude/skills`
    const claudeSkills = await loadSkillsFromDir(claudeDir, 'claude')
    for (const s of claudeSkills) pushSkill({ ...s, isGlobal: false })
  }

  // 3. Load workspace .agents/skills
  if (workspacePath) {
    const sharedDir = `${workspacePath}/.agents/skills`
    const sharedSkills = await loadSkillsFromDir(sharedDir, 'shared')
    for (const s of sharedSkills) pushSkill({ ...s, isGlobal: false })
  }

  // ============ Global Skills (User-level) ============

  // 4. Load global ~/.config/teamclaw/skills
  const globalTeamclawDir = `${home.replace(/\/$/, '')}/.config/teamclaw/skills`
  const globalTeamclawSkills = await loadSkillsFromDir(globalTeamclawDir, 'global-teamclaw')
  for (const s of globalTeamclawSkills) pushSkill({ ...s, isGlobal: true })

  // 5. Load global ~/.claude/skills
  const globalClaudeDir = `${home.replace(/\/$/, '')}/.claude/skills`
  const globalClaudeSkills = await loadSkillsFromDir(globalClaudeDir, 'global-claude')
  for (const s of globalClaudeSkills) pushSkill({ ...s, isGlobal: true })

  // 6. Load global ~/.agents/skills
  const globalAgentDir = `${home.replace(/\/$/, '')}/.agents/skills`
  const globalAgentSkills = await loadSkillsFromDir(globalAgentDir, 'global-agent')
  for (const s of globalAgentSkills) pushSkill({ ...s, isGlobal: true })

  // ============ Plugin Skills ============

  // 7. Scan plugin cache for skills installed via teamclaw.json "plugin" array
  if (workspacePath) {
    const pluginCacheDir = `${workspacePath}/.teamclaw/cache/agent/node_modules`
    try {
      if (await exists(pluginCacheDir)) {
        const pluginEntries = await readDir(pluginCacheDir)
        for (const entry of pluginEntries) {
          if (entry.isDirectory && entry.name && !entry.name.startsWith('.')) {
            const skillsDir = `${pluginCacheDir}/${entry.name}/skills`
            try {
              if (await exists(skillsDir)) {
                const pluginSkills = await loadSkillsFromDir(skillsDir, 'plugin')
                for (const s of pluginSkills) pushSkill({ ...s, isGlobal: false })
              }
            } catch {
              // skip inaccessible plugin
            }
          }
        }
      }
    } catch {
      console.warn('[SkillLoader] Cannot access plugin cache directory')
    }
  }

  // ============ Dynamic paths from teamclaw.json ============

  // 8+. Team-shared + configured skill paths (teamclaw.json, opencode.json, teamclaw-team/skills)
  if (workspacePath) {
    const configPaths = await collectTeamSkillPaths(workspacePath)
    for (const dirPath of configPaths) {
      const skills = await loadSkillsFromDir(dirPath, 'team')
      // Determine if path is global (starts with ~/ or absolute home path)
      const normalizedDirPath = dirPath.replace(/\\/g, '/')
      const normalizedHome = home.replace(/\\/g, '/')
      const isGlobalPath =
        normalizedDirPath.startsWith(normalizedHome) ||
        normalizedDirPath.includes('.config/teamclaw') ||
        normalizedDirPath.includes('.claude') ||
        normalizedDirPath.includes('.agents')
      for (const s of skills) pushSkill({ ...s, isGlobal: isGlobalPath })
    }
  }

  // Deduplicate by filename with priority:
  // Workspace (project) > Global (user)
  // Within workspace: local > claude > clawhub > shared > team > builtin
  // Within global: global-teamclaw > global-claude > global-agent
  const priorityOrder: Record<SkillSource, number> = {
    local: 0,
    claude: 1,
    clawhub: 2,
    shared: 3,
    team: 4,
    builtin: 5,
    plugin: 6,
    'global-teamclaw': 7,
    'global-claude': 8,
    'global-agent': 9,
    personal: 10,
  }
  const seen = new Map<string, SkillWithSource>()

  for (const skill of allSkills) {
    const existing = seen.get(skill.filename)
    if (existing) {
      const existingPriority = priorityOrder[existing.source]
      const newPriority = priorityOrder[skill.source]
      if (newPriority < existingPriority) {
        overrides.push({ name: skill.filename, winner: skill.source, loser: existing.source })
        seen.set(skill.filename, skill)
      } else {
        overrides.push({ name: skill.filename, winner: existing.source, loser: skill.source })
      }
    } else {
      seen.set(skill.filename, skill)
    }
  }

  for (const override of overrides) {
    console.info(
      `[SkillLoader] Skill "${override.name}": ${override.winner} overrides ${override.loser}`
    )
  }

  return {
    skills: Array.from(seen.values()),
    overrides,
  }
}

/**
 * Get the source badge label for display
 */
export function getSourceLabel(source: SkillSource): string {
  switch (source) {
    case 'local':
      return 'Local'
    case 'claude':
      return 'Claude'
    case 'clawhub':
      return 'ClawHub'
    case 'shared':
      return 'Shared'
    case 'team':
      return 'Team'
    case 'builtin':
      return i18n.t('skills.builtinLabel')
    case 'plugin':
      return 'Plugin'
    case 'personal':
      return 'Personal'
    case 'global-teamclaw':
      return 'Global'
    case 'global-claude':
      return 'Global Claude'
    case 'global-agent':
      return 'Global Agent'
  }
}

/**
 * Get the source directory path description for display
 */
export function getSourceDirHint(source: SkillSource): string {
  switch (source) {
    case 'local':
      return '.teamclaw/skills/'
    case 'claude':
      return '.claude/skills/'
    case 'clawhub':
      return '.teamclaw/skills/ (ClawHub)'
    case 'shared':
      return '.agents/skills/'
    case 'team':
      return `${TEAM_REPO_DIR}/skills/ (team share)`
    case 'builtin':
      return i18n.t('skills.builtinPath', { app: buildConfig.app.name })
    case 'plugin':
      return 'teamclaw.json → plugin'
    case 'personal':
      return ''
    case 'global-teamclaw':
      return '~/.config/teamclaw/skills/'
    case 'global-claude':
      return '~/.claude/skills/'
    case 'global-agent':
      return '~/.agents/skills/'
  }
}

/**
 * Get the source badge CSS class for display
 */
export function getSourceBadgeClass(source: SkillSource): string {
  switch (source) {
    case 'local':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300'
    case 'claude':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300'
    case 'clawhub':
      return 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300'
    case 'shared':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300'
    case 'team':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300'
    case 'builtin':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 border border-blue-200/60 dark:border-blue-700/50'
    case 'plugin':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300'
    case 'personal':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
    case 'global-teamclaw':
      return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300'
    case 'global-claude':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300'
    case 'global-agent':
      return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300'
  }
}
