/**
 * Ideas domain — pg-repo implementation.
 *
 * Authz strategy (mirrors the Supabase RPC SECURITY DEFINER pattern):
 *  - RPC-replacement methods (createIdea, updateIdea, archiveIdea,
 *    reorderIdeas, createIdeaActivity) accept an explicit actorId from args
 *    when callers supply one (e.g. authorActorId / actorId). This is the normal
 *    daemon/API path; no JWT userId resolution needed.
 *  - When a ctx.userId is present BUT no explicit actorId is supplied in args,
 *    requireActorForTeam() is called to resolve + validate team membership,
 *    throwing ApiError(403) for non-members.
 *  - Read-only methods (listIdeas, getIdea, listIdeaActivities,
 *    listIdeasForSync) do NOT enforce authz — they match the permissive Supabase
 *    RLS read policy (any authenticated user can read ideas for a team they're
 *    in; callers are pre-verified by the HTTP handler layer).
 *
 * Row mapping:
 *  - authorActorId ← ideas.createdByActorId  (contract key rename)
 *  - actorIds      ← [] (ideas table has no participant array; kept for compat)
 *  - kind          ← idea_activities.activityType (schema column rename)
 */

import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { ideas, ideaActivities } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam } from "./authz.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface IdeasCtx {
  userId?: string;
}

