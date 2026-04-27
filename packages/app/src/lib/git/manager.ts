import { invoke } from '@tauri-apps/api/core'
import { dirname, homeDir, join } from '@tauri-apps/api/path'
import { mkdir, exists } from '@tauri-apps/plugin-fs'
import type {
  GitCommandResult,
  GitStatusResult,
  GitLogEntry,
  GitRepo,
  GitRepoConfig,
  RepoSource,
  RepoResourceType,
} from './types'
import { TEAMCLAW_DIR } from '@/lib/build-config'

// ─── Constants ──────────────────────────────────────────────────────────────
const GIT_DIR = 'git'
const TEAM_DIR = 'team'
const PERSONAL_DIR = 'personal'
const CONFIG_FILE = 'config.json'

// ─── GitManager ─────────────────────────────────────────────────────────────

/**
 * GitManager - Manages git operations for team and personal repositories.
 * Uses Tauri commands to execute git CLI operations.
 */
export class GitManager {
  private static instance: GitManager
  private _gitAvailable: boolean | null = null
  private _gitVersion: string | null = null
  private _basePath: string | null = null

  private constructor() {}

  static getInstance(): GitManager {
    if (!GitManager.instance) {
      GitManager.instance = new GitManager()
    }
    return GitManager.instance
  }

  // ─── Initialization ────────────────────────────────────────────────────

  /** Get the base path for git repos: ~/.teamclaw/git/ */
  async getBasePath(): Promise<string> {
    if (this._basePath) return this._basePath
    const home = await homeDir()
    this._basePath = await join(home, TEAMCLAW_DIR, GIT_DIR)
    return this._basePath
  }

  /** Get the config file path: ~/.teamclaw/config.json */
  async getConfigPath(): Promise<string> {
    const home = await homeDir()
    return join(home, TEAMCLAW_DIR, CONFIG_FILE)
  }

  /** Get the path for a specific repo type.
   *  Personal repos: ~/.teamclaw/git/personal/<resourceType>
   *  Team repos: <workspacePath>/.teamclaw/team/<resourceType>
   */
  async getRepoPath(
    source: RepoSource,
    resourceType: RepoResourceType,
    workspacePath?: string
  ): Promise<string> {
    if (source === 'team') {
      if (!workspacePath) throw new Error('workspacePath is required for team repos')
      return join(workspacePath, TEAMCLAW_DIR, TEAM_DIR, resourceType)
    }
    const base = await this.getBasePath()
    return join(base, PERSONAL_DIR, resourceType)
  }

  // ─── Git Availability ──────────────────────────────────────────────────

  /** Check if git CLI is available on the system */
  async checkGitAvailable(): Promise<{ available: boolean; version: string | null }> {
    try {
      const result = await invoke<GitCommandResult>('git_check_available')
      this._gitAvailable = result.success
      this._gitVersion = result.success ? result.stdout : null
      return { available: result.success, version: this._gitVersion }
    } catch {
      this._gitAvailable = false
      this._gitVersion = null
      return { available: false, version: null }
    }
  }

  /** Whether git is available (cached result from last check) */
  get isGitAvailable(): boolean | null {
    return this._gitAvailable
  }

  /** Git version string (cached) */
  get gitVersion(): string | null {
    return this._gitVersion
  }

  // ─── Directory Structure ───────────────────────────────────────────────

