import { create } from 'zustand'
import { useWorkspaceStore } from '@/stores/workspace'
import { useEnvVarsStore, type TeamEnvListing } from '@/stores/env-vars'
import { loadAllSkills, getSourceLabel } from '@/lib/git/skill-loader'
import type { SkillSource } from '@/lib/git/types'
import { resolveTeamDir } from '@/lib/team-skill-paths'
import { frontmatterString } from '@/lib/skills/frontmatter'
import { invoke } from '@tauri-apps/api/core'
import { getBackend } from '@/lib/backend/provider'
import { getFreshAccessToken } from '@/lib/auth/session-store'
import { ensureAgentsSkillsPaths } from '@/lib/skills/ensure-agents-paths'
import { useCurrentTeamStore } from '@/stores/current-team'
import type {
  TeamSkill,
  TeamSkillCategory,
  TeamSkillStatus,
} from '@/lib/backend/cloud-api/team-skills'
import {
  encodeWorkspaceId,
  getDaemonMcp,
  getDaemonMcpTools,
  type DaemonMcpServerConfig,
  type DaemonMcpServerProbeResult,
} from '@/lib/daemon-local-client'

/** The four browsable team-shared content kinds. */
export type TeamShareSection = 'skills' | 'mcp' | 'env' | 'knowledge'

export const TEAM_SHARE_SECTIONS: TeamShareSection[] = ['skills', 'mcp', 'env', 'knowledge']

export type TeamSkillKind = 'team-available' | 'team-installed' | 'personal'

/**
 * A row in the unified skills list.
 *
 * - `team-available` / `team-installed` — Cloud API registry
 * - `personal` — skill-loader union (opencode / claude / agents / …), excluding
 *   slugs already owned by the registry
 */
export interface TeamSkillItem {
  /** Directory name / slug (used as the daemon skill id). */
  slug: string
  name: string
  invocationName: string
  category: string | null
  content: string
  dirPath: string
  filename: string
  origin: 'registry' | 'legacy' | 'personal'
  kind: TeamSkillKind
  /** skill-loader source for personal rows (for meta badge). */
  personalSource: SkillSource | null
  personalSourceLabel: string | null
  summary: string | null
  whenToUse: string | null
  whenNotToUse: string | null
  requires: string[] | null
  status: TeamSkillStatus | null
  supersededBy: string | null
  ownerActorId: string | null
  latestVersion: number | null
  installed: boolean
  installedVersion: number | null
  hasUpdate: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface TeamMcpItem {
  name: string
  config: DaemonMcpServerConfig
  probeStatus: DaemonMcpServerProbeResult['probe_status'] | 'unknown'
  tools: string[]
  error: string | null
}

export interface TeamKnowledgeItem {
  path: string
  relPath: string
  name: string
}

export interface TeamSkillShareInput {
  slug: string
  summary: string
  category: TeamSkillCategory
  whenToUse: string
  whenNotToUse: string
  changelog: string
  requires?: string[] | null
}

type SectionState<T> = {
  items: T[]
  loading: boolean
  loaded: boolean
  error: string | null
}

const emptySection = <T>(): SectionState<T> => ({ items: [], loading: false, loaded: false, error: null })

interface TeamShareBrowserState {
  skills: SectionState<TeamSkillItem>
  mcp: SectionState<TeamMcpItem>
  knowledge: SectionState<TeamKnowledgeItem>
  envCount: number
  selectedId: Record<TeamShareSection, string | null>
  subjectActorId: string | null

