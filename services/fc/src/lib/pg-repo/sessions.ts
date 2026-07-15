/**
 * Sessions + Participants domain — pg-repo implementation.
 *
 * Authz strategy:
 *  - listSessions accepts an explicit actorId (participant filter) or resolves
 *    from ctx.userId + teamId. This mirrors the Supabase RPC
 *    list_current_actor_sessions SECURITY DEFINER pattern.
 *  - markSessionViewed accepts explicit actorId or resolves from ctx.
 *  - createSession ALWAYS resolves createdByActorId server-side from
 *    ctx.userId + teamId (requireActorForTeam, team-scoped); any
 *    client-supplied createdByActorId is ignored. Matches sessions INSERT RLS
 *    (created_by = current actor for team) so multi-team callers can't send a
 *    stale/other-team actor id and trip the RLS WITH CHECK.
 *
 * RPC replacements:
 *  - list_current_actor_sessions   → listSessions (Drizzle join on participants)
 *  - mark_current_actor_session_viewed → markSessionViewed (upsert read marker)
 *  - ensure_gateway_session        → ensureGatewaySession (get-or-create on binding)
 */

import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  sessions,
  sessionParticipants,
  sessionReadMarkers,
  actors,
  agentMemberAccess,
  teams,
  teamMembers,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, resolveActorForTeam } from "./authz.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

export interface SessionsRepoDeps {
  /** Called after a successful markSessionViewed DB write. Best-effort: errors are
   *  logged and swallowed so the mark-viewed outcome is never affected. */
  publishReadEvent?: (args: { userId: string; sessionId: string }) => Promise<void>;
}

interface SessionsCtx {
  userId?: string;
}

