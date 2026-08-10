export type BootstrapTeam = {
  id: string;
  name: string;
  slug: string;
  role: string;
  orgName: string | null;
};

export type BootstrapDecision =
  /** No teams at all — the user has to make one. */
  | { kind: "createTeam" }
  /** Exactly one candidate, or a remembered choice that still exists. */
  | { kind: "adopt"; teamId: string }
  /** More than one and nothing remembered — the user picks. */
  | { kind: "selectTeam"; teams: BootstrapTeam[] };

/**
 * Which team the app opens into, ported from iOS
 * `AppOnboardingCoordinator.resolveRoute`.
 *
 * Expo used to take `items.find(t => t.isMember !== false)` — whichever team
 * the listing happened to return first — and activate it. A user on several
 * teams landed in one of them with nothing saying a choice had been made for
 * them, and if that team sat in an org this session is not active in, RLS
 * filtered the app down to empty.
 *
 * Order matters and mirrors iOS:
 *
 *  1. A remembered choice wins, but only while it is still a team the user is
 *     on. Stale ids are ignored rather than activated — losing access to a team
 *     should not strand the app on a picker-less dead end.
 *  2. More than one team and nothing remembered: ask.
 *  3. Exactly one: adopt it silently. There is no choice to make.
 *  4. None: create one.
 */
export function resolveBootstrapDecision(args: {
  teams: ReadonlyArray<BootstrapTeam>;
  rememberedTeamId?: string | null;
}): BootstrapDecision {
  const teams = args.teams;
  if (teams.length === 0) return { kind: "createTeam" };

  const remembered = args.rememberedTeamId?.trim();
  if (remembered && teams.some((team) => team.id === remembered)) {
    return { kind: "adopt", teamId: remembered };
  }

  if (teams.length > 1) return { kind: "selectTeam", teams: [...teams] };

  return { kind: "adopt", teamId: teams[0].id };
}
