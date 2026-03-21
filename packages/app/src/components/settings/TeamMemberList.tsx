import { UserMinus, Shield, Pencil, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TeamMember } from '@/lib/git/types'

function truncateId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}...${id.slice(-8)}`
}

function RoleBadge({ role, isOwner }: { role?: string; isOwner: boolean }) {
  if (isOwner) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded">
        <Shield className="h-3 w-3" />
        Owner
      </span>
    )
  }
  if (role === 'viewer') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-gray-100 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">
        <Eye className="h-3 w-3" />
        Viewer
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
      <Pencil className="h-3 w-3" />
      Editor
    </span>
  )
}

export function TeamMemberList({
  members,
  ownerNodeId,
  isOwner,
  onRemove,
  onRoleChange,
}: {
  members: TeamMember[]
  ownerNodeId: string
  isOwner: boolean
  onRemove: (nodeId: string) => void
  onRoleChange?: (nodeId: string, newRole: 'editor' | 'viewer') => void
}) {
  return (
    <div className="space-y-2">
      {members.map((member) => {
        const isMemberOwner = member.nodeId === ownerNodeId
        return (
          <div
            key={member.nodeId}
            className="flex items-center justify-between bg-muted/50 rounded-md p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium truncate">{member.name || member.label || member.hostname}</p>
                <RoleBadge role={member.role} isOwner={isMemberOwner} />
              </div>
              <p className="text-xs font-mono text-muted-foreground truncate">
                {truncateId(member.nodeId)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {member.platform} {member.arch} · {member.hostname}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {isOwner && !isMemberOwner && onRoleChange && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground"
                  onClick={() => onRoleChange(
                    member.nodeId,
                    member.role === 'viewer' ? 'editor' : 'viewer'
                  )}
                  aria-label="Toggle role"
                >
                  {member.role === 'viewer' ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {member.role === 'viewer' ? 'Set Editor' : 'Set Viewer'}
                </Button>
              )}
              {isOwner && !isMemberOwner && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => onRemove(member.nodeId)}
                  aria-label="Remove"
                >
                  <UserMinus className="h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
