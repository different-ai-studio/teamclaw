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
    <div className="space-y-3">
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alice"
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Device ID</label>
        <Input
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value)}
          placeholder="Paste member's Device ID"
          className="h-9 font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && nodeId.trim()) handleSubmit()
          }}
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Label / Remark (optional)</label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Backend team"
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Role</label>
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
      {error && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
      <Button
        onClick={handleSubmit}
        disabled={!nodeId.trim()}
        className="w-full gap-2"
      >
        <UserPlus className="h-4 w-4" />
        Add Member
      </Button>
    </div>
  )
}
