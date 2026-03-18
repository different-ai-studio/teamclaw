// ─── ClawHub API Response Types ──────────────────────────────────────────────
// Mirror the Rust serde types returned by Tauri commands.

export interface ClawHubSearchResultEntry {
  score: number
  slug?: string
  displayName?: string
  summary?: string | null
  version?: string | null
  updatedAt?: number
}

export interface ClawHubSearchResults {
  results: ClawHubSearchResultEntry[]
}

export interface ClawHubSkillVersionInfo {
  version: string
  createdAt?: number
  changelog: string
}

export interface ClawHubSkillOwner {
  handle: string | null
  displayName?: string | null
  image?: string | null
}

export interface ClawHubSkillModeration {
  isSuspicious: boolean
  isMalwareBlocked: boolean
}

export interface ClawHubSkillInfo {
  slug: string
  displayName: string
  tags: unknown
  stats: unknown
  createdAt: number
  updatedAt: number
  summary?: string | null
}

export interface ClawHubSkillDetail {
  skill: ClawHubSkillInfo | null
  latestVersion: ClawHubSkillVersionInfo | null
  owner: ClawHubSkillOwner | null
  moderation: ClawHubSkillModeration | null
}

export interface ClawHubSkillListItem {
  slug: string
  displayName: string
  tags: unknown
  stats: unknown
  createdAt: number
  updatedAt: number
  summary?: string | null
  latestVersion?: ClawHubSkillVersionInfo
}

export interface ClawHubExploreResults {
  items: ClawHubSkillListItem[]
  nextCursor: string | null
}

export interface ClawHubUpdateInfo {
  slug: string
  currentVersion: string | null
  latestVersion: string | null
  hasUpdate: boolean
}

// ─── Lockfile Types ──────────────────────────────────────────────────────────

export interface ClawHubLockfileEntry {
  version: string | null
  installedAt: number
}

export interface ClawHubLockfile {
  version: number
  skills: Record<string, ClawHubLockfileEntry>
}

// ─── Stats helper (stats field is untyped from API) ──────────────────────────

export interface ClawHubStats {
  stars?: number
  downloads?: number
  installsCurrent?: number
  installsAllTime?: number
}

export function parseStats(stats: unknown): ClawHubStats {
  if (!stats || typeof stats !== "object") return {}
  const s = stats as Record<string, unknown>
  return {
    stars: typeof s.stars === "number" ? s.stars : undefined,
    downloads: typeof s.downloads === "number" ? s.downloads : undefined,
    installsCurrent: typeof s.installsCurrent === "number" ? s.installsCurrent : undefined,
    installsAllTime: typeof s.installsAllTime === "number" ? s.installsAllTime : undefined,
  }
}
