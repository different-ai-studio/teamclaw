import { describe, expect, it } from "vitest";

import {
  resolveBootstrapDecision,
  type BootstrapTeam,
} from "../features/onboarding/bootstrap-route";

function team(id: string, orgName: string | null = null): BootstrapTeam {
  return { id, name: id, slug: id, role: "member", orgName };
}

describe("resolveBootstrapDecision", () => {
  it("sends a user with no teams to create one", () => {
    expect(resolveBootstrapDecision({ teams: [] })).toEqual({ kind: "createTeam" });
  });

  it("adopts the only team without asking", () => {
    expect(resolveBootstrapDecision({ teams: [team("a")] })).toEqual({
      kind: "adopt",
      teamId: "a",
    });
  });

  it("asks when there is more than one and nothing remembered", () => {
    // This is the case Expo used to answer on the user's behalf, by taking
    // whichever team the listing returned first.
    const decision = resolveBootstrapDecision({ teams: [team("a"), team("b")] });
    expect(decision.kind).toBe("selectTeam");
    expect(decision.kind === "selectTeam" && decision.teams.map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("honours a remembered choice over asking again", () => {
    expect(
      resolveBootstrapDecision({
        teams: [team("a"), team("b")],
        rememberedTeamId: "b",
      }),
    ).toEqual({ kind: "adopt", teamId: "b" });
  });

  it("ignores a remembered team the user is no longer on", () => {
    // Losing access should land on the picker, not activate a team that will
    // fail — or strand the app with no way to choose another.
    const decision = resolveBootstrapDecision({
      teams: [team("a"), team("b")],
      rememberedTeamId: "gone",
    });
    expect(decision.kind).toBe("selectTeam");
  });

  it("still adopts the single team when the remembered one is stale", () => {
    expect(
      resolveBootstrapDecision({ teams: [team("a")], rememberedTeamId: "gone" }),
    ).toEqual({ kind: "adopt", teamId: "a" });
  });

  it("treats blank and whitespace remembered ids as absent", () => {
    for (const remembered of ["", "   ", null, undefined]) {
      expect(
        resolveBootstrapDecision({ teams: [team("a"), team("b")], rememberedTeamId: remembered }).kind,
      ).toBe("selectTeam");
    }
  });

  it("copies the team list rather than handing back the caller's array", () => {
    const teams = [team("a"), team("b")];
    const decision = resolveBootstrapDecision({ teams });
    if (decision.kind !== "selectTeam") throw new Error("expected selectTeam");
    expect(decision.teams).not.toBe(teams);
    expect(decision.teams).toEqual(teams);
  });
});
