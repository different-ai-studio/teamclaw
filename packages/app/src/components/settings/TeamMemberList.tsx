import { useEffect } from 'react'
import { UserMinus, Shield, Pencil, Eye, UserPlus, Clock, UserCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTeamMembersStore } from '../../stores/team-members'
import { AddMemberInput } from './AddMemberInput'

function truncateId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}...${id.slice(-8)}`
}

function RoleBadge({ role }: { role?: string }) {
  if (role === 'owner') {
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

export function TeamMemberList() {
  const {
    members,
    myRole,
    loading,
    error,
    loadMembers,
    loadMyRole,
    addMember,
    removeMember,
    updateMemberRole,
    canManageMembers,
    applications,
    approveApplication,
    listenForApplications,
    cleanupApplicationsListener,
  } = useTeamMembersStore()

  useEffect(() => {
    loadMembers()
    loadMyRole()
    listenForApplications()
    return () => cleanupApplicationsListener()
  }, [])

  const isManager = canManageMembers()

  const handleAdd = async (nodeId: string, name: string, role: string, label: string) => {
    await addMember({
      nodeId,
      name,
      label,
      role: role as 'editor' | 'viewer',
      platform: '',
      arch: '',
      hostname: '',
      addedAt: new Date().toISOString(),
    })
  }

  return (
    <div className="space-y-4">
      {loading && (
        <p className="text-sm text-muted-foreground">Loading members...</p>
      )}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
      {/* Pending Applications */}
      {isManager && applications.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">
              待审批 ({applications.length})
            </span>
          </div>
          {applications.map((app) => (
            <div
              key={app.nodeId}
              className="flex items-center justify-between bg-amber-500/5 border border-amber-500/20 rounded-md p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{app.name}</p>
                <p className="text-xs text-muted-foreground">{app.email}</p>
                {app.note && (
                  <p className="text-xs text-muted-foreground mt-0.5">备注: {app.note}</p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  {app.platform} · {app.arch} · {new Date(app.appliedAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 text-green-600 border-green-500/30 hover:bg-green-500/10"
                onClick={() => approveApplication(app)}
              >
                <UserCheck className="mr-1 h-3.5 w-3.5" />
                通过
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {members.map((member) => {
          const isMemberOwner = member.role === 'owner'
          // Editors cannot remove or demote the owner
          const canActOnMember = isManager && !isMemberOwner && !(myRole === 'editor' && isMemberOwner)

          return (
            <div
              key={member.nodeId}
              className="flex items-center justify-between bg-muted/50 rounded-md p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">
                    {member.name || member.hostname}
                  </p>
                  <RoleBadge role={member.role} />
                </div>
                {member.label && (
                  <p className="text-xs text-muted-foreground truncate">{member.label}</p>
                )}
                <p className="text-xs font-mono text-muted-foreground truncate">
                  {truncateId(member.nodeId)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {member.platform} {member.arch} · {member.hostname}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {canActOnMember && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground"
                    onClick={() =>
                      updateMemberRole(
                        member.nodeId,
                        member.role === 'viewer' ? 'editor' : 'viewer'
                      )
                    }
                    aria-label="Toggle role"
                  >
                    {member.role === 'viewer' ? (
                      <Pencil className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                    {member.role === 'viewer' ? 'Set Editor' : 'Set Viewer'}
                  </Button>
                )}
                {canActOnMember && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => removeMember(member.nodeId)}
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
      {isManager && (
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-1.5 mb-2">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Add Member</span>
          </div>
          <AddMemberInput onAdd={handleAdd} error={error} />
        </div>
      )}
    </div>
  )
}
