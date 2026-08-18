/**
 * Address for the actor detail pane that opens in the main column.
 *
 * Kept separate from `teamshare-target.ts`: an actor is not a team-share row,
 * and its tab must survive the bulk close that runs when the team changes only
 * insofar as the actor belongs to the new team — which it does not, so
 * `isActorOwnedTarget` exists for that sweep too.
 */

const PREFIX = 'actor/'

export function encodeActorTarget(actorId: string): string {
  return `${PREFIX}${actorId}`
}

/** The actor a target names, or null when it is not an actor target. */
export function decodeActorTarget(target: string): string | null {
  if (!target.startsWith(PREFIX)) return null
  return target.slice(PREFIX.length) || null
}

export function isActorOwnedTarget(target: string): boolean {
  return decodeActorTarget(target) !== null
}
