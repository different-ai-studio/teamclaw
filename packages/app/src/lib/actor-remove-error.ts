import type { TFunction } from 'i18next'

/** Map raw Cloud API / Postgres errors to user-facing remove-from-team messages. */
export function formatActorRemoveError(raw: string, t: TFunction): string {
  if (/cannot remove the last owner/i.test(raw)) {
    return t(
      'actors.removeFailed.lastOwner',
      'Cannot remove the last team owner. Promote another member first.',
    )
  }
  if (/cannot remove your own actor/i.test(raw)) {
    return t('actors.removeFailed.self', 'You cannot remove yourself from the team.')
  }
  if (/requires owner or admin|remove_team_actor requires owner or admin/i.test(raw)) {
    return t(
      'actors.removeFailed.forbidden',
      'Only team owners and admins can remove members.',
    )
  }
  if (/agents_owner_member_id_fkey|owner_member_id/i.test(raw)) {
    return t(
      'actors.removeFailed.ownsAgents',
      'This member still owns one or more agents. Remove or reassign those agents first.',
    )
  }
  if (/actor not found/i.test(raw)) {
    return t('actors.removeFailed.notFound', 'This actor is no longer in the team.')
  }
  return t('actors.removeFailed.generic', 'Remove failed: {{msg}}', { msg: raw })
}
