import { UserMinus, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TeamMember } from '@/lib/git/types'

function truncateId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}...${id.slice(-8)}`
}

export function TeamMemberList({
  members,
  ownerNodeId,
  isOwner,
  onRemove,
}: {
  members: TeamMember[]
  ownerNodeId: string
  isOwner: boolean
  onRemove: (nodeId: string) => void
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
                {isMemberOwner && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded">
                    <Shield className="h-3 w-3" />
                    Owner
                  </span>
                )}
              </div>
              <p className="text-xs font-mono text-muted-foreground truncate">
                {truncateId(member.nodeId)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {member.platform} {member.arch} · {member.hostname}
              </p>
            </div>
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
        )
      })}
    </div>
  )
}
