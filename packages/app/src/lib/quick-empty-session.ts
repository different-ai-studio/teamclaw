/**
 * @deprecated Prefer draft-first (`enterActorDraft` / `createQuickSession`).
 * Empty shell creation before the first message is intentionally avoided —
 * sessions are created when the user sends.
 */

export function soloParticipantSessionTitle(displayName: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const now = new Date()
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `${displayName} (${hhmm})`
}
