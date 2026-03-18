import { getOpenCodeClient } from '@/lib/opencode/client'
import { invoke } from '@tauri-apps/api/core'
import type { SearchResult } from '@/stores/knowledge'

// ============================================================================
// Types
// ============================================================================

interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

interface MemoryExtractionConfig {
  enabled: boolean
  autoExtract: boolean
  minTurns: number
  debounceSec: number
}

const DEFAULT_CONFIG: MemoryExtractionConfig = {
  enabled: true,
  autoExtract: true,
  minTurns: 4,
  debounceSec: 30,
}

// ============================================================================
// State
// ============================================================================

const MEMORY_SESSION_KEY = 'teamclaw-memory-session-id'
const lastExtractionMap = new Map<string, number>()

// ============================================================================
// Heuristic Detection
// ============================================================================

const CORRECTION_PATTERNS = [
  /不对/,
  /错了/,
  /不是这样/,
  /应该是/,
  /请改/,
  /纠正/,
  /搞错/,
  /不行/,
  /wrong/i,
  /incorrect/i,
  /should be/i,
  /fix that/i,
  /that's not right/i,
  /不要这样/,
  /别这样/,
]

const PREFERENCE_PATTERNS = [
  /我叫/,
  /我的名字/,
  /我是/,
  /我喜欢/,
  /我偏好/,
  /以后请/,
  /以后都/,
  /请记住/,
  /remember that/i,
  /my name is/i,
  /i prefer/i,
  /always use/i,
  /从现在开始/,
  /以后用/,
]

export function shouldExtractMemory(messages: ConversationMessage[]): boolean {
  if (messages.length < DEFAULT_CONFIG.minTurns) return false

  const userMessages = messages.filter(m => m.role === 'user')

  for (const msg of userMessages) {
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(msg.content)) return true
    }
    for (const pattern of PREFERENCE_PATTERNS) {
      if (pattern.test(msg.content)) return true
    }
  }

  return messages.length >= 8
}

export function isExtractionDebounced(sessionId: string): boolean {
  const last = lastExtractionMap.get(sessionId)
  if (!last) return false
  return Date.now() - last < DEFAULT_CONFIG.debounceSec * 1000
}

// ============================================================================
// Memory Extraction via Background Session
// ============================================================================

async function getOrCreateMemorySession(): Promise<string> {
  const storedId = localStorage.getItem(MEMORY_SESSION_KEY)

  if (storedId) {
    try {
      const client = getOpenCodeClient()
      await client.getSession(storedId)
      return storedId
    } catch {
      localStorage.removeItem(MEMORY_SESSION_KEY)
    }
  }

  const client = getOpenCodeClient()
  const session = await client.createSession()
  localStorage.setItem(MEMORY_SESSION_KEY, session.id)
  return session.id
}

async function searchSimilarMemories(
  workspacePath: string,
  conversationSummary: string,
): Promise<{ memories: SearchResult[]; existingFiles: string[] }> {
  try {
    const response = await invoke<{
      results: SearchResult[]
      totalIndexed: number
      queryTimeMs: number
      searchMode: string
      degraded: boolean
    }>('rag_search', {
      workspacePath,
      query: conversationSummary,
      topK: 5,
      searchMode: 'hybrid',
      minScore: 0.6,
    })

    const memoryResults = response.results.filter(r =>
      r.source.startsWith('memory/') || r.source.startsWith('knowledge/memory/'),
    )

    const existingFiles = [
      ...new Set(
        memoryResults.map(r => {
          const parts = r.source.split('/')
          return parts[parts.length - 1]
        }),
      ),
    ]

    return { memories: memoryResults, existingFiles }
  } catch (error) {
    console.error('[Memory] Failed to search similar memories:', error)
    return { memories: [], existingFiles: [] }
  }
}

