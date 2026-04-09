import { readDir, readTextFile, exists } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'
import type { SkillWithSource, SkillSource } from './types'
import { INHERENT_SKILL_NAMES, shouldIncludeDesktopControlSkill } from './types'
import type { ClawHubLockfile } from '@/lib/clawhub/types'
import { buildConfig } from '@/lib/build-config'

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

/** Load skills from a single directory, recording the directory path on each skill */
async function loadSkillsFromDir(
  dirPath: string,
  source: SkillSource,
): Promise<SkillWithSource[]> {
  const skills: SkillWithSource[] = []

  try {
    if (!(await exists(dirPath))) return skills

    const entries = await readDir(dirPath)

    for (const entry of entries) {
      if (entry.isDirectory && entry.name) {
        const skillMdPath = `${dirPath}/${entry.name}/SKILL.md`
        try {
          if (await exists(skillMdPath)) {
            const content = await readTextFile(skillMdPath)
            const name = extractSkillName(content, entry.name)
            skills.push({
              filename: entry.name,
              name,
              content,
              source,
              dirPath,
            })
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

/** Read skills.paths from opencode.json, resolving ~ and relative paths */
export async function readConfigSkillPaths(workspacePath: string): Promise<string[]> {
  try {
    const configPath = `${workspacePath}/opencode.json`
    if (!(await exists(configPath))) return []
    const content = await readTextFile(configPath)
    const config = JSON.parse(content)
    const rawPaths: unknown[] = config?.skills?.paths ?? []
    const home = await homeDir()
    return rawPaths
      .filter((p): p is string => typeof p === 'string')
      .map((p) =>
        p.startsWith('~/') || p === '~'
          ? p.replace(/^~/, home.replace(/\/$/, ''))
          : p.startsWith('/')
            ? p
            : `${workspacePath}/${p}`,
      )
  } catch {
    return []
  }
}

/** Return all known skill directories for the current workspace/user context. */
export async function getSkillDirectories(workspacePath: string | null): Promise<string[]> {
  const home = (await homeDir()).replace(/\/$/, '')
  const dirs = new Set<string>([
    `${home}/.config/opencode/skills`,
    `${home}/.claude/skills`,
    `${home}/.agents/skills`,
  ])

  if (workspacePath) {
    dirs.add(`${workspacePath}/.opencode/skills`)
    dirs.add(`${workspacePath}/.claude/skills`)
    dirs.add(`${workspacePath}/.agents/skills`)

    const configPaths = await readConfigSkillPaths(workspacePath)
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
 * 1. `.opencode/skills/`   → source: 'local' / 'builtin' / 'clawhub'
 * 2. `.claude/skills/`     → source: 'claude'
 * 3. `.agents/skills/`     → source: 'shared'
 *
 * Global paths (user-level):
 * 4. `~/.config/opencode/skills/` → source: 'global-opencode'
 * 5. `~/.claude/skills/`          → source: 'global-claude'
 * 6. `~/.agents/skills/`          → source: 'global-agent'
 *
 * Dynamic paths (from opencode.json `skills.paths`):
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

  // Read ClawHub lockfile to identify which .opencode/skills were installed from ClawHub
  let clawhubSlugs = new Set<string>()
  if (workspacePath) {
    clawhubSlugs = await readClawHubLockfile(workspacePath)
  }

  // ============ Workspace Skills (Project-level) ============

  // 1. Load workspace .opencode/skills (highest priority — user local)
  //    Skills whose dirname matches INHERENT_SKILL_NAMES are marked as 'builtin'.
  //    Skills whose dirname matches a ClawHub lockfile entry are marked as 'clawhub'.
  if (workspacePath) {
    const localDir = `${workspacePath}/.opencode/skills`
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

  // 4. Load global ~/.config/opencode/skills
  const globalOpencodeDir = `${home.replace(/\/$/, '')}/.config/opencode/skills`
  const globalOpencodeSkills = await loadSkillsFromDir(globalOpencodeDir, 'global-opencode')
  for (const s of globalOpencodeSkills) pushSkill({ ...s, isGlobal: true })

  // 5. Load global ~/.claude/skills
  const globalClaudeDir = `${home.replace(/\/$/, '')}/.claude/skills`
  const globalClaudeSkills = await loadSkillsFromDir(globalClaudeDir, 'global-claude')
  for (const s of globalClaudeSkills) pushSkill({ ...s, isGlobal: true })

  // 6. Load global ~/.agents/skills
  const globalAgentDir = `${home.replace(/\/$/, '')}/.agents/skills`
  const globalAgentSkills = await loadSkillsFromDir(globalAgentDir, 'global-agent')
  for (const s of globalAgentSkills) pushSkill({ ...s, isGlobal: true })

  // ============ OpenCode Plugin Skills ============

  // 7. Scan plugin cache for skills installed via opencode.json "plugin" array
  if (workspacePath) {
    const pluginCacheDir = `${workspacePath}/.opencode/cache/opencode/node_modules`
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

  // ============ Dynamic paths from opencode.json ============

  // 8+. Load dynamic paths from opencode.json skills.paths
  if (workspacePath) {
    const configPaths = await readConfigSkillPaths(workspacePath)
    for (const dirPath of configPaths) {
      const skills = await loadSkillsFromDir(dirPath, 'team')
      // Determine if path is global (starts with ~/ or absolute home path)
      const isGlobalPath = dirPath.startsWith(home) || dirPath.includes('.config/opencode') || dirPath.includes('.claude') || dirPath.includes('.agents')
      for (const s of skills) pushSkill({ ...s, isGlobal: isGlobalPath })
    }
  }

  // Deduplicate by filename with priority:
  // Workspace (project) > Global (user)
  // Within workspace: local > claude > clawhub > shared > team > builtin
  // Within global: global-opencode > global-claude > global-agent
  const priorityOrder: Record<SkillSource, number> = {
    local: 0,
    claude: 1,
    clawhub: 2,
    shared: 3,
    team: 4,
    builtin: 5,
    plugin: 6,
    'global-opencode': 7,
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
      return '内置'
    case 'plugin':
      return 'Plugin'
    case 'personal':
      return 'Personal'
    case 'global-opencode':
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
      return '.opencode/skills/'
    case 'claude':
      return '.claude/skills/'
    case 'clawhub':
      return '.opencode/skills/ (ClawHub)'
    case 'shared':
      return '.agents/skills/'
    case 'team':
      return 'opencode.json → skills.paths'
    case 'builtin':
      return `.opencode/skills/ (${buildConfig.app.name} 内置)`
    case 'plugin':
      return 'opencode.json → plugin'
    case 'personal':
      return ''
    case 'global-opencode':
      return '~/.config/opencode/skills/'
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
    case 'global-opencode':
      return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300'
    case 'global-claude':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300'
    case 'global-agent':
      return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300'
  }
}
