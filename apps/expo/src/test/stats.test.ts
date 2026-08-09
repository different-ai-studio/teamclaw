import { describe, expect, it } from "vitest";

import type { Actor } from "../features/actors/actor-types";
import { buildTeamStats, scopeSessionsToPeriod } from "../features/actors/team-stats";
import {
  buildIdeaStats,
  periodCutoff,
  scopeIdeasToPeriod,
} from "../features/ideas/idea-stats";
import type { Idea } from "../features/ideas/idea-types";
import type { SessionSummary } from "../features/sessions/session-types";

const NOW = Date.parse("2026-05-20T12:00:00.000Z");

function idea(partial: Partial<Idea> & { ideaId: string }): Idea {
  return {
    teamId: "t1",
    workspaceId: null,
    workspaceName: null,
    createdByActorId: null,
    title: partial.ideaId,
    description: "",
    status: "open",
    archived: false,
    sortOrder: 0,
    createdAt: "2026-05-20T11:00:00.000Z",
    updatedAt: "2026-05-20T11:00:00.000Z",
    ...partial,
  };
}

function actor(partial: Partial<Actor> & { actorId: string }): Actor {
  return {
    teamId: "t1",
    actorType: "member",
    displayName: partial.actorId,
    role: null,
    lastActiveAt: null,
    avatarUrl: null,
    agentTypes: [],
    defaultAgentType: null,
    agentKind: null,
    ...partial,
  };
}

function session(partial: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    teamId: "t1",
    title: partial.sessionId,
    summary: "",
    participantCount: 0,
    participantActorIds: [],
    lastMessagePreview: "",
    lastMessageAt: "2026-05-20T11:00:00.000Z",
    createdAt: "2026-05-20T11:00:00.000Z",
    createdBy: "",
    ...partial,
  };
}

describe("periodCutoff", () => {
  it("returns null only for all-time", () => {
    expect(periodCutoff("all", NOW)).toBeNull();
    expect(periodCutoff("week", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(periodCutoff("month", NOW)).toBe(NOW - 30 * 86_400_000);
    expect(periodCutoff("today", NOW)).toBeLessThanOrEqual(NOW);
  });
});

describe("scopeIdeasToPeriod", () => {
  it("drops rows created before the cutoff but keeps unparseable timestamps", () => {
    const rows = [
      idea({ ideaId: "recent", createdAt: "2026-05-19T00:00:00.000Z" }),
      idea({ ideaId: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      idea({ ideaId: "broken", createdAt: "" }),
    ];
    expect(scopeIdeasToPeriod(rows, "week", NOW).map((i) => i.ideaId)).toEqual([
      "recent",
      "broken",
    ]);
    expect(scopeIdeasToPeriod(rows, "all", NOW)).toHaveLength(3);
  });
});

describe("buildIdeaStats", () => {
  it("counts in-progress as open, and ranks contributors and workspaces", () => {
    const stats = buildIdeaStats({
      now: NOW,
      period: "week",
      actors: [
        actor({ actorId: "a1", displayName: "Ada" }),
        actor({ actorId: "a2", displayName: "Bot", actorType: "agent" }),
      ],
      ideas: [
        idea({ ideaId: "1", createdByActorId: "a1", status: "open", workspaceId: "w1", workspaceName: "Repo" }),
        idea({ ideaId: "2", createdByActorId: "a1", status: "in_progress", workspaceId: "w1", workspaceName: "Repo" }),
        idea({ ideaId: "3", createdByActorId: "a2", status: "done" }),
        idea({ ideaId: "4", createdByActorId: "gone", status: "done", workspaceId: "w2", workspaceName: "Docs" }),
      ],
    });

    expect(stats).toMatchObject({ total: 4, open: 2, done: 2 });
    expect(stats.contributors).toEqual([
      { actorId: "a1", name: "Ada", isAgent: false, isOnline: false, count: 2 },
      { actorId: "a2", name: "Bot", isAgent: true, isOnline: false, count: 1 },
      // An idea whose author has left the team still counts, under "Unknown".
      { actorId: "gone", name: "Unknown", isAgent: false, isOnline: false, count: 1 },
    ]);
    // Ties break by name, so Docs sorts ahead of Unassigned.
    expect(stats.workspaces).toEqual([
      { id: "w1", name: "Repo", count: 2 },
      { id: "w2", name: "Docs", count: 1 },
      { id: "_unassigned", name: "Unassigned", count: 1 },
    ]);
  });
});

describe("buildTeamStats", () => {
  it("ranks actors by their sessions plus ideas in the period", () => {
    const stats = buildTeamStats({
      now: NOW,
      period: "week",
      actors: [
        actor({ actorId: "a1", displayName: "Ada" }),
        actor({ actorId: "a2", displayName: "Bot", actorType: "agent" }),
        actor({ actorId: "ext", displayName: "WeCom", actorType: "external" }),
      ],
      ideas: [idea({ ideaId: "1", createdByActorId: "a1" })],
      sessions: [
        // A repeated participant must not inflate that actor's count.
        session({ sessionId: "s1", participantActorIds: ["a1", "a2", "a2"] }),
        session({ sessionId: "s2", participantActorIds: ["a2"] }),
        session({ sessionId: "old", participantActorIds: ["a1"], createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });

    expect(stats).toMatchObject({ members: 1, agents: 1, sessions: 2, ideas: 1 });
    // External actors are excluded from the ranking, as on the Actors list.
    // Both score 2, so the tie breaks by name: Ada before Bot.
    expect(stats.actors.map((a) => a.actorId)).toEqual(["a1", "a2"]);
    expect(stats.actors[0]).toMatchObject({ sessions: 1, ideas: 1, total: 2 });
    expect(stats.actors[1]).toMatchObject({ sessions: 2, ideas: 0, total: 2 });
  });
});

describe("scopeSessionsToPeriod", () => {
  it("keeps everything for all-time", () => {
    const rows = [session({ sessionId: "old", createdAt: "2020-01-01T00:00:00.000Z" })];
    expect(scopeSessionsToPeriod(rows, "all", NOW)).toHaveLength(1);
    expect(scopeSessionsToPeriod(rows, "month", NOW)).toHaveLength(0);
  });
});
