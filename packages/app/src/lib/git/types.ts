// ─── Git Command Result Types ──────────────────────────────────────────────

/** Raw result from a git command execution via Tauri */
export interface GitCommandResult {
  success: boolean
  stdout: string
  stderr: string
}

/** Structured file status entry from git status */
export interface GitFileStatusEntry {
  path: string
  status: string
  staged: boolean
}

/** Structured git status response */
export interface GitStatusResult {
  branch: string | null
  files: GitFileStatusEntry[]
  clean: boolean
}

// ─── Repository Types ──────────────────────────────────────────────────────

/** Source type of a git-managed repository */
export type RepoSource = 'team' | 'personal'

/** Resource type managed by the repository */
export type RepoResourceType = 'skills' | 'documents'

/** Sync status of a repository */
export type RepoSyncStatus = 'idle' | 'syncing' | 'synced' | 'error'

/** Represents a managed git repository */
export interface GitRepo {
  /** Unique identifier: `${source}/${resourceType}` */
  id: string
  /** Remote URL (HTTPS or SSH) */
  url: string
  /** Local path where the repo is cloned */
  localPath: string
  /** Source: team or personal */
  source: RepoSource
  /** Resource type: skills or documents */
  resourceType: RepoResourceType
  /** Current sync status */
  syncStatus: RepoSyncStatus
  /** Last sync timestamp (ISO string) */
  lastSyncAt?: string
  /** Last error message if syncStatus is 'error' */
  lastError?: string
  /** Whether the repo has been cloned locally */
  isCloned: boolean
}

// ─── Configuration Types ───────────────────────────────────────────────────

/** Git repository configuration stored in user config */
export interface GitRepoConfig {
  /** Personal skills repo URL */
  personalSkillsUrl?: string
  /** Personal documents repo URL */
  personalDocumentsUrl?: string
  /** Team repo configuration (one team per workspace) */
  team?: TeamGitConfig
}

/** Git config for team repos */
export interface TeamGitConfig {
  /** Team skills repo URL */
  skillsUrl?: string
  /** Team documents repo URL */
  documentsUrl?: string
}

// ─── P2P Team Sync Types ──────────────────────────────────────────────────

/** Sync status of a P2P connection */
export type P2pSyncStatus = 'idle' | 'syncing' | 'synced' | 'error'

/** Runtime array of all P2P sync statuses */
export const P2P_SYNC_STATUSES: P2pSyncStatus[] = ['idle', 'syncing', 'synced', 'error']

/** A single P2P ticket entry (a source to sync from) */
export interface P2pTicketEntry {
  /** iroh blob ticket string */
  ticket: string
  /** Human-readable label for this source */
  label: string
  /** ISO timestamp when the ticket was added */
  addedAt: string
}

/** A team member in the allowlist */
export interface TeamMember {
  /** Iroh NodeId (Ed25519 public key) */
  nodeId: string
  /** Human-readable display name (e.g. "Alice", "Bob") */
  name: string
  /** Member role: owner, manager, editor, or viewer */
  role?: 'owner' | 'manager' | 'editor' | 'viewer'
  /** Human-readable label */
  label: string
  /** OS name */
  platform: string
  /** CPU architecture */
  arch: string
  /** Device hostname */
  hostname: string
  /** ISO timestamp when added */
  addedAt: string
}

/** Type guard for TeamMember */
export function isTeamMember(obj: unknown): obj is TeamMember {
  if (obj == null || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    typeof o.nodeId === 'string' &&
    typeof o.label === 'string' &&
    typeof o.platform === 'string' &&
    typeof o.arch === 'string' &&
    typeof o.hostname === 'string' &&
    typeof o.addedAt === 'string'
  )
}

/** Device info returned by get_device_info Tauri command */
export interface DeviceInfo {
  nodeId: string
  platform: string
  arch: string
  hostname: string
}

