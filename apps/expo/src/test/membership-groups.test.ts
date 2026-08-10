import { describe, expect, it } from "vitest";

import {
  groupMembershipsByOrg,
  UNGROUPED_ORG_LABEL,
} from "../features/teams/membership-groups";

function team(teamId: string, orgName: string | null) {
  return { teamId, orgName };
}

describe("groupMembershipsByOrg", () => {
  it("buckets teams under their org", () => {
    const groups = groupMembershipsByOrg([
      team("a", "Acme"),
      team("b", "Beta"),
      team("c", "Acme"),
    ]);
    expect(groups.map((g) => g.org)).toEqual(["Acme", "Beta"]);
    expect(groups[0]?.memberships.map((m) => m.teamId)).toEqual(["a", "c"]);
  });

  it("preserves first-seen order rather than sorting", () => {
    // The server returns the picker list in an order it chose; re-sorting here
    // would fight it.
    const groups = groupMembershipsByOrg([team("a", "Zeta"), team("b", "Alpha")]);
    expect(groups.map((g) => g.org)).toEqual(["Zeta", "Alpha"]);
  });

  it("collects orgless teams under one bucket", () => {
    const groups = groupMembershipsByOrg([
      team("a", null),
      team("b", "Acme"),
      team("c", ""),
      team("d", "   "),
    ]);
    const other = groups.find((g) => g.org === UNGROUPED_ORG_LABEL);
    expect(other?.memberships.map((m) => m.teamId)).toEqual(["a", "c", "d"]);
  });

  it("trims the org name so whitespace does not split a bucket", () => {
    const groups = groupMembershipsByOrg([team("a", "Acme"), team("b", " Acme ")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberships).toHaveLength(2);
  });

  it("returns nothing for an empty list", () => {
    expect(groupMembershipsByOrg([])).toEqual([]);
  });
});