function mapIdea(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    title: r.title,
    description: r.description ?? null,
    archived: r.archived === true,
    authorActorId: r.createdByActorId ?? null,
    actorIds: [] as string[],
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

function mapActivity(r: any) {
  // Normalise metadata: the schema default is {} but callers treat absent
  // metadata as null. Return null when metadata is an empty object.
  const meta = r.metadata ?? null;
  const normMeta =
    meta !== null && typeof meta === "object" && !Array.isArray(meta) && Object.keys(meta).length === 0
      ? null
      : meta;
  return {
    id: r.id,
    ideaId: r.ideaId,
    kind: r.activityType,
    actorId: r.actorId,
    content: r.content ?? null,
    metadata: normMeta,
    createdAt: iso(r.createdAt)!,
  };
}

export function makeIdeasRepo(db: DbLike, ctx: IdeasCtx = {}) {
  return {
    // ── List ──────────────────────────────────────────────────────────────
    async listIdeas({
      teamId,
      archived = false,
      limit = 50,
      cursor = null,
    }: {
      teamId: string;
      archived?: boolean;
      limit?: number;
      cursor?: { updatedAt?: string } | null;
    }) {
      let query = db
        .select()
        .from(ideas)
        .where(and(eq(ideas.teamId, teamId), eq(ideas.archived, archived)))
        .orderBy(desc(ideas.updatedAt), desc(ideas.id))
        .limit(limit + 1) as any;

      if (cursor?.updatedAt) {
        query = db
          .select()
          .from(ideas)
          .where(
            and(
              eq(ideas.teamId, teamId),
              eq(ideas.archived, archived),
              lt(ideas.updatedAt, new Date(cursor.updatedAt)),
            ),
          )
          .orderBy(desc(ideas.updatedAt), desc(ideas.id))
          .limit(limit + 1);
      }

      const rows = await query;
      const items = rows.slice(0, limit).map(mapIdea);
      return { items };
    },

    async getIdea(ideaId: string) {
      const [r] = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1);
      return r ? mapIdea(r) : null;
    },

    // ── Create ────────────────────────────────────────────────────────────
    async createIdea(body: {
      teamId: string;
      title: string;
      description?: string | null;
      authorActorId?: string;
      workspaceId?: string | null;
      /** When provided (without authorActorId), triggers membership check */
      userId?: string;
    }) {
      const teamId = body.teamId;
      let actorId: string;

      if (body.authorActorId) {
        // Explicit actorId from caller — trusted path (daemon, API with pre-validated actor)
        actorId = body.authorActorId;
      } else {
        // Must resolve from userId (ambient caller authz)
        const uid = body.userId ?? ctx.userId;
        if (!uid) throw new ApiError(400, "bad_request", "authorActorId or userId required");
        actorId = await requireActorForTeam(db, uid, teamId);
      }

      const [r] = await (db.insert(ideas) as any)
        .values({
          teamId,
          title: body.title,
          description: body.description ?? "",
          createdByActorId: actorId,
          status: "open",
          workspaceId: body.workspaceId ?? null,
        })
        .returning();

      return mapIdea(r);
    },

    // ── Update ────────────────────────────────────────────────────────────
    async updateIdea(
      ideaId: string,
      patch: { title?: string; description?: string | null; status?: string | null },
    ) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.title !== undefined) updates.title = patch.title;
      if (patch.description !== undefined) updates.description = patch.description;
      if (patch.status !== undefined) updates.status = patch.status;

      const [r] = await (db.update(ideas) as any)
        .set(updates)
        .where(eq(ideas.id, ideaId))
        .returning();
      if (!r) throw new ApiError(404, "not_found", "idea not found");
      return mapIdea(r);
    },

    // ── Archive ───────────────────────────────────────────────────────────
    async archiveIdea(ideaId: string, { archived = true }: { archived?: boolean } = {}) {
      await (db.update(ideas) as any)
        .set({ archived, updatedAt: new Date() })
        .where(eq(ideas.id, ideaId));
    },

    // ── Reorder ───────────────────────────────────────────────────────────
    /**
     * Batch-update sort_order in a transaction.
     * ideaIds[0] → sortOrder 0, ideaIds[1] → 1, …
     * This replicates the plpgsql reorder_ideas RPC logic.
     */
    async reorderIdeas({ teamId, ideaIds }: { teamId: string; ideaIds: string[] }) {
      if (!ideaIds.length) return;
      await (db as any).transaction(async (tx: any) => {
        for (let i = 0; i < ideaIds.length; i++) {
          await (tx.update(ideas) as any)
            .set({ sortOrder: i, updatedAt: new Date() })
            .where(and(eq(ideas.id, ideaIds[i]), eq(ideas.teamId, teamId)));
        }
      });
    },

    // ── Activities ────────────────────────────────────────────────────────
    async createIdeaActivity(
      ideaId: string,
      body: { kind: string; actorId: string; content?: string | null; metadata?: unknown | null },
    ) {
      // Look up the teamId from the idea (required FK on idea_activities)
      const [idea] = await db.select({ teamId: ideas.teamId }).from(ideas).where(eq(ideas.id, ideaId)).limit(1);
      if (!idea) throw new ApiError(404, "not_found", "idea not found");

      const [r] = await (db.insert(ideaActivities) as any)
        .values({
          ideaId,
          teamId: idea.teamId,
          actorId: body.actorId,
          activityType: body.kind,
          content: body.content ?? "",
          metadata: body.metadata ?? {},
        })
        .returning();

      return mapActivity(r);
    },

    async listIdeaActivities(ideaId: string) {
      const rows = await db
        .select()
        .from(ideaActivities)
        .where(eq(ideaActivities.ideaId, ideaId))
        .orderBy(desc(ideaActivities.createdAt));
      return { items: rows.map(mapActivity) };
    },

    // ── Sync ──────────────────────────────────────────────────────────────
    // Snake_case wire shape — consumed directly by the client's lib/sync/idea-sync.ts
    // (no client mapper). Matches supabase-repo's listIdeasForSync SELECT columns.
    async listIdeasForSync(teamId: string, updatedAfter: string | null) {
      const rows = updatedAfter
        ? await db
            .select()
            .from(ideas)
            .where(and(eq(ideas.teamId, teamId), gt(ideas.updatedAt, new Date(updatedAfter))))
        : await db.select().from(ideas).where(eq(ideas.teamId, teamId));
      return rows.map((r: any) => ({
        id: r.id,
        team_id: r.teamId,
        workspace_id: r.workspaceId ?? null,
        parent_idea_id: r.parentIdeaId ?? null,
        title: r.title,
        description: r.description ?? null,
        status: r.status ?? null,
        created_by_actor_id: r.createdByActorId ?? null,
        archived: r.archived === true,
        sort_order: r.sortOrder ?? 0,
        created_at: iso(r.createdAt),
        updated_at: iso(r.updatedAt),
      }));
    },
  };
}
