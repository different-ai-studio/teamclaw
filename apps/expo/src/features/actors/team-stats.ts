import { periodCutoff, scopeIdeasToPeriod, type StatsPeriod } from "../ideas/idea-stats";
import type { Idea } from "../ideas/idea-types";
import type { SessionSummary } from "../sessions/session-types";
import { isActorOnline, type Actor } from "./actor-types";

/**
 * Team activity aggregation behind the Team Statistics sheet.
 *
 * iOS's `TeamStatsSheet` shows hash-derived token counts and hardcoded session
 * and skill totals — placeholders for per-actor telemetry that does not exist
 * yet. Rather than reproduce numbers that aren't true, this keeps the same
 * shape (period picker, summary cards, per-actor ranking) and drives it from
 * data the client already has: the sessions an actor takes part in and the
 * ideas they created.
 */

export type ActorActivityStat = {
  actorId: string;
  name: string;
  isAgent: boolean;
  isOnline: boolean;
  sessions: number;
  ideas: number;
  /** Ranking key: sessions + ideas attributed to this actor in the period. */
  total: number;
};

export type TeamStats = {
  members: number;
  agents: number;
  sessions: number;
  ideas: number;
  actors: ActorActivityStat[];
};

/** Sessions created within the period. Unparseable timestamps are kept. */
export function scopeSessionsToPeriod(
  sessions: ReadonlyArray<SessionSummary>,
  period: StatsPeriod,
  now: number = Date.now(),
): SessionSummary[] {
  const cutoff = periodCutoff(period, now);
  if (cutoff === null) return [...sessions];
  return sessions.filter((session) => {
    const created = Date.parse(session.createdAt);
    return Number.isFinite(created) ? created >= cutoff : true;
  });
}

export function buildTeamStats(args: {
  actors: ReadonlyArray<Actor>;
  ideas: ReadonlyArray<Idea>;
  sessions: ReadonlyArray<SessionSummary>;
  period: StatsPeriod;
  now?: number;
}): TeamStats {
  const now = args.now ?? Date.now();
  const scopedIdeas = scopeIdeasToPeriod(args.ideas, args.period, now);
  const scopedSessions = scopeSessionsToPeriod(args.sessions, args.period, now);

  const sessionsByActor = new Map<string, number>();
  for (const session of scopedSessions) {
    // Dedupe: a participant list that repeats an actor must not inflate them.
    for (const actorId of new Set(
      session.participantActorIds.map((id) => id.trim()).filter(Boolean),
    )) {
      sessionsByActor.set(actorId, (sessionsByActor.get(actorId) ?? 0) + 1);
    }
  }
  const ideasByActor = new Map<string, number>();
  for (const idea of scopedIdeas) {
    const actorId = idea.createdByActorId?.trim();
    if (!actorId) continue;
    ideasByActor.set(actorId, (ideasByActor.get(actorId) ?? 0) + 1);
  }

  // Only humans and agents are ranked; gateway-only `external` actors land in
  // neither section on the Actors list either.
  const ranked = args.actors
    .filter((actor) => actor.actorType === "member" || actor.actorType === "agent")
    .map<ActorActivityStat>((actor) => {
      const sessions = sessionsByActor.get(actor.actorId) ?? 0;
      const ideas = ideasByActor.get(actor.actorId) ?? 0;
      return {
        actorId: actor.actorId,
        name: actor.displayName,
        isAgent: actor.actorType === "agent",
        isOnline: isActorOnline(actor, now),
        sessions,
        ideas,
        total: sessions + ideas,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return {
    members: args.actors.filter((actor) => actor.actorType === "member").length,
    agents: args.actors.filter((actor) => actor.actorType === "agent").length,
    sessions: scopedSessions.length,
    ideas: scopedIdeas.length,
    actors: ranked,
  };
}
