/**
 * Telemetry domain — pg-repo implementation.
 *
 * RPC replacement:
 *  - team_leaderboard(p_team_id, p_period) →
 *    getTeamLeaderboard: Drizzle LEFT JOINs + GROUP BY aggregation matching the
 *    SQL function's CTE structure (reports / fb / skills) with a period window
 *    on created_at. Score formula: tokens_used (matching the migration placeholder).
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  actorMessageFeedback,
  actorSessionReport,
  actorSkillUsage,
  actors,
} from "../../db/schema/index.js";
import { actorClientVersions } from "../../db/schema/telemetry.js";
import { requireActorForTeam } from "./authz.js";
import { ApiError } from "../http-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface TelemetryCtx {
  userId?: string;
}

function periodSince(period: string): Date | null {
  const now = new Date();
  switch (period) {
    case "day":   return new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    case "month": return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":   return null; // no window
    case "week":
    default:      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
}

function mapFeedbackRow(r: any) {
  return {
    messageId: r.messageId ?? r.message_id,
    actorId: r.actorId ?? r.actor_id,
    teamId: r.teamId ?? r.team_id ?? null,
    sessionId: r.sessionId ?? r.session_id ?? null,
    kind: r.kind,
    starRating: r.starRating ?? r.star_rating ?? null,
    skill: r.skill ?? null,
    createdAt: r.createdAt ?? r.created_at ?? null,
  };
}

export function makeTelemetryRepo(db: DbLike, ctx: TelemetryCtx = {}) {
  return {
    // ── submitFeedback ────────────────────────────────────────────────────────
    async submitFeedback(body: {
      messageId: string;
      actorId: string;
      teamId: string;
      sessionId?: string | null;
      kind: string;
      starRating?: number | null;
      skill?: string | null;
    }) {
      // Use raw SQL for upsert: the unique constraint (actor_id, message_id)
      // exists in the Supabase migration but may not be named in the Drizzle
      // schema, so we use ON CONFLICT (actor_id, message_id) directly.
      const rows = await (db as any).execute(sql`
        INSERT INTO actor_message_feedback (actor_id, team_id, session_id, message_id, kind, star_rating, skill)
        VALUES (
          ${body.actorId},
          ${body.teamId},
          ${body.sessionId ?? null},
          ${body.messageId},
          ${body.kind},
          ${body.starRating ?? null},
          ${body.skill ?? null}
        )
        ON CONFLICT (actor_id, message_id) DO UPDATE
          SET kind = EXCLUDED.kind,
              star_rating = EXCLUDED.star_rating,
              skill = EXCLUDED.skill
        RETURNING *
      `);
      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return mapFeedbackRow(result[0]);
    },

    // ── listFeedback ──────────────────────────────────────────────────────────
    async listFeedback({ sessionId }: { sessionId: string }) {
      const rows = await db
        .select()
        .from(actorMessageFeedback)
        .where(eq(actorMessageFeedback.sessionId, sessionId));
      return { items: rows.map(mapFeedbackRow) };
    },

    // ── deleteFeedback ────────────────────────────────────────────────────────
    async deleteFeedback(messageId: string, actorId: string) {
      const conditions: any[] = [eq(actorMessageFeedback.messageId, messageId)];
      if (actorId) conditions.push(eq(actorMessageFeedback.actorId, actorId));
      await (db.delete(actorMessageFeedback) as any).where(and(...conditions));
    },

    // ── submitSessionReport ───────────────────────────────────────────────────
    async submitSessionReport(body: {
      actorId: string;
      teamId: string;
      sessionId?: string | null;
      tokensUsed?: number;
      costUsd?: number;
      model?: string | null;
      agentKind?: string | null;
      endedAt?: string | null;
      skillUsage?: Record<string, number>;
    }) {
      const reportRow: any = {
        actorId: body.actorId,
        teamId: body.teamId,
        sessionId: body.sessionId ?? null,
        tokensUsed: body.tokensUsed ?? 0,
        costUsd: String(body.costUsd ?? 0),
        model: body.model ?? null,
        agentKind: body.agentKind ?? null,
        endedAt: body.endedAt ? new Date(body.endedAt) : null,
      };

      await (db.insert(actorSessionReport) as any).values(reportRow);

      // Insert skill-usage rows from the report
      const skillRows = Object.entries(body.skillUsage ?? {})
        .filter(([, count]) => Number(count) > 0)
        .map(([skill, count]) => ({
          actorId: body.actorId,
          teamId: body.teamId,
          sessionId: body.sessionId ?? null,
          skill,
          count: Number(count),
        }));

      if (skillRows.length > 0) {
        await (db.insert(actorSkillUsage) as any).values(skillRows);
      }
    },

    // ── submitSkillUsage ──────────────────────────────────────────────────────
    async submitSkillUsage(body: {
      actorId: string;
      teamId: string;
      sessionId?: string | null;
      skill: string;
      count?: number;
    }) {
      await (db.insert(actorSkillUsage) as any).values({
        actorId: body.actorId,
        teamId: body.teamId,
        sessionId: body.sessionId ?? null,
        skill: body.skill,
        count: Number(body.count ?? 1),
      });
    },

    // ── reportClientVersion ───────────────────────────────────────────────────
    async reportClientVersion(teamId: string, body: {
      clientType: string;
      version: string;
      deviceId: string;
      build?: string | null;
    }) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const actorId = await requireActorForTeam(db, ctx.userId, teamId);
      const now = new Date();
      await (db.insert(actorClientVersions) as any)
        .values({
          actorId,
          teamId,
          clientType: body.clientType,
          deviceId: body.deviceId,
          version: body.version,
          build: body.build ?? null,
          lastReportedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            actorClientVersions.actorId,
            actorClientVersions.clientType,
            actorClientVersions.deviceId,
          ],
          set: { version: body.version, build: body.build ?? null, lastReportedAt: now },
        });
    },

    // ── listFeedbackSummary ───────────────────────────────────────────────────
    async listFeedbackSummary(teamId: string) {
      // DB-side GROUP BY to avoid full-table JS scan.
      // displayName left null — callers resolve via leaderboard or actor lookup.
      const rows = await (db as any).execute(sql`
        SELECT
          f.actor_id   AS "actorId",
          NULL::text   AS "displayName",
          SUM(CASE WHEN f.kind = 'positive' THEN 1 ELSE 0 END)::int AS "positive",
          SUM(CASE WHEN f.kind = 'negative' THEN 1 ELSE 0 END)::int AS "negative",
          COUNT(*)::int AS "total"
        FROM actor_message_feedback f
        WHERE f.team_id = ${teamId}
        GROUP BY f.actor_id
      `);

      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return {
        items: result.map((r: any) => ({
          actorId: r.actorId,
          displayName: r.displayName ?? null,
          positive: Number(r.positive ?? 0),
          negative: Number(r.negative ?? 0),
          total: Number(r.total ?? 0),
        })),
      };
    },

    // ── getTeamLeaderboard ────────────────────────────────────────────────────
    /**
     * Reimplements the team_leaderboard(p_team_id, p_period) SQL function as
     * a Drizzle raw-SQL aggregation. Structure mirrors the RPC's CTEs:
     *   reports  — SUM(tokens_used), SUM(cost_usd), COUNT(*) per actor
     *   fb       — SUM positive/negative feedback per actor
     *   skills   — jsonb_object_agg(skill → sum(count)) per actor
     * All three are period-windowed by created_at >= since.
     * Score formula: tokens_used (matches the migration's placeholder comment).
     */
    async getTeamLeaderboard(teamId: string, { period = "week" }: { period?: string } = {}) {
      const since = periodSince(period);
      const sinceClause = since
        ? sql`AND r.created_at >= ${since}`
        : sql``;
      const sinceClauseFb = since
        ? sql`AND f.created_at >= ${since}`
        : sql``;
      const sinceClauseSk = since
        ? sql`AND su.created_at >= ${since}`
        : sql``;

      const rows = await (db as any).execute(sql`
        WITH reports AS (
          SELECT
            r.actor_id,
            SUM(r.tokens_used)::bigint  AS tokens_used,
            SUM(r.cost_usd)::numeric    AS cost_usd,
            COUNT(*)::bigint            AS session_count
          FROM actor_session_report r
          WHERE r.team_id = ${teamId} ${sinceClause}
          GROUP BY r.actor_id
        ),
        fb AS (
          SELECT
            f.actor_id,
            SUM(CASE WHEN f.kind = 'positive' THEN 1 ELSE 0 END)::bigint AS positive_feedback,
            SUM(CASE WHEN f.kind = 'negative' THEN 1 ELSE 0 END)::bigint AS negative_feedback
          FROM actor_message_feedback f
          WHERE f.team_id = ${teamId} ${sinceClauseFb}
          GROUP BY f.actor_id
        ),
        skills AS (
          SELECT
            sub.actor_id,
            jsonb_object_agg(sub.skill, sub.cnt) AS skill_usage
          FROM (
            SELECT su.actor_id, su.skill, SUM(su.count)::bigint AS cnt
            FROM actor_skill_usage su
            WHERE su.team_id = ${teamId} ${sinceClauseSk}
            GROUP BY su.actor_id, su.skill
          ) sub
          GROUP BY sub.actor_id
        )
        SELECT
          a.team_id         AS "teamId",
          a.id              AS "actorId",
          a.display_name    AS "displayName",
          ${period}::text   AS "period",
          COALESCE(reports.tokens_used, 0)         AS "tokensUsed",
          COALESCE(reports.cost_usd, 0)            AS "costUsd",
          COALESCE(fb.positive_feedback, 0)        AS "positiveFeedback",
          COALESCE(fb.negative_feedback, 0)        AS "negativeFeedback",
          COALESCE(reports.session_count, 0)       AS "sessionCount",
          COALESCE(skills.skill_usage, '{}'::jsonb) AS "skillUsage",
          COALESCE(reports.tokens_used, 0)::numeric AS "score"
        FROM actors a
        LEFT JOIN reports ON reports.actor_id = a.id
        LEFT JOIN fb      ON fb.actor_id      = a.id
        LEFT JOIN skills  ON skills.actor_id  = a.id
        WHERE a.team_id = ${teamId}
        ORDER BY COALESCE(reports.tokens_used, 0) DESC
      `);

      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return {
        items: result.map((r: any) => ({
          actorId: String(r.actorId),
          teamId: r.teamId ?? null,
          displayName: r.displayName ?? null,
          period: r.period ?? period,
          tokensUsed: Number(r.tokensUsed ?? 0),
          costUsd: Number(r.costUsd ?? 0),
          positiveFeedback: Number(r.positiveFeedback ?? 0),
          negativeFeedback: Number(r.negativeFeedback ?? 0),
          sessionCount: Number(r.sessionCount ?? 0),
          skillUsage: r.skillUsage ?? {},
          score: Number(r.score ?? 0),
        })),
      };
    },
  };
}