/** P2P configuration stored in teamclaw.json */
export interface P2pConfig {
  /** Whether P2P sync is enabled */
  enabled: boolean
  /** List of P2P ticket sources */
  tickets: P2pTicketEntry[]
  /** Whether this workspace publishes its team drive */
  publishEnabled: boolean
  /** ISO timestamp of last successful sync, or null */
  lastSyncAt: string | null
  /** NodeId of the team owner */
  ownerNodeId?: string
  /** List of authorized team members */
  allowedMembers?: TeamMember[]
}

/** Type guard for P2pConfig */
export function isP2pConfig(obj: unknown): obj is P2pConfig {
  if (obj == null || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    typeof o.enabled === 'boolean' &&
    Array.isArray(o.tickets) &&
    typeof o.publishEnabled === 'boolean' &&
    (o.lastSyncAt === null || typeof o.lastSyncAt === 'string')
  )
}

// ─── Skill Source Types ────────────────────────────────────────────────────

/** Source badge for a loaded skill */
export type SkillSource = 
  | 'local' 
  | 'claude' 
  | 'clawhub' 
  | 'shared' 
  | 'personal' 
  | 'team' 
  | 'builtin'
  | 'global-opencode'
  | 'global-claude'
  | 'global-agent'

/** Skill directory names that TeamClaw auto-provisions as inherent (cannot be deleted) */
export const INHERENT_SKILL_NAMES = new Set([
  'macos-control',
  'windows-control',
])

const DESKTOP_CONTROL_INHERENT_SLUGS = new Set(['macos-control', 'windows-control'])

/** Host OS–matched built-in desktop automation skill, or null on Linux / unknown. */
export function getActiveDesktopControlSkillSlug(): 'macos-control' | 'windows-control' | null {
  if (typeof navigator === 'undefined') return null
  const platform = (navigator.platform ?? '').toLowerCase()
  const ua = (navigator.userAgent ?? '').toLowerCase()
  if (platform.includes('mac') || platform.includes('darwin') || ua.includes('mac os')) {
    return 'macos-control'
  }
  if (platform.includes('win') || ua.includes('windows')) {
    return 'windows-control'
  }
  return null
}

/** Hide the non-native desktop control inherent skill in UI / merged lists (OpenCode dir is cleaned in Rust). */
export function shouldIncludeDesktopControlSkill(filename: string): boolean {
  if (!DESKTOP_CONTROL_INHERENT_SLUGS.has(filename)) return true
  const active = getActiveDesktopControlSkillSlug()
  return active !== null && filename === active
}

/** Extended skill info with source tracking */
export interface SkillWithSource {
  filename: string
  name: string
  content: string
  source: SkillSource
  /** Absolute path to the directory containing this skill's folder */
  dirPath: string
  /** Whether this is a global skill (from user home directory) */
  isGlobal?: boolean
}

// --- WebDAV Team Sync Types ---

export interface WebDavConfig {
  url: string
  authType: 'basic' | 'bearer'
  username?: string
  syncIntervalSecs: number
  enabled: boolean
  lastSyncAt: string | null
  allowInsecure: boolean
}

export interface WebDavSyncStatus {
  connected: boolean
  syncing: boolean
  lastSyncAt: string | null
  fileCount: number
  error: string | null
}

export interface WebDavSyncResult {
  filesAdded: number
  filesUpdated: number
  filesDeleted: number
}

export type TeamSyncMode = 'git' | 'p2p' | 'webdav' | 'oss' | null

// Unified team management types
export interface TeamCreateResult {
  teamId: string | null
  ticket: string
}

export interface TeamJoinResult {
  success: boolean
  role: 'owner' | 'manager' | 'editor' | 'viewer'
  members: TeamMember[]
}

export type TeamJoinErrorType =
  | 'InvalidTicket'
  | 'DeviceNotRegistered'
  | 'AlreadyInTeam'
  | 'SyncError'
