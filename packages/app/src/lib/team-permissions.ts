import { useCurrentTeamStore } from '@/stores/current-team'

export type CloudRole = 'owner' | 'admin' | 'member'

export interface TeamPermissions {
  /** Cloud membership role, normalized. null = no cloud team / not yet loaded. */
  role: CloudRole | null
  /** Most sensitive gates: enable team-share, configure team-shared model. */
  isOwner: boolean
  /** Team management: env vars, shared-secret deletion, etc. (old owner/manager). */
  canManageTeam: boolean
  /** File editing. Members are read-only; owner/admin and solo/no-team can edit. */
  canEditFiles: boolean
}

/** Whether the signed-in member may remove another actor from the team (server: owner/admin, not self). */
export function canRemoveTeamActor(
  permissions: Pick<TeamPermissions, 'canManageTeam'>,
  targetActorId: string,
  currentMemberId: string | null | undefined,
): boolean {
  if (!permissions.canManageTeam) return false
  if (!currentMemberId) return false
  return targetActorId !== currentMemberId
}

export function permissionsForRole(role: string | null | undefined): TeamPermissions {
  const normalized = (role ?? '').toLowerCase()
  const r: CloudRole | null =
    normalized === 'owner' || normalized === 'admin' || normalized === 'member'
      ? (normalized as CloudRole)
      : null
  return {
    role: r,
    isOwner: r === 'owner',
    canManageTeam: r === 'owner' || r === 'admin',
    canEditFiles: r !== 'member',
  }
}

/** React hook: the single source of truth for team permissions (cloud role). */
export function useTeamPermissions(): TeamPermissions {
  const role = useCurrentTeamStore((s) => s.currentMember?.role ?? null)
  return permissionsForRole(role)
}