  /** Ensure the ~/.teamclaw/git/ directory structure exists (personal repos) */
  async ensureDirectoryStructure(): Promise<void> {
    const base = await this.getBasePath()
    const dirs = [
      base,
      await join(base, PERSONAL_DIR),
      await join(base, PERSONAL_DIR, 'skills'),
      await join(base, PERSONAL_DIR, 'documents'),
    ]
    for (const dir of dirs) {
      if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true })
      }
    }
  }

  // ─── Git Operations ────────────────────────────────────────────────────

  /** Clone a git repository */
  async clone(url: string, localPath: string, shallow = true): Promise<GitCommandResult> {
    return invoke<GitCommandResult>('git_clone', { url, path: localPath, shallow })
  }

  /** Pull latest changes from remote (fast-forward only) */
  async pull(localPath: string): Promise<GitCommandResult> {
    return invoke<GitCommandResult>('git_pull', { path: localPath })
  }

  /** Push local commits to remote */
  async push(localPath: string, remote?: string, branch?: string): Promise<GitCommandResult> {
    return invoke<GitCommandResult>('git_push', { path: localPath, remote, branch })
  }

  /** Stage files and commit */
  async commit(localPath: string, message: string): Promise<GitCommandResult> {
    return invoke<GitCommandResult>('git_commit', { path: localPath, message })
  }

  /** Stage files for commit */
  async add(localPath: string, files?: string[], all?: boolean): Promise<GitCommandResult> {
    return invoke<GitCommandResult>('git_add', { path: localPath, files, all })
  }

  /** Get structured git status */
  async status(localPath: string): Promise<GitStatusResult> {
    return invoke<GitStatusResult>('git_status', { path: localPath })
  }

  /** Get diff output */
  async diff(localPath: string, file?: string, staged?: boolean): Promise<GitCommandResult> {
    return invoke<GitCommandResult>('git_diff', { path: localPath, file, staged })
  }

  /**
   * Get file content from a git ref (default: HEAD).
   * Used for git gutter: compare working-tree vs last commit.
   * Returns null if the file doesn't exist at that ref (new/untracked file).
   */
  async showFile(localPath: string, file: string, gitRef?: string): Promise<string | null> {
    try {
      const result = await invoke<GitCommandResult>('git_show_file', {
        path: localPath,
        file,
        gitRef: gitRef ?? 'HEAD',
      })
      if (result.success) {
        return result.stdout
      }
      return null
    } catch {
      // File doesn't exist at this ref (new file) or not a git repo
      return null
    }
  }

  /**
   * Read commit history for a single file (paginated).
   * Returns entries newest-first. Empty array means "no commits touched this file".
   */
  async logFile(
    localPath: string,
    file: string,
    limit: number,
    skip: number,
  ): Promise<GitLogEntry[]> {
    return invoke<GitLogEntry[]>('git_log_file', {
      path: localPath,
      file,
      limit,
      skip,
    })
  }

  // ─── Repository Management ─────────────────────────────────────────────

  /** Clone a repo if not already cloned, or pull if already exists */
  async cloneOrPull(url: string, localPath: string): Promise<{ action: 'cloned' | 'pulled' | 'skipped'; result: GitCommandResult | null }> {
    const pathExists = await exists(localPath)

    if (pathExists) {
      // Check if it's a git repo
      try {
        const statusResult = await this.status(localPath)
        if (statusResult.branch !== null) {
          // Already a git repo, pull
          const result = await this.pull(localPath)
          return { action: 'pulled', result }
        }
      } catch {
        // Not a git repo, skip to avoid overwriting
        return { action: 'skipped', result: null }
      }
    }

    // Clone (create parent only when needed; avoids empty .teamclaw/team/ when unused)
    const parent = await dirname(localPath)
    if (!(await exists(parent))) {
      await mkdir(parent, { recursive: true })
    }
    const result = await this.clone(url, localPath, true)
    return { action: 'cloned', result }
  }

  /** Commit all changes and push */
  async commitAndPush(localPath: string, message: string): Promise<GitCommandResult> {
    await this.add(localPath, undefined, true)
    await this.commit(localPath, message)
    return this.push(localPath)
  }

  // ─── Config Management ─────────────────────────────────────────────────

  /** Load git repo config from ~/.teamclaw/config.json */
  async loadConfig(): Promise<GitRepoConfig> {
    try {
      const configPath = await this.getConfigPath()
      if (!(await exists(configPath))) {
        return {}
      }
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      const content = await readTextFile(configPath)
      const config = JSON.parse(content)
      return config.git || {}
    } catch {
      return {}
    }
  }

  /** Save git repo config to ~/.teamclaw/config.json */
  async saveConfig(gitConfig: GitRepoConfig): Promise<void> {
    const configPath = await this.getConfigPath()

    // Load existing config or create new
    let fullConfig: Record<string, unknown> = {}
    try {
      if (await exists(configPath)) {
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        const content = await readTextFile(configPath)
        fullConfig = JSON.parse(content)
      }
    } catch {
      // Start fresh if read fails
    }

    fullConfig.git = gitConfig

    // Ensure parent dir exists
    const home = await homeDir()
    const teamclawDir = await join(home, TEAMCLAW_DIR)
    if (!(await exists(teamclawDir))) {
      await mkdir(teamclawDir, { recursive: true })
    }

    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(configPath, JSON.stringify(fullConfig, null, 2))
  }

  // ─── Repo List Builder ─────────────────────────────────────────────────

  /** Build the list of managed repos from config */
  async buildRepoList(workspacePath?: string): Promise<GitRepo[]> {
    const config = await this.loadConfig()
    const repos: GitRepo[] = []

    // Personal skills
    if (config.personalSkillsUrl) {
      const localPath = await this.getRepoPath('personal', 'skills')
      repos.push({
        id: 'personal/skills',
        url: config.personalSkillsUrl,
        localPath,
        source: 'personal',
        resourceType: 'skills',
        syncStatus: 'idle',
        isCloned: await exists(localPath),
      })
    }

    // Personal documents
    if (config.personalDocumentsUrl) {
      const localPath = await this.getRepoPath('personal', 'documents')
      repos.push({
        id: 'personal/documents',
        url: config.personalDocumentsUrl,
        localPath,
        source: 'personal',
        resourceType: 'documents',
        syncStatus: 'idle',
        isCloned: await exists(localPath),
      })
    }

    // Team repos (stored under <workspace>/.teamclaw/team/)
    if (config.team && workspacePath) {
      if (config.team.skillsUrl) {
        const localPath = await this.getRepoPath('team', 'skills', workspacePath)
        repos.push({
          id: 'team/skills',
          url: config.team.skillsUrl,
          localPath,
          source: 'team',
          resourceType: 'skills',
          syncStatus: 'idle',
          isCloned: await exists(localPath),
        })
      }
      if (config.team.documentsUrl) {
        const localPath = await this.getRepoPath('team', 'documents', workspacePath)
        repos.push({
          id: 'team/documents',
          url: config.team.documentsUrl,
          localPath,
          source: 'team',
          resourceType: 'documents',
          syncStatus: 'idle',
          isCloned: await exists(localPath),
        })
      }
    }

    return repos
  }

  // ─── Sync All ──────────────────────────────────────────────────────────

  /** Sync all configured repos (clone if missing, pull if exists) */
  async syncAll(
    workspacePath?: string,
    onProgress?: (repoId: string, status: 'syncing' | 'synced' | 'error', error?: string) => void
  ): Promise<void> {
    await this.ensureDirectoryStructure()

    const repos = await this.buildRepoList(workspacePath)
    for (const repo of repos) {
      try {
        onProgress?.(repo.id, 'syncing')
        await this.cloneOrPull(repo.url, repo.localPath)
        onProgress?.(repo.id, 'synced')
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        console.error(`[GitManager] Failed to sync ${repo.id}:`, errMsg)
        onProgress?.(repo.id, 'error', errMsg)
      }
    }
  }
}

// Export singleton
export const gitManager = GitManager.getInstance()
