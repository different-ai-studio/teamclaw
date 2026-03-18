import * as React from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/utils'

function truncateNodeId(nodeId: string): string {
  if (nodeId.length <= 20) return nodeId
  return `${nodeId.slice(0, 8)}...${nodeId.slice(-8)}`
}

export function DeviceIdDisplay({ nodeId }: { nodeId: string }) {
  const [copied, setCopied] = React.useState(false)

  const handleCopy = async () => {
    await copyToClipboard(nodeId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 bg-muted rounded-md px-3 py-2 text-xs font-mono select-all">
        {truncateNodeId(nodeId)}
      </code>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 gap-1"
        onClick={handleCopy}
      >
        {copied ? (
          <>
            <Check className="h-3 w-3" />
            Copied
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" />
            Copy
          </>
        )}
      </Button>
    </div>
  )
}
