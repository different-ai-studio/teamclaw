import * as React from 'react'
import { isTauri } from '@/lib/utils'
import { RECONCILE_INTERVAL_MS } from '@/lib/skills/auto-follow'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'

/**
 * Keeps installed team skills on the version the team is running.
 *
 * Mounted app-wide rather than inside the team-share panel, because the members
 * this exists for are precisely the ones who never open that panel. A reconcile
 * that only ran while the UI was visible would leave everyone else on whatever
 * version they happened to install, which is the situation auto-follow replaces.
 *
 * Errors are swallowed on purpose. This is background maintenance the user did
 * not ask for; a toast about a failed sync while they are doing something else
 * is noise, and the next tick retries anyway. What the user does need to see —
 * a local edit blocking an update — surfaces in the skills panel as a conflict,
 * not as a transient error here.
 */
export function TeamSkillAutoFollow({ teamId }: { teamId: string | null }) {
  const reconcile = useTeamShareBrowserStore((s) => s.reconcileSkills)

  React.useEffect(() => {
    if (!teamId || !isTauri()) return
    let cancelled = false

    const run = () => {
      if (cancelled) return
      void reconcile().catch(() => {})
    }

    run()
    const timer = window.setInterval(run, RECONCILE_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [teamId, reconcile])

  return null
}

export default TeamSkillAutoFollow
