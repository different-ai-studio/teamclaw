import { create } from 'zustand'
import { useWorkspaceStore } from '@/stores/workspace'
import { useEnvVarsStore, type TeamEnvListing } from '@/stores/env-vars'
import { loadAllSkills } from '@/lib/git/skill-loader'
import { resolveTeamDir } from '@/lib/team-skill-paths'
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

export interface TeamSkillItem {
  /** Directory name / slug (used as the daemon skill id). */
  slug: string
  name: string
  invocationName: string
  /** Parsed frontmatter category, when present. */
  category: string | null
  content: string
  dirPath: string
  filename: string
}

export interface TeamMcpItem {
  name: string
  config: DaemonMcpServerConfig
  probeStatus: DaemonMcpServerProbeResult['probe_status'] | 'unknown'
  tools: string[]
  error: string | null
}

export interface TeamKnowledgeItem {
  /** Absolute path on disk (acts as the id). */
  path: string
  /** Path relative to teamclaw-team/knowledge. */
  relPath: string
  name: string
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
  /** Team env count mirrors useEnvVarsStore.teamSecrets; tracked here for the nav badge. */
  envCount: number
  selectedId: Record<TeamShareSection, string | null>

  counts: () => Record<TeamShareSection, number>
  select: (section: TeamShareSection, id: string | null) => void
  /** Load (or reload) the list for a section. mcp skips the slow tool probe unless `withTools`. */
  loadSection: (section: TeamShareSection, opts?: { force?: boolean; withTools?: boolean }) => Promise<void>
  /** Probe MCP tools/status (slower) and merge into the existing list. */
  loadMcpTools: (opts?: { refresh?: boolean }) => Promise<void>
  /** Load every section's list for the nav counts (mcp without probing tools). */
  loadCounts: () => Promise<void>
}

function workspacePath(): string | null {
  return useWorkspaceStore.getState().workspacePath
}

/** Minimal YAML frontmatter scan for a single top-level scalar key. */
function frontmatterValue(content: string, key: string): string | null {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  if (!fm) return null
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm')
  const m = re.exec(fm[1])
  if (!m) return null
  return m[1].trim().replace(/^['"]|['"]$/g, '') || null
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

async function listTeamSkills(wsPath: string | null): Promise<TeamSkillItem[]> {
  const { skills } = await loadAllSkills(wsPath)
  return skills
    .filter((s) => s.source === 'team')
    .map((s) => ({
      slug: s.filename,
      name: s.name,
      invocationName: s.invocationName,
      category: frontmatterValue(s.content, 'category'),
      content: s.content,
      dirPath: s.dirPath,
      filename: s.filename,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function listTeamMcp(wsPath: string): Promise<TeamMcpItem[]> {
  const wid = encodeWorkspaceId(wsPath)
  const config = await getDaemonMcp(wid)
  return Object.entries(config)
    .filter(([, cfg]) => cfg.source === 'team')
    .map(([name, cfg]) => ({ name, config: cfg, probeStatus: 'unknown' as const, tools: [], error: null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export const useTeamShareBrowserStore = create<TeamShareBrowserState>((set, get) => ({
  skills: emptySection<TeamSkillItem>(),
  mcp: emptySection<TeamMcpItem>(),
  knowledge: emptySection<TeamKnowledgeItem>(),
  envCount: 0,
  selectedId: { skills: null, mcp: null, env: null, knowledge: null },

  counts: () => {
    const s = get()
    return {
      skills: s.skills.items.length,
      mcp: s.mcp.items.length,
      env: s.envCount,
      knowledge: s.knowledge.items.length,
    }
  },

  select: (section, id) =>
    set((s) => ({ selectedId: { ...s.selectedId, [section]: id } })),

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

    set((s) => ({ [section]: { ...s[section], loading: true, error: null } }) as Partial<TeamShareBrowserState>)
    try {
      if (section === 'skills') {
        const items = await listTeamSkills(wsPath)
        set({ skills: { items, loading: false, loaded: true, error: null } })
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
      set((s) => ({ [section]: { ...s[section], loading: false, loaded: true, error: msg } }) as Partial<TeamShareBrowserState>)
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
      get().loadSection('skills'),
      get().loadSection('mcp'),
      get().loadSection('env'),
      get().loadSection('knowledge'),
    ])
  },
}))

export type { TeamEnvListing }
