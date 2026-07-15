import { Sparkles, X } from 'lucide-react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

interface AgentChipBarProps {
  agents: AttachedAgent[]
  onRemove: (id: string) => void
}

export function AgentChipBar({ agents, onRemove }: AgentChipBarProps) {
  if (agents.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1.5 border-b">
      {agents.map(a => (
        <span
          key={a.id}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border bg-orange-50 border-orange-200 text-orange-700 text-xs font-medium dark:bg-orange-950 dark:border-orange-800 dark:text-orange-300"
        >
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="truncate max-w-[200px]">{a.displayName}</span>
          <button
            type="button"
            aria-label={`Remove ${a.displayName}`}
            onClick={() => onRemove(a.id)}
            className="ml-0.5 inline-flex items-center justify-center rounded-full hover:bg-orange-200 dark:hover:bg-orange-900"
            style={{ width: 14, height: 14 }}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  )
}