  counts: () => Record<TeamShareSection, number>
  select: (section: TeamShareSection, id: string | null) => void
  setSubjectActor: (actorId: string | null) => Promise<void>
  installSkill: (slug: string) => Promise<void>
  uninstallSkill: (slug: string) => Promise<void>
  /** Copy-publish a personal skill to the team registry, then auto-install. */
  sharePersonalSkill: (slug: string, input: TeamSkillShareInput) => Promise<void>
  loadSection: (section: TeamShareSection, opts?: { force?: boolean; withTools?: boolean }) => Promise<void>
  loadMcpTools: (opts?: { refresh?: boolean }) => Promise<void>
  loadCounts: () => Promise<void>
}

function workspacePath(): string | null {
  return useWorkspaceStore.getState().workspacePath
}

function currentTeamId(): string | null {
  return useCurrentTeamStore.getState().team?.id ?? null
}

function frontmatterValue(content: string, key: string): string | null {
  return frontmatterString(content, key) ?? null
}

const KNOWLEDGE_EXTS = new Set(['md', 'mdx', 'markdown', 'txt'])

async function listTeamKnowledge(wsPath: string): Promise<TeamKnowledgeItem[]> {
  const teamDir = await resolveTeamDir(wsPath)
  if (!teamDir) return []
  const knowledgeDir = `${teamDir}/knowledge`
  const { exists, readDir } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(knowledgeDir))) return []

  const out: TeamKnowledgeItem[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readDir(dir)
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childPath = `${dir}/${entry.name}`
      if (entry.isDirectory) {
        await walk(childPath, childRel)
      } else {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
        if (KNOWLEDGE_EXTS.has(ext)) {
          out.push({ path: childPath, relPath: childRel, name: entry.name })
        }
      }
    }
  }
  await walk(knowledgeDir, '')
  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return out
}

type OnDisk = { content: string; dirPath: string; invocationName: string; source: SkillSource }

