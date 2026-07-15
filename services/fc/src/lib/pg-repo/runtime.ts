/**
 * Runtime domain — pg-repo implementation.
 *
 * Covers all agent_runtimes operations: upsert, get, list, cursor/model
 * updates, heartbeat probe.
 *
 * Natural upsert key: (agent_id, backend_session_id) — mirrors the Supabase
 * unique index agent_runtimes_agent_backend_uniq (migration 202604220027).
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, agentRuntimes, teams } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface RuntimeCtx {
  userId?: string;
  callerActorId?: string;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

function mapRow(row: typeof agentRuntimes.$inferSelect) {
  return {
    id: row.id,
    teamId: row.teamId,
    agentId: row.agentId,
    sessionId: row.sessionId ?? null,
    workspaceId: row.workspaceId ?? null,
    backendType: row.backendType,
    status: row.status,
    backendSessionId: row.backendSessionId ?? null,
    runtimeId: row.runtimeId ?? null,
    currentModel: row.currentModel ?? null,
    lastSeenAt: iso(row.lastSeenAt),
    lastProcessedMessageId: row.lastProcessedMessageId ?? null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function makeRuntimeRepo(db: DbLike, ctx: RuntimeCtx = {}) {
  return {
    /**
     * Upserts an agent runtime row. Derives teamId from the agent actor row
     * when the caller omits it (daemon use-case).
     *
     * Natural key: (agentId, backendSessionId).
     */
    async upsertAgentRuntime(body: {
      agentActorId: string;
      sessionId?: string | null;
      runtimeId?: string | null;
      backendSessionId?: string | null;
      teamId?: string | null;
      backendType?: string | null;
      status?: string | null;
      workspaceId?: string | null;
      currentModel?: string | null;
      id?: string | null;
    }) {
      let teamId = body.teamId ?? null;
      if (!teamId) {
        const [actorRow] = await db
          .select({ teamId: actors.teamId })
          .from(actors)
          .where(eq(actors.id, body.agentActorId))
          .limit(1);
        teamId = actorRow?.teamId ?? null;
      }
      if (!teamId) {
        throw new ApiError(
          400,
          "missing_team",
          "Unable to resolve team_id for agent runtime: agent actor not found or not visible",
        );
      }

      const now = new Date();
      const row = {
        id: body.id ?? undefined,
        teamId,
        agentId: body.agentActorId,
        sessionId: body.sessionId ?? null,
        runtimeId: body.runtimeId ?? null,
        backendType: body.backendType ?? "claude",
        backendSessionId: body.backendSessionId ?? null,
        status: body.status ?? "running",
        workspaceId: body.workspaceId ?? null,
        currentModel: body.currentModel ?? null,
        updatedAt: now,
      } as typeof agentRuntimes.$inferInsert;

      // Postgres NULL ≠ NULL in unique indexes, so when backendSessionId is null
      // (daemon runtimes) ON CONFLICT never fires → unbounded duplicate rows.
      // Fix: when backendSessionId is null, perform a manual SELECT + UPDATE/INSERT.
      if ((body.backendSessionId ?? null) == null) {
        const updateSet = {
          sessionId: body.sessionId ?? null,
          runtimeId: body.runtimeId ?? null,
          backendType: body.backendType ?? "claude",
          status: body.status ?? "running",
          workspaceId: body.workspaceId ?? null,
          currentModel: body.currentModel ?? null,
          updatedAt: now,
        };

        const [existing] = await db
          .select({ id: agentRuntimes.id })
          .from(agentRuntimes)
          .where(
            and(
              eq(agentRuntimes.agentId, body.agentActorId),
              isNull(agentRuntimes.backendSessionId),
            ),
          )
          .limit(1);

        if (existing) {
          await (db as any)
            .update(agentRuntimes)
            .set(updateSet)
            .where(eq(agentRuntimes.id, existing.id));
          return { id: existing.id };
        } else {
          const [inserted] = await (db as any)
            .insert(agentRuntimes)
            .values(row)
            .returning({ id: agentRuntimes.id });
          return { id: inserted?.id ?? null };
        }
      }

      const [inserted] = await (db as any)
        .insert(agentRuntimes)
        .values(row)
        .onConflictDoUpdate({
          target: [agentRuntimes.agentId, agentRuntimes.backendSessionId],
          set: {
            sessionId: body.sessionId ?? null,
            runtimeId: body.runtimeId ?? null,
            backendType: body.backendType ?? "claude",
            status: body.status ?? "running",
            workspaceId: body.workspaceId ?? null,
            currentModel: body.currentModel ?? null,
            updatedAt: now,
          },
        })
        .returning({ id: agentRuntimes.id });

      return { id: inserted?.id ?? null };
    },

    /**
     * Finds a runtime row by sessionId + runtimeId or backendSessionId.
     * Returns null when absent.
     */
    async getAgentRuntime({
      sessionId,
      runtimeId,
      backendSessionId,
    }: {
      sessionId: string;
      runtimeId?: string | null;
      backendSessionId?: string | null;
    }) {
      const conditions = [eq(agentRuntimes.sessionId, sessionId)];
      if (runtimeId != null) conditions.push(eq(agentRuntimes.runtimeId, runtimeId));
      if (backendSessionId != null) conditions.push(eq(agentRuntimes.backendSessionId, backendSessionId));

      const rows = await db
        .select()
        .from(agentRuntimes)
        .where(and(...conditions))
        .limit(1);

      return rows[0] ? mapRow(rows[0]) : null;
    },

    /**
     * Returns the most recently updated runtime for a given agent + session.
     * Returns null when absent.
     */
    async getLatestAgentRuntime({
      agentId,
      sessionId,
    }: {
      agentId: string;
      sessionId: string;
    }) {
      const rows = await db
        .select()
        .from(agentRuntimes)
        .where(
          and(
            eq(agentRuntimes.agentId, agentId),
            eq(agentRuntimes.sessionId, sessionId),
          ),
        )
        .orderBy(desc(agentRuntimes.updatedAt))
        .limit(1);

      return rows[0] ? mapRow(rows[0]) : null;
    },

    /**
     * Updates lastProcessedMessageId for the given runtime row id.
     */
    async updateRuntimeCursor(
      runtimeRowId: string,
      { lastProcessedMessageId }: { lastProcessedMessageId: string | null },
    ) {
      await (db as any)
        .update(agentRuntimes)
        .set({ lastProcessedMessageId, updatedAt: new Date() })
        .where(eq(agentRuntimes.id, runtimeRowId));
    },

    /**
     * Updates currentModel for rows matching the given runtimeId (text).
     */
    async updateRuntimeModel(runtimeId: string, model: string) {
      await (db as any)
        .update(agentRuntimes)
        .set({ currentModel: model, updatedAt: new Date() })
        .where(eq(agentRuntimes.runtimeId, runtimeId));
    },

    /**
     * Lists all runtime rows for a team, ordered by updatedAt desc.
     */
    async listAgentRuntimesForTeam(teamId: string) {
      const rows = await db
        .select()
        .from(agentRuntimes)
        .where(eq(agentRuntimes.teamId, teamId))
        .orderBy(desc(agentRuntimes.updatedAt));
      return rows.map(mapRow);
    },

    /**
     * Returns the latest runtime hint per agent for a set of agentIds.
     * Shape mirrors supabase-repo (snake_case) so callers need no adaptation.
     */
    async listLatestAgentRuntimeHints(teamId: string, agentIds: string[]) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const rows = await db
        .select({
          id: agentRuntimes.id,
          agent_id: agentRuntimes.agentId,
          workspace_id: agentRuntimes.workspaceId,
          backend_type: agentRuntimes.backendType,
          runtime_id: agentRuntimes.runtimeId,
          session_id: agentRuntimes.sessionId,
          status: agentRuntimes.status,
          current_model: agentRuntimes.currentModel,
          updated_at: agentRuntimes.updatedAt,
        })
        .from(agentRuntimes)
        .where(
          and(
            eq(agentRuntimes.teamId, teamId),
            inArray(agentRuntimes.agentId, agentIds),
          ),
        )
        .orderBy(desc(agentRuntimes.updatedAt));

      // Deduplicate: keep first (latest) per agent
      const latest = new Map<string, (typeof rows)[0]>();
      for (const row of rows) {
        if (!latest.has(row.agent_id)) latest.set(row.agent_id, row);
      }

      return [...latest.values()].map((row) => ({
        id: row.id,
        agent_id: row.agent_id,
        workspace_id: row.workspace_id ?? null,
        backend_type: row.backend_type ?? null,
        runtime_id: row.runtime_id ?? null,
        session_id: row.session_id ?? null,
        status: row.status ?? null,
        current_model: row.current_model ?? null,
        updated_at: iso(row.updated_at),
      }));
    },

    /**
     * Returns the per-session runtime rows (id, runtime_id, agent_id,
     * workspace_id, backend_type, current_model, status). The expo
     * session-members screen reads agent_id/workspace_id/status; other callers
     * ignore the extra fields.
     */
    async listSessionRuntimeModels(sessionId: string) {
      const rows = await db
        .select({
          id: agentRuntimes.id,
          runtime_id: agentRuntimes.runtimeId,
          agent_id: agentRuntimes.agentId,
          workspace_id: agentRuntimes.workspaceId,
          backend_type: agentRuntimes.backendType,
          current_model: agentRuntimes.currentModel,
          status: agentRuntimes.status,
        })
        .from(agentRuntimes)
        .where(eq(agentRuntimes.sessionId, sessionId));
      return rows.map((r) => ({
        id: r.id ?? null,
        runtime_id: r.runtime_id ?? null,
        agent_id: r.agent_id ?? null,
        workspace_id: r.workspace_id ?? null,
        backend_type: r.backend_type ?? null,
        current_model: r.current_model ?? null,
        status: r.status ?? null,
      }));
    },

    /**
     * Returns the latest agent_id + runtime_id pair per agent for a session.
     * When agentIds is empty, returns targets for every agent in the session.
     * Orders by updated_at desc before per-agent dedup. Cloud status is not
     * used for routing — interrupt/cancel leaves the runtime live (idle).
     */
    async listRuntimeTargetsForSession(sessionId: string, agentIds: string[]) {
      const conditions = [eq(agentRuntimes.sessionId, sessionId)];
      if (Array.isArray(agentIds) && agentIds.length > 0) {
        conditions.push(inArray(agentRuntimes.agentId, agentIds));
      }
      const rows = await db
        .select({
          agent_id: agentRuntimes.agentId,
          runtime_id: agentRuntimes.runtimeId,
        })
        .from(agentRuntimes)
        .where(and(...conditions))
        .orderBy(desc(agentRuntimes.updatedAt));

      const latest = new Map<string, { agent_id: string | null; runtime_id: string | null }>();
      for (const row of rows) {
        const agentId = row.agent_id;
        if (!agentId || latest.has(agentId)) continue;
        latest.set(agentId, {
          agent_id: row.agent_id ?? null,
          runtime_id: row.runtime_id ?? null,
        });
      }
      return [...latest.values()];
    },

    /**
     * Lists all runtime rows for a team in daemon-friendly shape.
     */
    async listDaemonRuntimes(teamId: string) {
      const rows = await db
        .select()
        .from(agentRuntimes)
        .where(eq(agentRuntimes.teamId, teamId))
        .orderBy(desc(agentRuntimes.updatedAt));
      return rows.map((r) => ({
        id: r.id,
        runtimeId: r.runtimeId ?? null,
        teamId: r.teamId,
        agentId: r.agentId,
        sessionId: r.sessionId ?? null,
        workspaceId: r.workspaceId ?? null,
        backendType: r.backendType,
        backendSessionId: r.backendSessionId ?? null,
        status: r.status,
        currentModel: r.currentModel ?? null,
        lastSeenAt: iso(r.lastSeenAt),
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
      }));
    },

    /**
     * Connectivity probe + actor presence update.
     * Stamps last_active_at for the calling actor so clients see it as online.
     * Daemon tokens carry callerActorId (agent row); desktop/iOS member tokens
     * carry userId and fall back to updating every actor row for that user —
     * mirroring the Supabase `update_actor_last_active()` RPC.
     */
    async heartbeat() {
      await db.select({ one: teams.id }).from(teams).limit(1);
      const now = new Date();
      if (ctx.callerActorId) {
        await (db as any)
          .update(actors)
          .set({ lastActiveAt: now, updatedAt: now })
          .where(eq(actors.id, ctx.callerActorId));
        return;
      }
      if (ctx.userId) {
        await (db as any)
          .update(actors)
          .set({ lastActiveAt: now, updatedAt: now })
          .where(eq(actors.userId, ctx.userId));
      }
    },
  };
}
