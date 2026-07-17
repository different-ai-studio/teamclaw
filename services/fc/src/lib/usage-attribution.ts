// Rolls raw per-key LiteLLM usage up to the HUMAN who is accountable for it.
//
// Why this exists: tokens are burned by daemons, not people. A daemon runs as
// an `agent` actor with its own LiteLLM key, so ungrouped usage reports read as
// a list of machines. The human behind an agent is `amux.agents.owner_member_id`
// (NOT NULL, and NOT a column on `actors` — there is no creator/owner field
// there; `invited_by_actor_id` is invite provenance and means something else).
//
// Keys whose owner cannot be resolved are folded into ONE unattributed bucket
// rather than dropped. They represent real spend, and silently omitting them
// would make the per-member rows fail to sum to the team total.

import type { MemberUsage } from "./litellm-usage.js";

/** A resolved accountable human. */
export type UsageOwner = {
  /** Human (member-type) actor uuid. */
  actorId: string;
  displayName: string;
};

/**
 * Resolve spending actor ids to the humans accountable for them.
 *
 * Implemented per-repo (pg via Drizzle, supabase via PostgREST) because each
 * has its own handle on the amux database. Contract:
 *  - input: actor ids taken from LiteLLM key `user_id`s — arbitrary strings
 *    from an external system, NOT guaranteed to be uuids or to exist.
 *  - output: only the ids that resolved. Omitting an id is how a resolver says
 *    "unknown"; it must NOT throw for unknown or malformed ids.
 *  - `member` actors resolve to themselves; `agent` actors to their owner.
 */
export type ResolveUsageOwners = (actorIds: string[]) => Promise<Map<string, UsageOwner>>;

export type AttributedUsage = {
  /** Owning human actor uuid; null = unattributed bucket. */
  actorId: string | null;
  /** null when unattributed — the client renders its own localized label. */
  displayName: string | null;
  tokens: number;
  spend: number;
  requests: number;
};

/**
 * Fold per-key usage into one row per accountable human.
 *
 * Several keys can map to one human (their own member key, plus a key for each
 * daemon they own), so rows are merged, not just relabelled.
 *
 * Never throws on resolution failure: attribution is a reporting concern, and a
 * usage screen that 500s is worse than one that says "unattributed".
 */
export async function rollUpUsageByOwner(
  members: MemberUsage[],
  resolve: ResolveUsageOwners,
): Promise<AttributedUsage[]> {
  const ids = [...new Set(members.map((m) => m.actorId).filter((id): id is string => !!id))];

  let owners = new Map<string, UsageOwner>();
  if (ids.length) {
    try {
      owners = await resolve(ids);
    } catch (e) {
      // Everything falls into "unattributed" — degraded, but the totals and the
      // model breakdown still render.
      console.warn("[rollUpUsageByOwner] owner resolution failed:", (e as any)?.message);
    }
  }

  // null key = the unattributed bucket.
  const byOwner = new Map<string | null, AttributedUsage>();
  for (const m of members) {
    const owner = m.actorId ? owners.get(m.actorId) : undefined;
    const key = owner?.actorId ?? null;
    let row = byOwner.get(key);
    if (!row) {
      row = {
        actorId: owner?.actorId ?? null,
        displayName: owner?.displayName ?? null,
        tokens: 0,
        spend: 0,
        requests: 0,
      };
      byOwner.set(key, row);
    }
    row.tokens += m.tokens;
    row.spend += m.spend;
    row.requests += m.requests;
  }

  return [...byOwner.values()].sort((a, b) => {
    // Unattributed sinks to the bottom regardless of size: it's a data-quality
    // notice, not a leaderboard entry, and topping the chart would be a lie.
    if ((a.actorId === null) !== (b.actorId === null)) return a.actorId === null ? 1 : -1;
    return b.spend - a.spend || b.tokens - a.tokens;
  });
}
