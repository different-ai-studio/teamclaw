export type ActorType = "member" | "agent" | "external";

export type Actor = {
  actorId: string;
  teamId: string;
  actorType: ActorType;
  displayName: string;
  role: string | null;
  lastActiveAt: string | null;
  avatarUrl: string | null;
  /** Supported backend types for agents, e.g. ["claude", "opencode"]. */
  agentTypes: string[];
  /** Default backend type for agents. */
  defaultAgentType: string | null;
  /** Default workspace id for agents, when configured by the native/admin flow. */
  defaultWorkspaceId?: string | null;
  /** Member actor that owns this agent, used to gate owner-only management. */
  ownerMemberId?: string | null;
  /** Agent visibility in the team directory. */
  visibility?: "team" | "personal" | null;
  /** Deprecated UI alias: defaultAgentType ?? agentTypes[0]. */
  agentKind: string | null;
  /** `active` | `invited` | … for members; null for agents. */
  memberStatus?: string | null;
  /** Daemon-reported lifecycle status for agents; null for members. */
  agentStatus?: string | null;
  /**
   * Member contact, from the actor_directory view's SECURITY DEFINER contact
   * join — only teammates ever receive these, and both are null for agents and
   * for anonymous accounts that never set one.
   */
  email?: string | null;
  phone?: string | null;
  /** When the actor row was created — the "Joined" line on actor detail. */
  createdAt?: string | null;
};

export type ActorsListState = {
  status: "idle" | "loading" | "error" | "ready";
  actors: Actor[];
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
};

export const initialActorsListState: ActorsListState = {
  status: "idle",
  actors: [],
  isLoading: false,
  isRefreshing: false,
  errorMessage: null,
};

/**
 * Time window the iOS app uses to call an actor "online" — five minutes
 * since their last heartbeat. Used to drive breathing dots and online
 * counts in the Actors row.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export function isActorOnline(actor: Actor, now: number = Date.now()): boolean {
  if (!actor.lastActiveAt) return false;
  const last = Date.parse(actor.lastActiveAt);
  if (Number.isNaN(last)) return false;
  return now - last < ONLINE_WINDOW_MS;
}

export function isMemberActor(actor: Actor): boolean {
  return actor.actorType === "member";
}

export function isAgentActor(actor: Actor): boolean {
  return actor.actorType === "agent";
}
