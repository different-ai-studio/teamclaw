import type { StatsPeriod } from "../ideas/idea-stats";
import type { Actor } from "./actor-types";

/**
 * Team statistics, ported 1:1 from the iOS `TeamStatsSheet`.
 *
 * The numbers are placeholders, exactly as they are on iOS: token counts are
 * derived from a hash of the actor id, and the session / skill totals are
 * per-period constants. They are stable per actor so the sheet doesn't churn
 * between renders. Real per-actor telemetry does not exist yet; when it lands,
 * both clients should switch together.
 *
 * Everything here is kept byte-for-byte equivalent to the Swift source so the
 * two apps show the same figures for the same team.
 */

export type ActorTokenStat = {
  actorId: string;
  name: string;
  isAgent: boolean;
  agentType: string | null;
  tokens: number;
};

export type SkillStat = {
  name: string;
  count: number;
};

export type TeamStats = {
  totalTokens: number;
  totalSessions: number;
  totalSkills: number;
  actors: ActorTokenStat[];
  skills: SkillStat[];
};

/**
 * Swift's `actorId.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }`, then
 * `abs`. Iterating with `for…of` yields code points, not UTF-16 units, which is
 * what `unicodeScalars` gives — the two only differ outside the BMP, but actor
 * ids are uuids so this is exact either way.
 */
export function actorIdHash(actorId: string): number {
  let sum = 0;
  for (const char of actorId) sum += char.codePointAt(0) ?? 0;
  return Math.abs(sum);
}

/** Scales the per-period constants; `week` is the baseline of 7. */
function periodMultiplier(period: StatsPeriod): number {
  switch (period) {
    case "today":
      return 1;
    case "week":
      return 7;
    case "month":
      return 30;
    case "all":
      return 90;
  }
}

const TOKEN_BASES = [8_200, 14_400, 22_100, 31_500, 47_800, 68_000, 112_300];

const SESSION_TOTALS: Record<StatsPeriod, number> = {
  today: 6,
  week: 42,
  month: 178,
  all: 534,
};

const SKILL_TOTALS: Record<StatsPeriod, number> = {
  today: 38,
  week: 386,
  month: 1_642,
  all: 4_920,
};

const SKILL_BASES: ReadonlyArray<readonly [string, number]> = [
  ["Read", 142],
  ["Edit", 88],
  ["Bash", 54],
  ["Write", 32],
  ["Grep", 24],
];

export function buildTeamStats(args: {
  actors: ReadonlyArray<Actor>;
  period: StatsPeriod;
}): TeamStats {
  const multiplier = periodMultiplier(args.period);

  const actors = args.actors
    .filter((actor) => actor.actorType === "member" || actor.actorType === "agent")
    .map<ActorTokenStat>((actor) => {
      const base = TOKEN_BASES[actorIdHash(actor.actorId) % TOKEN_BASES.length];
      return {
        actorId: actor.actorId,
        name: actor.displayName,
        isAgent: actor.actorType === "agent",
        agentType: actor.defaultAgentType,
        // Swift integer division truncates.
        tokens: Math.trunc((base * multiplier) / 7),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const skills = SKILL_BASES.map<SkillStat>(([name, base]) => ({
    name,
    count: Math.trunc((base * multiplier) / 7),
  }));

  return {
    totalTokens: actors.reduce((sum, actor) => sum + actor.tokens, 0),
    totalSessions: SESSION_TOTALS[args.period],
    totalSkills: SKILL_TOTALS[args.period],
    actors,
    skills,
  };
}

/** `112300 → "112.3K"`, `1_200_000 → "1.2M"`. Mirrors iOS `formattedTokens`. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

/** Up to two whitespace-separated initials, else the first character. */
export function statInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = parts
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
  return initials || name.charAt(0).toUpperCase();
}
