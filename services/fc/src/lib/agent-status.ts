/**
 * Which agents belong in an agent LIST.
 *
 * `amux.agents.status` is `'active' | 'disabled' | 'archived'` (NOT NULL, CHECK
 * constrained). Retiring an agent by flipping that column used to be a no-op
 * for the product: every directory query selected on team + agent visibility
 * only, so a disabled or archived agent kept showing up in the sidebar, the
 * @-mention popover, the new-session picker and the connected-agents screen.
 * The single place that already respected the column was device binding
 * (`findAgentForDevice` / `ensureAgentForDevice` both require 'active'), so a
 * retired agent was simultaneously "not this machine's agent" and "still in
 * every list". These helpers close that gap.
 *
 * Deliberately permissive about unknown values: only a status we positively
 * recognise as retired hides a row. A null/absent status (every non-agent
 * actor, plus cached client rows written before the column was carried) stays
 * visible, so a mapping gap can never blank out a team's agent list.
 *
 * Listing endpoints filter; resolution endpoints must NOT. A retired agent
 * still authored messages and still sits in old sessions, so
 * `listActorDirectoryByIds`, `getActor` and the sync feed keep returning it —
 * otherwise historical messages lose their author name, and clients never
 * learn that the agent was retired.
 */

/** Statuses that keep an agent out of the lists. */
export const RETIRED_AGENT_STATUSES = ["disabled", "archived"] as const;

/** True when an agent with this status belongs in a list. */
export function isListableAgentStatus(status: string | null | undefined): boolean {
  if (status == null) return true;
  return !(RETIRED_AGENT_STATUSES as readonly string[]).includes(status);
}

/**
 * The same rule as a PostgREST `.or(...)` argument, for queries against the
 * `actor_directory` view. Members carry `agent_status = null` and pass through
 * the first term.
 */
// The retired checks must be AND-ed with each other and only then OR-ed with
// the null case: a flat `or(is.null, neq.disabled, neq.archived)` would let a
// 'disabled' row through on the `neq.archived` term.
export const LISTABLE_AGENT_STATUS_OR_FILTER =
  `agent_status.is.null,and(${RETIRED_AGENT_STATUSES.map((s) => `agent_status.neq.${s}`).join(",")})`;
