import type { Actor } from "../actors/actor-types";
import { isActorOnline } from "../actors/actor-types";
import type { Idea } from "./idea-types";
import { t } from "../../lib/i18n";

/**
 * Team-wide idea aggregation behind the Idea Statistics sheet, ported from the
 * iOS `IdeaStatsSheet`. Every number is computed from real idea rows (active +
 * archived) filtered by `createdAt` against the selected period.
 */

export type StatsPeriod = "today" | "week" | "month" | "all";

export const STATS_PERIODS: ReadonlyArray<{ value: StatsPeriod; label: string }> = [
  { value: "today", label: t("Today") },
  { value: "week", label: t("Week") },
  { value: "month", label: t("Month") },
  { value: "all", label: t("All") },
];

/** Epoch millis before which rows are excluded, or null for "all time". */
export function periodCutoff(period: StatsPeriod, now: number = Date.now()): number | null {
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    case "week":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "month":
      return now - 30 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
}

export type ContributorStat = {
  actorId: string;
  name: string;
  isAgent: boolean;
  isOnline: boolean;
  count: number;
};

export type WorkspaceStat = {
  id: string;
  name: string;
  count: number;
};

export type IdeaStats = {
  total: number;
  open: number;
  done: number;
  contributors: ContributorStat[];
  workspaces: WorkspaceStat[];
};

const UNASSIGNED_WORKSPACE_ID = "_unassigned";

/** Rows created within the period. Unparseable timestamps are kept, not dropped. */
export function scopeIdeasToPeriod(
  ideas: ReadonlyArray<Idea>,
  period: StatsPeriod,
  now: number = Date.now(),
): Idea[] {
  const cutoff = periodCutoff(period, now);
  if (cutoff === null) return [...ideas];
  return ideas.filter((idea) => {
    const created = Date.parse(idea.createdAt);
    return Number.isFinite(created) ? created >= cutoff : true;
  });
}

export function buildIdeaStats(args: {
  ideas: ReadonlyArray<Idea>;
  actors: ReadonlyArray<Actor>;
  period: StatsPeriod;
  now?: number;
}): IdeaStats {
  const now = args.now ?? Date.now();
  const scoped = scopeIdeasToPeriod(args.ideas, args.period, now);
  const actorById = new Map(args.actors.map((actor) => [actor.actorId, actor]));

  const byContributor = new Map<string, number>();
  const byWorkspace = new Map<string, { name: string; count: number }>();
  for (const idea of scoped) {
    const actorId = idea.createdByActorId ?? "";
    byContributor.set(actorId, (byContributor.get(actorId) ?? 0) + 1);

    const workspaceId = idea.workspaceId ?? "";
    const key = workspaceId || UNASSIGNED_WORKSPACE_ID;
    const existing = byWorkspace.get(key);
    byWorkspace.set(key, {
      name: workspaceId ? idea.workspaceName ?? t("Workspace") : t("Unassigned"),
      count: (existing?.count ?? 0) + 1,
    });
  }

  const contributors: ContributorStat[] = [...byContributor.entries()]
    .map(([actorId, count]) => {
      const actor = actorById.get(actorId);
      return {
        actorId,
        name: actor?.displayName ?? t("Unknown"),
        isAgent: actor?.actorType === "agent",
        isOnline: actor ? isActorOnline(actor, now) : false,
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const workspaces: WorkspaceStat[] = [...byWorkspace.entries()]
    .map(([id, value]) => ({ id, name: value.name, count: value.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    total: scoped.length,
    // "Open" deliberately counts in-progress too: the card answers "how much is
    // still live", and a split of open vs in_progress belongs on the list.
    open: scoped.filter((idea) => idea.status === "open" || idea.status === "in_progress")
      .length,
    done: scoped.filter((idea) => idea.status === "done").length,
    contributors,
    workspaces,
  };
}
