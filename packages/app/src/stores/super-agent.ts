import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

// Types must match Rust backend's SuperAgentSnapshot exactly
export type AgentStatus = 'online' | 'busy' | 'idle' | 'offline'

export interface Capability {
  domain: string
  skills: string[]
  tools: string[]
  languages: string[]
  confidence: number
  taskCount: number
  avgScore: number
}

export interface AgentProfile {
  nodeId: string
  name: string
  owner: string
  capabilities: Capability[]
  status: AgentStatus
  currentTask: string | null
  lastHeartbeat: number
  version: string
  modelId: string
  joinedAt: number
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
export type ValidationStatus = 'proposed' | 'testing' | 'validated' | 'deprecated'

export interface ExperienceMetrics {
  score: number
  tokensUsed: number
  duration: number
  toolCallCount: number
  retryCount: number
}

export interface Experience {
  id: string
  agentId: string
  taskId: string
  sessionId: string
  domain: string
  tags: string[]
  outcome: ExperienceOutcome
  context: string
  action: string
  result: string
  lesson: string
  metrics: ExperienceMetrics
  createdAt: number
  expiresAt: number
}

export interface StrategyValidation {
  status: ValidationStatus
  validatedBy: string[]
  validationScore: number
}

export interface Strategy {
  id: string
  domain: string
  tags: string[]
  strategyType: StrategyType
  condition: string
  recommendation: string
  reasoning: string
  sourceExperiences: string[]
  successRate: number
  sampleSize: number
  contributingAgents: string[]
  confidenceInterval: number
  validation: StrategyValidation
  createdAt: number
  updatedAt: number
}

export interface DistilledSkill {
  id: string
  name: string
  sourceStrategyId: string
  skillContent: string
  adoptionCount: number
  avgEffectiveness: number
  createdAt: number
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

// ─── Debate Types ────────────────────────────────────────

export type Angle = string

export type DebateStatus = 'gathering_perspectives' | 'debating' | 'voting' | 'concluded'

export type RebuttalStance = 'agree' | 'disagree' | 'partially_agree'

export interface OptionScore {
  option: string
  score: number
  reason: string
}

export interface Perspective {
  debateId: string
  agentId: string
  angle: Angle
  position: string
  reasoning: string
  evidence: string[]
  risks: string[]
  preferredOption: string
  optionRanking: OptionScore[]
  confidence: number
}

export interface Rebuttal {
  targetAgentId: string
  targetClaim: string
  response: RebuttalStance
  argument: string
  newEvidence: string[]
}

export interface DebateResponse {
  agentId: string
  rebuttals: Rebuttal[]
  updatedPosition: string
  updatedConfidence: number
  readyToConverge: boolean
}

export interface DebateRound {
  round: number
  responses: DebateResponse[]
}

export interface CandidateOption {
  id: string
  description: string
  synthesizedFrom: string[]
  pros: string[]
  cons: string[]
}

export interface VoteRanking {
  optionId: string
  rank: number
}

export interface Vote {
  agentId: string
  preferredOptionId: string
  ranking: VoteRanking[]
  confidence: number
  finalReasoning: string
}

export interface DeliberationTrigger {
  explicit: boolean
  creatorConfidence: number
  domainFailureRate: number
  crossDomainCount: number
}

export interface SynthesisResult {
  winningOptionId: string
  winningDescription: string
  votingRounds: number
  margin: number
  dissent: string[]
}

export interface PostDecisionOutcome {
  taskId: string
  actualResult: string
  score: number
  wasCorrectDecision: boolean
}

export interface DebateRecord {
  id: string
  question: string
  context: string
  trigger: DeliberationTrigger
  status: DebateStatus
  requestedAngles: Angle[]
  perspectives: Perspective[]
  rounds: DebateRound[]
  candidateOptions: CandidateOption[]
  votes: Vote[]
  synthesis: SynthesisResult | null
  outcome: PostDecisionOutcome | null
  createdAt: number
  concludedAt: number | null
  deadline: number
}

export interface DebateSnapshot {
  debates: DebateRecord[]
}

export function isDebateSnapshot(value: unknown): value is DebateSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DebateSnapshot>
  return Array.isArray(candidate.debates)
}

interface SuperAgentState {
  snapshot: SuperAgentSnapshot
  initialized: boolean
  taskBoard: TaskBoardSnapshot
  knowledge: KnowledgeSnapshot
  debates: DebateSnapshot
  init: () => Promise<() => void>
  fetch: () => Promise<void>
  discover: (domain: string) => Promise<void>
  fetchTasks: () => Promise<void>
  createTask: (description: string, capabilities: string[], urgency: TaskUrgency, complexity: TaskComplexity) => Promise<Task | null>
  fetchKnowledge: () => Promise<void>
  recordExperience: (taskId: string) => Promise<void>
  validateStrategy: (strategyId: string, score: number) => Promise<void>
  fetchDebates: () => Promise<void>
  startDeliberation: (question: string, context: string, requestedAngles: Angle[]) => Promise<DebateRecord | null>
  submitPerspective: (debateId: string, angle: Angle, position: string, confidence: number, reasoning: string) => Promise<void>
  submitVote: (debateId: string, preferredOptionId: string, ranking: VoteRanking[], confidence: number, reasoning: string) => Promise<void>
}

export const useSuperAgentStore = create<SuperAgentState>((set, get) => ({
  snapshot: DEFAULT_SNAPSHOT,
  initialized: false,
  taskBoard: { tasks: [] },
  knowledge: { experiences: [], strategies: [], distilledSkills: [] },
  debates: { debates: [] },

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

  fetchDebates: async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const snapshot = await invoke<DebateSnapshot | null>('super_agent_get_debates')
      if (isDebateSnapshot(snapshot)) {
        set({ debates: snapshot })
      }
    } catch (err) {
      console.warn('[SuperAgent] Failed to fetch debates:', err)
    }
  },

  startDeliberation: async (question: string, context: string, requestedAngles: Angle[]) => {
    if (!isTauri()) return null
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const debate = await invoke<DebateRecord>('super_agent_start_deliberation', {
        question,
        context,
        requestedAngles,
      })
      await get().fetchDebates()
      return debate
    } catch (err) {
      console.warn('[SuperAgent] Failed to start deliberation:', err)
      return null
    }
  },

  submitPerspective: async (debateId: string, angle: Angle, position: string, confidence: number, reasoning: string) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_submit_perspective', { debateId, angle, position, confidence, reasoning })
      await get().fetchDebates()
    } catch (err) {
      console.warn('[SuperAgent] Failed to submit perspective:', err)
    }
  },

  submitVote: async (debateId: string, preferredOptionId: string, ranking: VoteRanking[], confidence: number, reasoning: string) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('super_agent_submit_vote', { debateId, preferredOptionId, ranking, confidence, reasoning })
      await get().fetchDebates()
    } catch (err) {
      console.warn('[SuperAgent] Failed to submit vote:', err)
    }
  },
}))
