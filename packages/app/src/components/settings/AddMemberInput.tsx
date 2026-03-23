import * as React from 'react'
import { UserPlus, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function AddMemberInput({
  onAdd,
  error,
}: {
  onAdd: (nodeId: string, name: string, role: string, label: string) => void
  error?: string | null
}) {
  const [nodeId, setNodeId] = React.useState('')
  const [name, setName] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [role, setRole] = React.useState<'editor' | 'viewer'>('editor')

  const handleSubmit = () => {
    if (nodeId.trim()) {
      onAdd(nodeId.trim(), name.trim(), role, label.trim())
      setNodeId('')
      setName('')
      setLabel('')
      setRole('editor')
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="flex-1 flex flex-col gap-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Member name (e.g. Alice)"
            className="h-9 text-sm"
          />
          <Input
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
            placeholder="Paste member's Device ID"
            className="h-9 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nodeId.trim()) handleSubmit()
            }}
          />
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label / Remark (optional)"
            className="h-9 text-sm"
          />
          <Select value={role} onValueChange={(v) => setRole(v as 'editor' | 'viewer')}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="editor">Editor</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={handleSubmit}
          disabled={!nodeId.trim()}
          size="sm"
          className="shrink-0 gap-1 self-end"
        >
          <UserPlus className="h-4 w-4" />
          Add
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
  )
}
