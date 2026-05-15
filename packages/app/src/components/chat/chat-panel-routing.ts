export interface NewSessionActorPickerRouteArgs {
  activeSessionId: string | null
  activeMessageCount: number
  hasDraftPreselectedActor: boolean
}

export function shouldOpenNewSessionActorPicker({
  activeSessionId,
  activeMessageCount,
  hasDraftPreselectedActor,
}: NewSessionActorPickerRouteArgs): boolean {
  if (hasDraftPreselectedActor) return false
  return !activeSessionId || activeMessageCount === 0
}
