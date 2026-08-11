import type { TeamMembership } from "./teams-api";

type Membership = Pick<TeamMembership, "orgName">;

export type MembershipGroup<T extends Membership> = {
  /** Org name, or "Other" for memberships whose org is unknown. */
  org: string;
  memberships: T[];
};

/** iOS `OrgTeamPickerView` buckets nameless orgs under this label. */
export const UNGROUPED_ORG_LABEL = "Other";

/**
 * Groups memberships by org, preserving first-seen order — ported from iOS
 * `OrgTeamPickerView.groups`.
 *
 * Not cosmetic. A team's org decides whether the team is usable at all: the
 * server has one active org per session, and teams from any other org are
 * filtered out by RLS after they are picked. A flat list gives the user no way
 * to see that coming; grouped, the boundary they are crossing is on screen.
 */
export function groupMembershipsByOrg<T extends Membership>(
  memberships: ReadonlyArray<T>,
): MembershipGroup<T>[] {
  const order: string[] = [];
  const byOrg = new Map<string, T[]>();

  for (const membership of memberships) {
    const key = membership.orgName?.trim() || UNGROUPED_ORG_LABEL;
    const bucket = byOrg.get(key);
    if (bucket) {
      bucket.push(membership);
    } else {
      order.push(key);
      byOrg.set(key, [membership]);
    }
  }

  return order.map((org) => ({ org, memberships: byOrg.get(org) ?? [] }));
}