function mapSession(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    title: r.title ?? "",
    mode: r.mode ?? "solo",
    ideaId: r.ideaId ?? null,
    lastMessageAt: iso(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview ?? null,
    hasUnread: r.hasUnread === true,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

function mapSessionFull(r: any, participants: any[] = []) {
  return {
    id: r.id,
    teamId: r.teamId,
    title: r.title ?? "",
    mode: r.mode ?? "solo",
    ideaId: r.ideaId ?? null,
    primaryAgentId: r.primaryAgentId ?? null,
    createdByActorId: r.createdByActorId ?? null,
    summary: r.summary ?? null,
    lastMessageAt: iso(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview ?? null,
    hasUnread: false,
    acpSessionId: r.acpSessionId ?? null,
    binding: r.binding ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    participants,
  };
}

function mapParticipant(r: any) {
  return {
    sessionId: r.sessionId,
    actorId: r.actorId,
    role: r.role ?? null,
    joinedAt: iso(r.joinedAt),
  };
}

// ── Sync wire shapes (snake_case) ──────────────────────────────────────────
// Consumed directly by the desktop client's lib/sync/* (no client-side mapper),
// so these must match supabase-repo's sync SELECT columns exactly.
function mapSessionSyncRow(r: any) {
  return {
    id: r.id,
    team_id: r.teamId,
    title: r.title ?? null,
    mode: r.mode ?? null,
    primary_agent_id: r.primaryAgentId ?? null,
    idea_id: r.ideaId ?? null,
    summary: r.summary ?? null,
    last_message_preview: r.lastMessagePreview ?? null,
    last_message_at: iso(r.lastMessageAt),
    created_by_actor_id: r.createdByActorId ?? null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function mapSessionParticipantSyncRow(r: any) {
  return {
    id: r.id,
    session_id: r.sessionId,
    actor_id: r.actorId,
    joined_at: iso(r.joinedAt),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

export function makeSessionsRepo(db: DbLike, ctx: SessionsCtx = {}, deps: SessionsRepoDeps = {}) {
  // Resolve every actor id that belongs to the authenticated user (one per team).
  // Mirrors `app.current_actor_id()` semantics but across ALL the user's actors
  // rather than just the globally-oldest one — fixing the multi-team blind spot.
  async function resolveActorIdsForUser(userId: string): Promise<string[]> {
    const rows = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.userId, userId));
    return rows.map((r: any) => r.id).filter(Boolean);
  }

  return {
    // ── List sessions (participant-filtered) ──────────────────────────────────
    /**
     * AUTHZ (#10): lists the CURRENT ACTOR's sessions, resolved from ctx.userId.
     * The GET /v1/sessions route supplies neither teamId nor actorId, matching
     * the Supabase RPC `list_current_actor_sessions` (no team filter, scoped to
     * the authenticated user's participating sessions across all their teams).
     *
     * A client-supplied actorId is NEVER trusted. teamId is optional: when given
     * it narrows the result to that team (still scoped to the user's actors).
     * When no identity is available the result is empty (fail closed) — an
     * unauthenticated caller sees nothing rather than every team's sessions.
     */
    async listSessions({
      teamId,
      limit = 50,
      cursor = null,
    }: {
      teamId?: string;
      limit?: number;
      cursor?: { lastMessageAt?: string | null; createdAt?: string; id?: string } | null;
    } = {}) {
      // Resolve the caller's actor ids from the authenticated user.
      const actorIds = ctx.userId ? await resolveActorIdsForUser(ctx.userId) : [];
      if (actorIds.length === 0) {
        // No identity / no actors → no visible sessions (fail closed).
        return [];
      }

      // Participant filter: any of the user's actors participates in the session.
      const participantFilter = sql`EXISTS (
            SELECT 1 FROM session_participants sp
            WHERE sp.session_id = sessions.id
              AND sp.actor_id IN (${sql.join(actorIds, sql`, `)})
          )`;

      // Optional team narrowing (scoped to the user's actors regardless).
      const teamFilter = teamId ? sql`sessions.team_id = ${teamId}` : sql`TRUE`;

      let cursorFilter = sql`TRUE`;
      if (cursor) {
        const cursorCreatedAt = cursor.createdAt ? new Date(cursor.createdAt) : null;
        if (cursor.lastMessageAt != null) {
          const cursorLastMessageAt = new Date(cursor.lastMessageAt);
          cursorFilter = sql`(
            sessions.last_message_at < ${cursorLastMessageAt}
            OR sessions.last_message_at IS NULL
            OR (sessions.last_message_at = ${cursorLastMessageAt} AND sessions.created_at < ${cursorCreatedAt})
            OR (sessions.last_message_at = ${cursorLastMessageAt} AND sessions.created_at = ${cursorCreatedAt} AND sessions.id < ${cursor.id ?? null})
          )`;
        } else {
          cursorFilter = sql`(
            sessions.last_message_at IS NULL
            AND (
              sessions.created_at < ${cursorCreatedAt}
              OR (sessions.created_at = ${cursorCreatedAt} AND sessions.id < ${cursor.id ?? null})
            )
          )`;
        }
      }

      // Read markers for any of the user's actors (to compute hasUnread).
      const readMarkerSubq = sql`(
            SELECT MAX(srm.last_read_at) FROM session_read_markers srm
            WHERE srm.session_id = sessions.id
              AND srm.actor_id IN (${sql.join(actorIds, sql`, `)})
          )`;

      const rows = await (db as any).execute(sql`
        SELECT
          sessions.id,
          sessions.team_id AS "teamId",
          sessions.idea_id AS "ideaId",
          sessions.mode,
          sessions.title,
          sessions.last_message_preview AS "lastMessagePreview",
          sessions.last_message_at AS "lastMessageAt",
          sessions.created_at AS "createdAt",
          sessions.updated_at AS "updatedAt",
          CASE
            WHEN sessions.last_message_at IS NULL THEN FALSE
            WHEN (${readMarkerSubq}) IS NULL THEN TRUE
            WHEN (${readMarkerSubq}) < sessions.last_message_at THEN TRUE
            ELSE FALSE
          END AS "hasUnread"
        FROM sessions
        WHERE (${teamFilter})
          AND (${participantFilter})
          AND (${cursorFilter})
        ORDER BY
          sessions.last_message_at DESC NULLS LAST,
          sessions.created_at DESC,
          sessions.id DESC
        LIMIT ${limit}
      `);

      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return result.map((r: any) => ({
        id: r.id,
        teamId: r.teamId,
        title: r.title ?? "",
        mode: r.mode ?? "solo",
        ideaId: r.ideaId ?? null,
        lastMessageAt: iso(r.lastMessageAt),
        lastMessagePreview: r.lastMessagePreview ?? null,
        hasUnread: r.hasUnread === true,
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
      }));
    },

    // ── getSession ────────────────────────────────────────────────────────────
    async getSession(sessionId: string) {
      const [r] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!r) return null;
      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── joinSession (self-join via share link) ────────────────────────────────
    /**
     * AUTHZ: adds the AUTHENTICATED caller (resolved from ctx.userId in the
     * session's team) as a participant. Idempotent. Fails closed:
     *  - 401 when there is no authenticated user.
     *  - 404 when the session does not exist.
     *  - 403 when the caller has no actor in the session's team.
     */
    async joinSession(sessionId: string) {
      if (!ctx.userId) {
        throw new ApiError(401, "missing_auth", "cannot resolve actor for join");
      }
      const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!s) throw new ApiError(404, "not_found", "session not found");

      const actorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
      if (!actorId) {
        throw new ApiError(403, "forbidden", "not a member of this session's team");
      }

      await (db.insert(sessionParticipants) as any)
        .values({ sessionId, actorId, role: "member" })
        .onConflictDoNothing();

      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(s, parts.map(mapParticipant));
    },

    // ── createSession ─────────────────────────────────────────────────────────
    async createSession(input: {
      id?: string;
      teamId: string;
      title: string;
      mode?: string;
      ideaId?: string | null;
      createdByActorId?: string;
      primaryAgentId?: string;
      appId?: string | null;
      participantActorIds?: string[];
      additionalActorIds?: string[];
    }) {
      const id = input.id ?? crypto.randomUUID();
      // AUTHZ: created_by is ALWAYS resolved server-side from the authenticated
      // caller scoped to the target team (requireActorForTeam is team-scoped),
      // never from the client-supplied input.createdByActorId. A multi-team
      // user's client can send the wrong team's actor id (stale current-team
      // value); ignoring it keeps parity with supabase-repo and matches the
      // sessions INSERT RLS WITH CHECK (created_by = current actor for team).
      let createdByActorId: string | undefined;
      if (ctx.userId) {
        createdByActorId = await requireActorForTeam(db, ctx.userId, input.teamId);
      }
      const insertRow: any = {
        id,
        teamId: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        ideaId: input.ideaId ?? null,
      };
      if (createdByActorId) insertRow.createdByActorId = createdByActorId;
      if (input.primaryAgentId) insertRow.primaryAgentId = input.primaryAgentId;
      if (input.appId) insertRow.appId = input.appId;

      const [r] = await (db.insert(sessions) as any).values(insertRow).returning();

      // Bootstrap participants
      const participantIds = Array.from(
        new Set(
          [
            createdByActorId,
            ...(input.participantActorIds ?? []),
            ...(input.additionalActorIds ?? []),
          ].filter((x): x is string => typeof x === "string" && x.length > 0),
        ),
      );

      let parts: any[] = [];
      if (participantIds.length > 0) {
        parts = await (db.insert(sessionParticipants) as any)
          .values(participantIds.map((actorId) => ({ sessionId: id, actorId })))
          .onConflictDoNothing()
          .returning();
      }

      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── patchSession ──────────────────────────────────────────────────────────
    async patchSession(sessionId: string, patch: { title?: string; summary?: string; mode?: string; archivedAt?: string | null }) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.title !== undefined) updates.title = patch.title;
      if (patch.summary !== undefined) updates.summary = patch.summary;
      if (patch.mode !== undefined) updates.mode = patch.mode;

      const [r] = await (db.update(sessions) as any)
        .set(updates)
        .where(eq(sessions.id, sessionId))
        .returning();
      if (!r) return null;

      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── getSessionByAcp ───────────────────────────────────────────────────────
    async getSessionByAcp(acpSessionId: string) {
      const [r] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.acpSessionId, acpSessionId))
        .limit(1);
      if (!r) return null;
      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, r.id));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── markSessionViewed ─────────────────────────────────────────────────────
    /**
     * AUTHZ (#10): the read marker's actor is ALWAYS resolved server-side from
     * ctx.userId + the session's team — never from a client-supplied actor — so a
     * caller cannot mark a session read on behalf of someone else.
     *
     * Signature matches the Supabase backend: (sessionId, lastReadMessageId).
     * The optional 2nd-positional explicit actorId is reserved for trusted
     * server/gateway callers that operate WITHOUT an authenticated user
     * (ctx.userId absent); pass it as `{ actorId }`. The route never does.
     *
     * Fails CLOSED: with an authenticated user but no actor in the session's team
     * (or a missing session) it throws 403/404 rather than silently no-opping. A
     * call with neither ctx.userId nor a trusted actorId throws 401.
     */
    async markSessionViewed(
      sessionId: string,
      lastReadMessageId?: string | null,
      trusted?: { actorId?: string | null },
    ) {
      let resolvedActorId: string | null = null;

      if (ctx.userId) {
        // Authenticated path — resolve from the session's team. Authoritative.
        const [s] = await db.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (!s) throw new ApiError(404, "not_found", "session not found");
        resolvedActorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
        if (!resolvedActorId) {
          throw new ApiError(403, "forbidden", "not a member of this session's team");
        }
      } else if (trusted?.actorId) {
        // Trusted server/gateway caller (no JWT) — accept the explicit actor.
        resolvedActorId = trusted.actorId;
      } else {
        // No identity at all — fail closed.
        throw new ApiError(401, "missing_auth", "cannot resolve actor for mark-viewed");
      }

      await (db.insert(sessionReadMarkers) as any)
        .values({
          sessionId,
          actorId: resolvedActorId,
          lastReadAt: new Date(),
          lastReadMessageId: lastReadMessageId ?? null,
        })
        .onConflictDoUpdate({
          target: [sessionReadMarkers.sessionId, sessionReadMarkers.actorId],
          set: {
            lastReadAt: new Date(),
            lastReadMessageId: lastReadMessageId ?? null,
            updatedAt: new Date(),
          },
        });

      if (deps.publishReadEvent && ctx.userId) {
        deps.publishReadEvent({ userId: ctx.userId, sessionId }).catch((err: unknown) => {
          console.error("[markSessionViewed] publishReadEvent failed (best-effort):", err);
        });
      }
    },

    /**
     * Mark a session unread for the calling actor by deleting their read
     * marker, so the session re-derives as unread. Actor resolution + fail-closed
     * semantics mirror markSessionViewed.
     */
    async markSessionUnread(sessionId: string, trusted?: { actorId?: string | null }) {
      let resolvedActorId: string | null = null;

      if (ctx.userId) {
        const [s] = await db
          .select({ teamId: sessions.teamId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!s) throw new ApiError(404, "not_found", "session not found");
        resolvedActorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
        if (!resolvedActorId) {
          throw new ApiError(403, "forbidden", "not a member of this session's team");
        }
      } else if (trusted?.actorId) {
        resolvedActorId = trusted.actorId;
      } else {
        throw new ApiError(401, "missing_auth", "cannot resolve actor for mark-unread");
      }

      await db
        .delete(sessionReadMarkers)
        .where(
          and(
            eq(sessionReadMarkers.sessionId, sessionId),
            eq(sessionReadMarkers.actorId, resolvedActorId),
          ),
        );
    },

    // ── ensureGatewaySession ──────────────────────────────────────────────────
    /**
     * Idempotent get-or-create on the (teamId, binding) unique key.
     * Returns { sessionId, gatewaySessionId, created }.
     * gatewaySessionId = the binding string (acts as the external gateway session id).
     */
    async ensureGatewaySession(input: {
      teamId: string;
      binding: string;
      title: string;
      primaryAgentActorId: string;
      ownerMemberActorIds: string[];
      participantActorIds: string[];
    }) {
      // Try to find existing session by binding
      const [existing] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.teamId, input.teamId), eq(sessions.binding, input.binding)))
        .limit(1);

      if (existing) {
        return {
          sessionId: existing.id,
          gatewaySessionId: existing.binding ?? existing.id,
          acpSessionId: existing.acpSessionId ?? null,
          created: false,
        };
      }

      // Create new session with binding
      const id = crypto.randomUUID();
      const [r] = await (db.insert(sessions) as any)
        .values({
          id,
          teamId: input.teamId,
          title: input.title,
          mode: "gateway",
          primaryAgentId: input.primaryAgentActorId,
          createdByActorId: input.primaryAgentActorId,
          binding: input.binding,
        })
        .returning();

      // Bootstrap participants: primary agent + owner members + participants
      const participantIds = Array.from(
        new Set([
          input.primaryAgentActorId,
          ...input.ownerMemberActorIds,
          ...input.participantActorIds,
        ].filter((x): x is string => typeof x === "string" && x.length > 0)),
      );

      if (participantIds.length > 0) {
        await (db.insert(sessionParticipants) as any)
          .values(participantIds.map((actorId) => ({ sessionId: id, actorId })))
          .onConflictDoNothing();
      }

      return {
        sessionId: r.id,
        gatewaySessionId: r.binding ?? r.id,
        acpSessionId: r.acpSessionId ?? null,
        created: true,
      };
    },

    // ── createCronSession ─────────────────────────────────────────────────────
    async createCronSession(input: {
      id?: string;
      teamId: string;
      primaryAgentActorId: string;
      title: string;
      createdByActorId?: string;
    }) {
      const id = input.id ?? crypto.randomUUID();
      const [r] = await (db.insert(sessions) as any)
        .values({
          id,
          teamId: input.teamId,
          title: input.title,
          mode: "collab",
          primaryAgentId: input.primaryAgentActorId,
          createdByActorId: input.createdByActorId ?? input.primaryAgentActorId,
        })
        .returning();

      // Bootstrap primary agent as participant
      await (db.insert(sessionParticipants) as any)
        .values([{ sessionId: id, actorId: input.primaryAgentActorId }])
        .onConflictDoNothing();

      // Mirror gateway sessions: add human admins so desktop "查看对话" works
      // under sessions_select_if_participant_or_creator RLS.
      const adminRows = await db
        .select({ memberId: agentMemberAccess.memberId })
        .from(agentMemberAccess)
        .where(
          and(
            eq(agentMemberAccess.agentId, input.primaryAgentActorId),
            eq(agentMemberAccess.permissionLevel, "admin"),
          ),
        );
      if (adminRows.length > 0) {
        await (db.insert(sessionParticipants) as any)
          .values(
            adminRows.map((row) => ({
              sessionId: id,
              actorId: row.memberId,
            })),
          )
          .onConflictDoNothing();
      }

      return { sessionId: r.id, ...mapSessionFull(r, []) };
    },

    // ── listTeamSessionsFull ──────────────────────────────────────────────────
    async listTeamSessionsFull(teamId: string) {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.teamId, teamId))
        .orderBy(desc(sessions.lastMessageAt));

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const partRows = await db
        .select({ sessionId: sessionParticipants.sessionId })
        .from(sessionParticipants)
        .where(inArray(sessionParticipants.sessionId, ids));

      const counts: Record<string, number> = {};
      for (const p of partRows) {
        counts[p.sessionId] = (counts[p.sessionId] ?? 0) + 1;
      }

      return rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        title: r.title ?? "",
        mode: r.mode ?? "solo",
        ideaId: r.ideaId ?? null,
        primaryAgentId: r.primaryAgentId ?? null,
        createdByActorId: r.createdByActorId ?? null,
        summary: r.summary ?? null,
        lastMessageAt: iso(r.lastMessageAt),
        lastMessagePreview: r.lastMessagePreview ?? null,
        participantCount: counts[r.id] ?? 0,
        hasUnread: false,
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
      }));
    },

    // ── getMeBootstrap ────────────────────────────────────────────────────────
    /**
     * AUTHZ: /me bootstrap fast-path. Identity is taken strictly from ctx.userId
     * (no RLS under postgres). Mirrors the Supabase impl which resolves the
     * caller's `member` actors, then their team memberships joined to teams.
     * Returns the caller's primary member actor id, their teams, and a
     * per-team member actor id map. Fail-closed to empty when unauthenticated.
     */
    async getMeBootstrap() {
      const userId = ctx.userId;
      if (!userId) {
        throw new ApiError(401, "unauthorized", "no authenticated user");
      }
      const actorRows = await db
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.userId, userId), eq(actors.actorType, "member")));
      const actorIds = actorRows.map((r: any) => r.id).filter(Boolean);
      if (actorIds.length === 0) {
        return { memberActorId: null, teams: [] as any[], memberActorIdByTeam: {} as Record<string, string> };
      }
      const memberRows = await db
        .select({
          role: teamMembers.role,
          memberId: teamMembers.memberId,
          teamId: teams.id,
          teamName: teams.name,
          teamSlug: teams.slug,
        })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(inArray(teamMembers.memberId, actorIds));

      const seenTeam = new Map<string, { id: string; name: string; slug: string; role: string }>();
      const memberByTeam: Record<string, string> = {};
      for (const m of memberRows) {
        if (!m.teamId) continue;
        if (!seenTeam.has(m.teamId)) {
          seenTeam.set(m.teamId, { id: m.teamId, name: m.teamName, slug: m.teamSlug, role: m.role });
        }
        memberByTeam[m.teamId] = m.memberId;
      }
      const teamsOut = Array.from(seenTeam.values());
      const primary = teamsOut[0] ? memberByTeam[teamsOut[0].id] : null;
      return {
        memberActorId: primary ?? null,
        teams: teamsOut,
        memberActorIdByTeam: memberByTeam,
      };
    },

    // ── listSessionsForTeamSince ──────────────────────────────────────────────
    async listSessionsForTeamSince(teamId: string, updatedAfter: string | null) {
      const rows = updatedAfter
        ? await db
            .select()
            .from(sessions)
            .where(and(eq(sessions.teamId, teamId), gt(sessions.updatedAt, new Date(updatedAfter))))
        : await db.select().from(sessions).where(eq(sessions.teamId, teamId));
      return rows.map(mapSessionSyncRow);
    },

    // ── listSessionDisplayRows ────────────────────────────────────────────────
    async listSessionDisplayRows(teamId: string, sessionIds: string[]) {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
      const rows = await db
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(and(eq(sessions.teamId, teamId), inArray(sessions.id, sessionIds)));
      return rows;
    },

    // ── listSessionIdsForActor ────────────────────────────────────────────────
    async listSessionIdsForActor(actorId: string) {
      const rows = await db
        .select({ sessionId: sessionParticipants.sessionId })
        .from(sessionParticipants)
        .where(eq(sessionParticipants.actorId, actorId));
      return rows.map((r) => r.sessionId).filter(Boolean);
    },

    // ── listSessionParticipants ───────────────────────────────────────────────
    async listSessionParticipants(sessionId: string) {
      const rows = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return { items: rows.map(mapParticipant) };
    },

    // ── upsertSessionParticipant ──────────────────────────────────────────────
    async upsertSessionParticipant(
      sessionId: string,
      input: { actorId: string; role?: string | null },
    ) {
      const row: any = { sessionId, actorId: input.actorId };
      if (input.role !== undefined) row.role = input.role;

      const [r] = await (db.insert(sessionParticipants) as any)
        .values(row)
        .onConflictDoUpdate({
          target: [sessionParticipants.sessionId, sessionParticipants.actorId],
          set: {
            role: input.role ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();

      return {
        sessionId: r.sessionId,
        actorId: r.actorId,
        role: r.role ?? null,
        joinedAt: iso(r.joinedAt),
      };
    },

    // ── removeSessionParticipant ──────────────────────────────────────────────
    async removeSessionParticipant(sessionId: string, actorId: string) {
      await (db.delete(sessionParticipants) as any)
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.actorId, actorId),
          ),
        );
    },

    // ── listSessionParticipantsForSync ────────────────────────────────────────
    async listSessionParticipantsForSync(sessionId: string, updatedAfter: string | null) {
      const rows = updatedAfter
        ? await db
            .select()
            .from(sessionParticipants)
            .where(
              and(
                eq(sessionParticipants.sessionId, sessionId),
                gt(sessionParticipants.updatedAt, new Date(updatedAfter)),
              ),
            )
        : await db.select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, sessionId));
      return rows.map(mapSessionParticipantSyncRow);
    },
  };
}