function buildExtractionPrompt(
  conversation: ConversationMessage[],
  existingMemories: SearchResult[],
  existingFiles: string[],
): string {
  const conversationText = conversation
    .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
    .join('\n\n')

  let existingSection = ''
  if (existingMemories.length > 0) {
    existingSection = `\n\n## 已存在的相似记忆\n\n以下是检索到的现有记忆，如果新内容与其相似，请覆盖对应文件而非新建：\n\n`
    for (const mem of existingMemories) {
      existingSection += `**文件**: ${mem.source}\n${mem.content}\n\n---\n\n`
    }
    existingSection += `已有记忆文件名列表: ${existingFiles.join(', ')}\n`
  }

  return `## 对话内容\n\n${conversationText}${existingSection}`
}

const MEMORY_SYSTEM_PROMPT = `你是一个记忆管理助手。你的任务是分析对话内容，提取值得长期记忆的关键信息。

## 记忆提取规则

只记忆以下类型的信息：
- **preference**: 用户偏好（名字、语言、工作习惯、工具偏好等）
- **correction**: 纠错记录（agent 做错的操作及正确做法，供未来避免同样错误）
- **fact**: 重要事实（项目配置、架构决策、环境信息等）
- **workflow**: 工作流程（特定操作的完整步骤，经验总结等）

## 输出要求

如果对话中有值得记忆的内容，请使用文件写入工具将记忆保存为 Markdown 文件到 knowledge/memory/ 目录。

每个记忆文件必须包含 YAML frontmatter：

\`\`\`markdown
---
title: "简明标题"
category: preference|correction|fact|workflow
tags: [tag1, tag2]
created: 2026-03-02T10:00:00Z
updated: 2026-03-02T10:00:00Z
---

精炼的记忆正文（只保留关键信息，不要冗余）
\`\`\`

## 文件命名规则

- 使用小写英文 + 短横线：\`user-name.md\`, \`git-push-workflow.md\`
- 同一主题只保留一个文件
- 如果提供了相似的已有记忆文件，直接覆盖该文件（更新 updated 时间戳）

## 重要

- 不是所有对话都值得记忆。如果没有值得记忆的内容，直接回复"无需记忆"即可
- 记忆要精炼，每条记忆不超过 500 字
- 一次对话最多提取 3 条记忆
- created 字段在新建时设置，覆盖更新时保持原值不变；updated 字段每次都更新为当前时间`

export async function extractMemories(
  messages: ConversationMessage[],
  sessionId: string,
  workspacePath: string,
): Promise<void> {
  if (!DEFAULT_CONFIG.enabled) return
  if (isExtractionDebounced(sessionId)) {
    console.log('[Memory] Extraction debounced for session:', sessionId)
    return
  }

  lastExtractionMap.set(sessionId, Date.now())

  try {
    const recentMessages = messages.slice(-20)

    const summaryForSearch = recentMessages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join(' ')
      .slice(0, 500)

    const { memories, existingFiles } = await searchSimilarMemories(
      workspacePath,
      summaryForSearch,
    )

    const prompt = buildExtractionPrompt(recentMessages, memories, existingFiles)

    const memorySessionId = await getOrCreateMemorySession()
    const client = getOpenCodeClient()

    client
      .sendMessage(memorySessionId, prompt, undefined, undefined, MEMORY_SYSTEM_PROMPT)
      .then(async () => {
        console.log('[Memory] Extraction completed, cleaning up session:', memorySessionId)
        try {
          await client.deleteSession(memorySessionId)
          localStorage.removeItem(MEMORY_SESSION_KEY)
          console.log('[Memory] Memory session deleted:', memorySessionId)
        } catch (deleteError) {
          console.error('[Memory] Failed to delete memory session:', deleteError)
        }
      })
      .catch((error: unknown) => {
        console.error('[Memory] Failed to send extraction task:', error)
      })
  } catch (error) {
    console.error('[Memory] Extraction failed:', error)
  }
}

export async function triggerManualExtraction(
  messages: ConversationMessage[],
  sessionId: string,
  workspacePath: string,
): Promise<void> {
  lastExtractionMap.delete(sessionId)
  return extractMemories(messages, sessionId, workspacePath)
}
