export function canRemoveActor({
  actorId,
  currentMemberActorId,
  currentTeamRole,
}: {
  actorId: string | null | undefined;
  currentMemberActorId: string | null | undefined;
  currentTeamRole: string | null | undefined;
}): boolean {
  if (!actorId || !currentMemberActorId) return false;
  if (actorId === currentMemberActorId) return false;
  return currentTeamRole === "owner" || currentTeamRole === "admin";
}

export function canManageAuthorizedHumans({
  actorType,
  isOwner,
}: {
  actorType: string | null | undefined;
  isOwner: boolean | null | undefined;
}): boolean {
  // Owner-gating is resolved server-side (GET /v1/agents/:id/permission) and
  // surfaced as `isOwner`; the directory no longer carries owner_member_id.
  return actorType === "agent" && Boolean(isOwner);
}
