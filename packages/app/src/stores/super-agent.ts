import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

// Types must match Rust backend's SuperAgentSnapshot exactly
export type AgentStatus = 'online' | 'offline' | 'busy' | 'unknown'

export interface Capability {
  name: string
  description: string
}

export interface AgentProfile {
  agentId: string
  name: string
  status: AgentStatus
  capabilities: Capability[]
  domain: string | null
}

export interface SuperAgentSnapshot {
  localAgent: AgentProfile | null
  agents: AgentProfile[]
  connected: boolean
}

const DEFAULT_SNAPSHOT: SuperAgentSnapshot = {
  localAgent: null,
  agents: [],
  connected: false,
}

export function isSuperAgentSnapshot(value: unknown): value is SuperAgentSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SuperAgentSnapshot>
  return Array.isArray(candidate.agents) && typeof candidate.connected === 'boolean'
}

// ─── Task Types ────────────────────────────────────────

export type TaskStatus = 'open' | 'bidding' | 'assigned' | 'running' | 'completed' | 'failed' | 'aborted'
export type TaskUrgency = 'low' | 'normal' | 'high' | 'critical'
export type TaskComplexity = 'solo' | 'delegate'

export interface Bid {
  nodeId: string
  confidence: number
  estimatedTokens: number
  capabilityScore: number
  currentLoad: number
  timestamp: number
}

export interface TaskResult {
  summary: string
  sessionId: string
  tokensUsed: number
  score: number
}

export interface Task {
  id: string
  creator: string
  description: string
  requiredCapabilities: string[]
  urgency: TaskUrgency
  complexity: TaskComplexity
  status: TaskStatus
  bids: Bid[]
  assignee: string | null
  result: TaskResult | null
  createdAt: number
  updatedAt: number
}

export interface TaskBoardSnapshot {
  tasks: Task[]
}

export function isTaskBoardSnapshot(value: unknown): value is TaskBoardSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TaskBoardSnapshot>
  return Array.isArray(candidate.tasks)
}

// ─── Knowledge Types ────────────────────────────────────────

export type ExperienceOutcome = 'success' | 'failure' | 'partial'
export type StrategyType = 'recommend' | 'avoid' | 'compare'
export type ValidationStatus = 'pending' | 'validated' | 'rejected'

export interface ExperienceMetrics {
  score: number
  tokensUsed: number
  durationMs: number
}

export interface Experience {
  id: string
  taskId: string
  domain: string
  context: string
  outcome: ExperienceOutcome
  metrics: ExperienceMetrics
  createdAt: number
}

export interface StrategyValidation {
  status: ValidationStatus
  validatedBy: string | null
  validatedAt: number | null
}

export interface Strategy {
  id: string
  type: StrategyType
  description: string
  domain: string
  successRate: number
  usageCount: number
  validation: StrategyValidation
}

export interface DistilledSkill {
  id: string
  name: string
  description: string
  confidence: number
  adoptionCount: number
  domain: string
}

export interface KnowledgeSnapshot {
  experiences: Experience[]
  strategies: Strategy[]
  distilledSkills: DistilledSkill[]
}

export function isKnowledgeSnapshot(value: unknown): value is KnowledgeSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<KnowledgeSnapshot>
  return (
    Array.isArray(candidate.experiences) &&
    Array.isArray(candidate.strategies) &&
    Array.isArray(candidate.distilledSkills)
  )
}

interface SuperAgentState {
  snapshot: SuperAgentSnapshot
  initialized: boolean
  taskBoard: TaskBoardSnapshot
  knowledge: KnowledgeSnapshot
  init: () => Promise<() => void>
  fetch: () => Promise<void>
  discover: (domain: string) => Promise<void>
  fetchTasks: () => Promise<void>
  createTask: (description: string, capabilities: string[], urgency: TaskUrgency, complexity: TaskComplexity) => Promise<Task | null>
  fetchKnowledge: () => Promise<void>
  recordExperience: (taskId: string) => Promise<void>
  validateStrategy: (strategyId: string, score: number) => Promise<void>
}

export const useSuperAgentStore = create<SuperAgentState>((set, get) => ({
  snapshot: DEFAULT_SNAPSHOT,
  initialized: false,
  taskBoard: { tasks: [] },
  knowledge: { experiences: [], strategies: [], distilledSkills: [] },

  init: async () => {
    if (get().initialized) {
      return () => {}
    }

    if (!isTauri()) {
      set({ initialized: true })
      return () => {}
    }

    const { listen } = await import('@tauri-apps/api/event')

    const unlisten = await listen<SuperAgentSnapshot>('super-agent:snapshot', (event) => {
      set({ snapshot: event.payload })
    })

    set({ initialized: true })

    // Fetch initial state after subscribing to avoid missing early events
    await get().fetch()

    return () => {
      unlisten()
      set({ initialized: false })
    }
  },

  fetch: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const snapshot = await invoke<SuperAgentSnapshot | null>('super_agent_snapshot')
      if (isSuperAgentSnapshot(snapshot)) {
        set({ snapshot })
      }
    } catch (err) {
      console.warn('[SuperAgent] Failed to fetch super agent snapshot:', err)
    }
  },

  discover: async (domain: string) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_discover', { domain })
    } catch (err) {
      console.warn('[SuperAgent] Failed to discover agents:', err)
    }
  },

  fetchTasks: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const snapshot = await invoke<TaskBoardSnapshot | null>('super_agent_get_tasks')
      if (isTaskBoardSnapshot(snapshot)) {
        set({ taskBoard: snapshot })
      }
    } catch (err) {
      console.warn('[SuperAgent] Failed to fetch tasks:', err)
    }
  },

  createTask: async (description, capabilities, urgency, complexity) => {
    if (!isTauri()) return null
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const task = await invoke<Task>('super_agent_create_task', {
        description,
        requiredCapabilities: capabilities,
        urgency,
        complexity,
      })
      await get().fetchTasks()
      return task
    } catch (err) {
      console.warn('[SuperAgent] Failed to create task:', err)
      return null
    }
  },

  fetchKnowledge: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const snapshot = await invoke<KnowledgeSnapshot | null>('super_agent_get_knowledge')
      if (isKnowledgeSnapshot(snapshot)) {
        set({ knowledge: snapshot })
      }
    } catch (err) {
      console.warn('[SuperAgent] Failed to fetch knowledge:', err)
    }
  },

  recordExperience: async (taskId: string) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_record_experience', { taskId })
      await get().fetchKnowledge()
    } catch (err) {
      console.warn('[SuperAgent] Failed to record experience:', err)
    }
  },

  validateStrategy: async (strategyId: string, score: number) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_validate_strategy', { strategyId, score })
      await get().fetchKnowledge()
    } catch (err) {
      console.warn('[SuperAgent] Failed to validate strategy:', err)
    }
  },
}))
