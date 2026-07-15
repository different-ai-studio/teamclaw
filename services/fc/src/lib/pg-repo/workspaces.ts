/**
 * Workspaces domain — pg-repo implementation.
 *
 * Row mapping notes:
 *  - slug    ← workspaces.path   (schema uses path; API/contract calls it slug)
 *  - metadata ← null             (not stored on workspaces table; kept for compat)
 *  - getTeamWorkspaceConfig / putTeamWorkspaceConfig return the contract shape
 *    {defaultWorkspaceId, pinnedWorkspaceIds} backed by the team_workspace_config
 *    columns added in migration 0003_complex_synch.sql.
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { workspaces, teamWorkspaceConfig } from "../../db/schema/index.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

function mapWorkspace(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    slug: r.path ?? null,
    archived: r.archived === true,
    metadata: null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

export function makeWorkspacesRepo(db: DbLike) {
  return {
    // ── List ──────────────────────────────────────────────────────────────
    async listWorkspaces({
      teamId,
      limit = 50,
      cursor = null,
      agentId = null,
    }: {
      teamId: string;
      limit?: number;
      cursor?: { updatedAt?: string } | null;
      agentId?: string | null;
    }) {
      const conditions: any[] = [eq(workspaces.teamId, teamId)];
      if (agentId) conditions.push(eq(workspaces.agentId, agentId));
      if (cursor?.updatedAt) conditions.push(lt(workspaces.updatedAt, new Date(cursor.updatedAt)));

      const rows = await (db
        .select()
        .from(workspaces)
        .where(and(...conditions))
        .orderBy(desc(workspaces.updatedAt), desc(workspaces.id))
        .limit(limit + 1) as any);

      const items = rows.slice(0, limit).map(mapWorkspace);
      return { items };
    },

    // ── Upsert ────────────────────────────────────────────────────────────
    // Dedup key: an explicit `id` always wins (update-by-id). When no id is
    // given but a non-empty `path` is, we look up an existing row for
    // (teamId, path) first and update that row instead of blindly inserting
    // — the `workspaces` table has no DB-level unique constraint on
    // (team_id, path), so a naive `insert ... onConflict(id)` mints a fresh
    // random UUID on every call for the same path (the historical
    // "two UUIDs for one path" bug). This keeps the fix in application code
    // rather than requiring a schema migration/deploy.
    async upsertWorkspace(input: {
      id?: string | null;
      teamId: string;
      name: string;
      path?: string | null;
      agentId?: string | null;
      createdByMemberId?: string | null;
      archived?: boolean;
    }) {
      let targetId = input.id ?? null;

      if (!targetId && input.path) {
        const [existing] = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.teamId, input.teamId), eq(workspaces.path, input.path)))
          .limit(1);
        if (existing) targetId = existing.id;
      }

      if (targetId) {
        const [r] = await (db.insert(workspaces) as any)
          .values({
            id: targetId,
            teamId: input.teamId,
            name: input.name,
            path: input.path ?? null,
            agentId: input.agentId ?? null,
            createdByMemberId: input.createdByMemberId ?? null,
            archived: input.archived ?? false,
          })
          .onConflictDoUpdate({
            target: workspaces.id,
            set: {
              name: input.name,
              path: input.path ?? null,
              agentId: input.agentId ?? null,
              archived: input.archived ?? false,
              updatedAt: new Date(),
            },
          })
          .returning();
        return mapWorkspace(r);
      }

      const [r] = await (db.insert(workspaces) as any)
        .values({
          teamId: input.teamId,
          name: input.name,
          path: input.path ?? null,
          agentId: input.agentId ?? null,
          createdByMemberId: input.createdByMemberId ?? null,
          archived: input.archived ?? false,
        })
        .returning();
      return mapWorkspace(r);
    },

    // ── Get ───────────────────────────────────────────────────────────────
    async getWorkspace(workspaceId: string) {
      const [r] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      return r ? mapWorkspace(r) : null;
    },

    // ── Patch ─────────────────────────────────────────────────────────────
    async patchWorkspace(workspaceId: string, patch: { name?: string; archived?: boolean; slug?: string | null; path?: string | null; agentId?: string | null }) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.archived !== undefined) updates.archived = patch.archived;
      if (patch.slug !== undefined) updates.path = patch.slug;
      if (patch.path !== undefined) updates.path = patch.path;
      if (patch.agentId !== undefined) updates.agentId = patch.agentId;

      const [r] = await (db.update(workspaces) as any)
        .set(updates)
        .where(eq(workspaces.id, workspaceId))
        .returning();
      if (!r) return null;
      return mapWorkspace(r);
    },

    // ── List by IDs (slim) ────────────────────────────────────────────────
    async listWorkspacesByIdsSlim(teamId: string, workspaceIds: string[]) {
      if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) return [];
      const rows = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.teamId, teamId), inArray(workspaces.id, workspaceIds)));
      return rows.map(mapWorkspace);
    },

    // ── Team workspace defaults (defaultWorkspaceId / pinnedWorkspaceIds) ─
    async getTeamWorkspaceConfig(teamId: string) {
      const [r] = await db
        .select()
        .from(teamWorkspaceConfig)
        .where(eq(teamWorkspaceConfig.teamId, teamId))
        .limit(1);
      if (!r) return null;
      return {
        teamId: r.teamId,
        defaultWorkspaceId: r.defaultWorkspaceId ?? null,
        pinnedWorkspaceIds: (r.pinnedWorkspaceIds as string[] | null) ?? [],
        updatedAt: iso(r.updatedAt),
      };
    },

    async putTeamWorkspaceConfig(teamId: string, input: { defaultWorkspaceId?: string | null; pinnedWorkspaceIds?: string[] }) {
      const [r] = await (db.insert(teamWorkspaceConfig) as any)
        .values({
          teamId,
          defaultWorkspaceId: input.defaultWorkspaceId ?? null,
          pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [],
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: teamWorkspaceConfig.teamId,
          set: {
            defaultWorkspaceId: input.defaultWorkspaceId ?? null,
            pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [],
            updatedAt: new Date(),
          },
        })
        .returning();
      return {
        teamId: r.teamId,
        defaultWorkspaceId: r.defaultWorkspaceId ?? null,
        pinnedWorkspaceIds: (r.pinnedWorkspaceIds as string[] | null) ?? [],
        updatedAt: iso(r.updatedAt),
      };
    },
  };
}
