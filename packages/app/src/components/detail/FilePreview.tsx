import { File } from 'lucide-react'

interface FilePreviewProps {
  data: unknown
}

export function FilePreview({ data }: FilePreviewProps) {
  const toolCall = data as { arguments?: { path?: string }; result?: string }
  const path = toolCall?.arguments?.path || '/path/to/file'
  const content = toolCall?.result || '// File content will be displayed here'

  return (
    <div className="p-4">
      {/* File Path */}
      <div className="mb-4">
        <label className="text-xs text-text-muted">File Path</label>
        <div className="mt-1 flex items-center gap-2 p-2 bg-bg-tertiary rounded-md text-sm">
          <File size={14} className="text-accent-blue" />
          <span className="truncate">{path}</span>
        </div>
      </div>

      {/* File Content */}
      <div>
        <label className="text-xs text-text-muted">Content</label>
        <pre className="mt-1 p-3 bg-bg-tertiary rounded-md text-xs overflow-auto max-h-[400px] font-mono">
          {content}
        </pre>
      </div>
    </div>
  )
}
