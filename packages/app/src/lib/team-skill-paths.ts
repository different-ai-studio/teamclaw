import { exists, readTextFile } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'

/**
 * Workspace symlink/dir name for team-shared content.
 * Must match `TEAM_LINK_NAME` in `apps/daemon/src/config/global_team_store.rs`.
 */
export const TEAM_SHARE_LINK_DIR = 'teamclaw-team'

async function readOnboardedTeamId(): Promise<string | null> {
  try {
    const home = trimTrailingPathSeparators(await homeDir())
    const configPath = `${home}/.amuxd/daemon.toml`
    if (!(await exists(configPath))) return null
    const content = await readTextFile(configPath)
    const match = content.match(/team_id\s*=\s*"([^"]+)"/)
    const teamId = match?.[1]?.trim()
    return teamId || null
  } catch {
    return null
  }
}

/** Global team share dir: `~/.amuxd/teams/<team_id>/teamclaw-team`. */
async function globalTeamDir(teamId: string): Promise<string> {
  const home = trimTrailingPathSeparators(await homeDir())
  return `${home}/.amuxd/teams/${teamId}/${TEAM_SHARE_LINK_DIR}`
}

/**
 * The single global team share dir `~/.amuxd/teams/<team_id>/teamclaw-team`,
 * regardless of whether it exists on disk. Returns `null` only when no team is
 * onboarded (no `team_id` in `~/.amuxd/daemon.toml`).
 *
 * This is the daemon-owned canonical copy. We intentionally do NOT consider the
 * per-workspace `teamclaw-team` symlink here — reading the global dir directly
 * is robust against a missing or dangling workspace link.
 */
export async function globalTeamShareDir(): Promise<string | null> {
  const teamId = await readOnboardedTeamId()
  if (!teamId) return null
  return globalTeamDir(teamId)
}

/**
 * Resolve the global team share dir, but only when it actually exists on disk.
 * Used by callers that want to enumerate real content (skills, knowledge); they
 * treat `null` as "nothing to contribute".
 */
export async function resolveTeamDir(_workspacePath: string): Promise<string | null> {
  const globalDir = await globalTeamShareDir()
  if (!globalDir) return null
  return (await exists(globalDir)) ? globalDir : null
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[/\\]+$/, '')
}

function trimLeadingPathSeparators(path: string): string {
  return path.replace(/^[/\\]+/, '')
}

function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path)
}

function joinPath(parent: string, child: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${trimTrailingPathSeparators(parent)}${separator}${trimLeadingPathSeparators(child)}`
}

async function readSkillPathsFromConfig(
  workspacePath: string,
  configFileName: string,
): Promise<string[]> {
  try {
    const configPath = `${workspacePath}/${configFileName}`
    if (!(await exists(configPath))) return []
    const content = await readTextFile(configPath)
    const config = JSON.parse(content) as { skills?: { paths?: unknown } }
    const rawPaths = Array.isArray(config?.skills?.paths) ? config.skills.paths : []
    const home = trimTrailingPathSeparators(await homeDir())
    return rawPaths
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => {
        const trimmed = p.trim()
        if (trimmed === '~') return home
        if (/^~[\\/]/.test(trimmed)) {
          return joinPath(home, trimmed.slice(2))
        }
        return isAbsolutePath(trimmed) ? trimmed : joinPath(workspacePath, trimmed)
      })
  } catch {
    return []
  }
}

/**
 * All directories that should contribute `source: 'team'` skills for a workspace.
 *
 * Sources (deduped):
 * - `teamclaw.json` → `skills.paths`
 * - `opencode.json` → `skills.paths` (legacy / OpenCode-aligned config)
 * - `<workspace>/teamclaw-team/skills` when the team share link exists on disk
 */
async function remapTeamSkillPath(
  workspacePath: string,
  path: string,
  teamId: string | null,
): Promise<string | null> {
  if (await exists(path)) return path
  if (!teamId) return null

  const linkRoot = `${workspacePath}/${TEAM_SHARE_LINK_DIR}`
  if (!path.startsWith(linkRoot)) return null

  const rel = path.slice(linkRoot.length).replace(/^[/\\]+/, '')
  const globalDir = await globalTeamDir(teamId)
  const remapped = rel ? joinPath(globalDir, rel) : globalDir
  return (await exists(remapped)) ? remapped : null
}

export async function collectTeamSkillPaths(workspacePath: string): Promise<string[]> {
  const dirs = new Set<string>()
  const teamId = await readOnboardedTeamId()

  for (const path of await readSkillPathsFromConfig(workspacePath, 'teamclaw.json')) {
    const resolved = await remapTeamSkillPath(workspacePath, path, teamId)
    if (resolved) dirs.add(resolved)
  }
  for (const path of await readSkillPathsFromConfig(workspacePath, 'opencode.json')) {
    const resolved = await remapTeamSkillPath(workspacePath, path, teamId)
    if (resolved) dirs.add(resolved)
  }

  const teamDir = await resolveTeamDir(workspacePath)
  if (teamDir) {
    const defaultTeamSkillsDir = joinPath(teamDir, 'skills')
    if (await exists(defaultTeamSkillsDir)) {
      dirs.add(defaultTeamSkillsDir)
    }
  }

  return Array.from(dirs)
}

/** Paths from `teamclaw.json` only — used by tests that assert config parsing. */
export async function readConfigSkillPaths(workspacePath: string): Promise<string[]> {
  return readSkillPathsFromConfig(workspacePath, 'teamclaw.json')
}
