import { Plug, Clock, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToolCall } from '@/stores/session'

interface McpDetailProps {
  data: unknown
}

export function McpDetail({ data }: McpDetailProps) {
  const toolCall = data as ToolCall

  const formatDuration = (ms?: number) => {
    if (!ms) return '-'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  return (
    <div className="p-4">
      {/* Tool Info */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Plug size={16} className="text-accent-blue" />
          <span className="font-medium">{toolCall?.name || 'MCP Tool'}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-text-muted">
          <div className="flex items-center gap-1">
            <Clock size={12} />
            <span>{formatDuration(toolCall?.duration)}</span>
          </div>
          <div className="flex items-center gap-1">
            {toolCall?.status === 'completed' ? (
              <CheckCircle size={12} className="text-accent-green" />
            ) : toolCall?.status === 'failed' ? (
              <XCircle size={12} className="text-accent-red" />
            ) : null}
            <span className={cn(
              toolCall?.status === 'completed' && 'text-accent-green',
              toolCall?.status === 'failed' && 'text-accent-red'
            )}>
              {toolCall?.status || 'unknown'}
            </span>
          </div>
        </div>
      </div>

      {/* Arguments */}
      <div className="mb-4">
        <label className="text-xs text-text-muted">Request Arguments</label>
        <pre className="mt-1 p-3 bg-bg-tertiary rounded-md text-xs overflow-auto max-h-[200px] font-mono">
          {JSON.stringify(toolCall?.arguments || {}, null, 2)}
        </pre>
      </div>

      {/* Result */}
      {toolCall?.result !== undefined && toolCall?.result !== null && (
        <div>
          <label className="text-xs text-text-muted">Response</label>
          <pre className="mt-1 p-3 bg-bg-tertiary rounded-md text-xs overflow-auto max-h-[300px] font-mono">
            {typeof toolCall.result === 'string'
              ? toolCall.result
              : JSON.stringify(toolCall.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
