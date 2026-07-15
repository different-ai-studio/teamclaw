import { Terminal } from 'lucide-react'

interface TerminalOutputProps {
  data: unknown
}

export function TerminalOutput({ data }: TerminalOutputProps) {
  const toolCall = data as { arguments?: { command?: string }; result?: string }
  const command = toolCall?.arguments?.command || 'echo "Hello World"'
  const output = toolCall?.result || 'Command output will be displayed here'

  return (
    <div className="p-4">
      {/* Command */}
      <div className="mb-4">
        <label className="text-xs text-text-muted">Command</label>
        <div className="mt-1 flex items-center gap-2 p-2 bg-bg-tertiary rounded-md text-sm font-mono">
          <span className="text-accent-green">$</span>
          <span>{command}</span>
        </div>
      </div>

      {/* Output */}
      <div>
        <label className="text-xs text-text-muted">Output</label>
        <div className="mt-1 bg-[#1e1e1e] rounded-md overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-tertiary border-b border-border">
            <Terminal size={12} className="text-text-muted" />
            <span className="text-xs text-text-muted">Terminal</span>
          </div>
          <pre className="p-3 text-xs overflow-auto max-h-[400px] font-mono text-green-400">
            {output}
          </pre>
        </div>
      </div>
    </div>
  )
}