function registryItem(
  skill: TeamSkill,
  onDisk: Map<string, OnDisk>,
  kind: 'team-available' | 'team-installed',
): TeamSkillItem {
  const local = onDisk.get(skill.slug)
  return {
    slug: skill.slug,
    name: skill.slug,
    invocationName: local?.invocationName ?? skill.slug,
    category: skill.category,
    content: local?.content ?? '',
    dirPath: local?.dirPath ?? '',
    filename: skill.slug,
    origin: 'registry',
    kind,
    personalSource: null,
    personalSourceLabel: null,
    summary: skill.summary,
    whenToUse: skill.whenToUse,
    whenNotToUse: skill.whenNotToUse,
    requires: skill.requires,
    status: skill.status,
    supersededBy: skill.supersededBy,
    ownerActorId: skill.ownerActorId,
    latestVersion: skill.latestVersion,
    installed: skill.installed,
    installedVersion: skill.installedVersion,
    hasUpdate: skill.hasUpdate,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

function personalItem(s: {
  filename: string
  name: string
  invocationName: string
  content: string
  dirPath: string
  source: SkillSource
}): TeamSkillItem {
  return {
    slug: s.filename,
    name: s.name,
    invocationName: s.invocationName,
    category: frontmatterValue(s.content, 'category'),
    content: s.content,
    dirPath: s.dirPath,
    filename: s.filename,
    origin: 'personal',
    kind: 'personal',
    personalSource: s.source,
    personalSourceLabel: getSourceLabel(s.source),
    summary: frontmatterValue(s.content, 'description'),
    whenToUse: frontmatterValue(s.content, 'when_to_use'),
    whenNotToUse: frontmatterValue(s.content, 'when_not_to_use'),
    requires: null,
    status: null,
    supersededBy: null,
    ownerActorId: null,
    latestVersion: null,
    installed: false,
    installedVersion: null,
    hasUpdate: false,
    createdAt: null,
    updatedAt: null,
  }
}

/**
 * Three buckets:
 * 1. registry installed → team-installed
 * 2. registry not installed → team-available (hides personal twin)
 * 3. skill-loader rows whose slug is not in the registry → personal
 *
 * Legacy wholesale `source: team` dirs are only kept as personal when the
 * registry does not already own that slug (migration period).
 */
async function listTeamSkills(
  wsPath: string | null,
  teamId: string | null,
  actorId?: string,
): Promise<{ items: TeamSkillItem[]; registryError: string | null }> {
  const { skills } = await loadAllSkills(wsPath)
  const onDisk = new Map<string, OnDisk>()
  for (const s of skills) {
    // First wins per skill-loader priority order already applied in loadAllSkills.
    if (!onDisk.has(s.filename)) {
      onDisk.set(s.filename, {
        content: s.content,
        dirPath: s.dirPath,
        invocationName: s.invocationName,
        source: s.source,
      })
    }
  }

  let registry: TeamSkill[] = []
  let registryError: string | null = null
  if (teamId) {
    try {
      registry = await getBackend().teamSkills.listTeamSkills(teamId, actorId ? { actorId } : {})
    } catch (e) {
      registryError = e instanceof Error ? e.message : String(e)
    }
  }

  const registrySlugs = new Set(registry.map((s) => s.slug))
  const available: TeamSkillItem[] = []
  const installed: TeamSkillItem[] = []
  for (const s of registry) {
    if (s.installed) installed.push(registryItem(s, onDisk, 'team-installed'))
    else available.push(registryItem(s, onDisk, 'team-available'))
  }

  const personal: TeamSkillItem[] = []
  for (const s of skills) {
    if (registrySlugs.has(s.filename)) continue
    // Builtin / clawhub market copies are not "my personal skills".
    if (s.source === 'builtin' || s.source === 'clawhub') continue
    personal.push(
      personalItem({
        filename: s.filename,
        name: s.name,
        invocationName: s.invocationName,
        content: s.content,
        dirPath: s.dirPath,
        source: s.source,
      }),
    )
  }

  available.sort((a, b) => a.slug.localeCompare(b.slug))
  installed.sort((a, b) => a.slug.localeCompare(b.slug))
  personal.sort((a, b) => a.slug.localeCompare(b.slug))

  return { items: [...available, ...installed, ...personal], registryError }
}

async function listTeamMcp(wsPath: string): Promise<TeamMcpItem[]> {
  const wid = encodeWorkspaceId(wsPath)
  const config = await getDaemonMcp(wid)
  return Object.entries(config)
    .filter(([, cfg]) => cfg.source === 'team')
    .map(([name, cfg]) => ({
      name,
      config: cfg,
      probeStatus: 'unknown' as const,
      tools: [],
      error: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export const useTeamShareBrowserStore = create<TeamShareBrowserState>((set, get) => ({
  skills: emptySection<TeamSkillItem>(),
  mcp: emptySection<TeamMcpItem>(),
  knowledge: emptySection<TeamKnowledgeItem>(),
  envCount: 0,
  selectedId: { skills: null, mcp: null, env: null, knowledge: null },
  subjectActorId: null,

  counts: () => {
    const s = get()
    return {
      skills: s.skills.items.length,
      mcp: s.mcp.items.length,
      env: s.envCount,
      knowledge: s.knowledge.items.length,
    }
  },

  select: (section, id) => set((s) => ({ selectedId: { ...s.selectedId, [section]: id } })),

  setSubjectActor: async (actorId) => {
    set({ subjectActorId: actorId })
    await get().loadSection('skills', { force: true })
  },

  installSkill: async (slug) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const wsPath = workspacePath()
    const subjectActorId = get().subjectActorId

    const skill = get().skills.items.find((s) => s.slug === slug)
    if (!skill || skill.origin !== 'registry') {
      throw new Error(`${slug} is not a registry skill`)
    }
    const version = skill.latestVersion ?? 1
    const backend = getBackend()

    if (!subjectActorId) {
      const detail = await backend.teamSkills.getTeamSkill(teamId, slug)
      const { url } = await backend.teamSkills.resolveDownload(teamId, slug, version)
      await invoke('team_skill_install', {
        request: {
          workspacePath: wsPath,
          slug,
          downloadUrl: url,
          accessToken: await getFreshAccessToken().catch(() => null),
          version,
          owner: detail.ownerActorId,
          category: detail.category,
          summary: detail.summary,
          whenToUse: detail.whenToUse,
          whenNotToUse: detail.whenNotToUse,
          requires: detail.requires,
          isGlobal: true,
        },
      })
      await ensureAgentsSkillsPaths(wsPath)
    }

    await backend.teamSkills.installTeamSkill(teamId, slug, {
      ...(subjectActorId ? { actorId: subjectActorId } : {}),
      version,
    })
    await get().loadSection('skills', { force: true })
  },

  uninstallSkill: async (slug) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const subjectActorId = get().subjectActorId
    const wsPath = workspacePath()

    if (!subjectActorId) {
      await invoke('team_skill_uninstall', {
        workspacePath: wsPath,
        slug,
        isGlobal: true,
      })
    }
    await getBackend().teamSkills.uninstallTeamSkill(teamId, slug, {
      ...(subjectActorId ? { actorId: subjectActorId } : {}),
    })
    await get().loadSection('skills', { force: true })
  },

  sharePersonalSkill: async (slug, input) => {
    const teamId = currentTeamId()
    if (!teamId) throw new Error('no current team')
    const wsPath = workspacePath()
    const skill = get().skills.items.find((s) => s.slug === slug)
    if (!skill || skill.kind !== 'personal') {
      throw new Error(`${slug} is not a personal skill`)
    }
    if (!skill.dirPath || !skill.filename) {
      throw new Error('personal skill has no directory on disk')
    }
    // skill-loader stores parent dir in dirPath and folder name in filename.
    const sourceDir = `${skill.dirPath}/${skill.filename}`

    const { getEffectiveServerConfig } = await import('@/lib/server-config')
    const { cloudApiUrl } = await getEffectiveServerConfig()
    if (!cloudApiUrl) throw new Error('Cloud API URL is not configured')
    const accessToken = await getFreshAccessToken()
    if (!accessToken) throw new Error('Not signed in')

    const packed = await invoke<{ contentHash: string; size: number }>('team_skill_pack_and_upload', {
      dirPath: sourceDir,
      slug: input.slug,
      teamId,
      cloudApiUrl,
      accessToken,
    })

    const backend = getBackend()
    await backend.teamSkills.publishTeamSkill(teamId, {
      slug: input.slug,
      summary: input.summary,
      category: input.category,
      whenToUse: input.whenToUse,
      whenNotToUse: input.whenNotToUse,
      changelog: input.changelog,
      contentHash: packed.contentHash,
      size: packed.size,
      requires: input.requires ?? null,
    })

    // Copy-publish: keep the personal dir; materialise the team install under
    // ~/.agents/skills so OpenCode / Claude / Pi all see the same pack.
    await invoke('team_skill_install_from_dir', {
      request: {
        workspacePath: wsPath,
        slug: input.slug,
        sourceDir,
        version: 1,
        category: input.category,
        summary: input.summary,
        whenToUse: input.whenToUse,
        whenNotToUse: input.whenNotToUse,
        requires: input.requires ?? null,
        isGlobal: true,
      },
    })
    await ensureAgentsSkillsPaths(wsPath)

    await backend.teamSkills.installTeamSkill(teamId, input.slug, { version: 1 })
    await get().loadSection('skills', { force: true })
    get().select('skills', input.slug)
  },

  loadSection: async (section, opts) => {
    const wsPath = workspacePath()

    if (section === 'env') {
      try {
        await useEnvVarsStore.getState().loadEnvCatalog()
      } catch {
        /* surfaced by env store */
      }
      set({ envCount: useEnvVarsStore.getState().teamSecrets.length })
      return
    }

    const current = get()[section] as SectionState<unknown>
    if (current.loaded && !opts?.force) {
      if (section === 'mcp' && opts?.withTools) await get().loadMcpTools()
      return
    }

    set(
      (s) =>
        ({ [section]: { ...s[section], loading: true, error: null } }) as Partial<TeamShareBrowserState>,
    )
    try {
      if (section === 'skills') {
        const { items, registryError } = await listTeamSkills(
          wsPath,
          currentTeamId(),
          get().subjectActorId ?? undefined,
        )
        set({ skills: { items, loading: false, loaded: true, error: registryError } })
      } else if (section === 'knowledge') {
        const items = wsPath ? await listTeamKnowledge(wsPath) : []
        set({ knowledge: { items, loading: false, loaded: true, error: null } })
      } else if (section === 'mcp') {
        const items = wsPath ? await listTeamMcp(wsPath) : []
        set({ mcp: { items, loading: false, loaded: true, error: null } })
        if (opts?.withTools) await get().loadMcpTools()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set(
        (s) =>
          ({
            [section]: { ...s[section], loading: false, loaded: true, error: msg },
          }) as Partial<TeamShareBrowserState>,
      )
    }
  },

  loadMcpTools: async (opts) => {
    const wsPath = workspacePath()
    if (!wsPath) return
    try {
      const probes = await getDaemonMcpTools(encodeWorkspaceId(wsPath), opts)
      set((s) => ({
        mcp: {
          ...s.mcp,
          items: s.mcp.items.map((it) => {
            const p = probes[it.name]
            return p
              ? { ...it, probeStatus: p.probe_status, tools: p.tools, error: p.error }
              : it
          }),
        },
      }))
    } catch {
      /* leave probeStatus 'unknown' */
    }
  },

  loadCounts: async () => {
    await Promise.allSettled([
      get().loadSection('skills', { force: true }),
      get().loadSection('mcp', { force: true }),
      get().loadSection('env'),
      get().loadSection('knowledge', { force: true }),
    ])
  },
}))

export type { TeamEnvListing }
