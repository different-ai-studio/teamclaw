/**
 * Shortcuts/Roles/Permissions domain — pg-repo implementation.
 *
 * BUG FIX (current_member_id multi-team bug):
 *   The legacy Supabase RPCs `shortcut_create` and `shortcut_batch_move` resolved
 *   the owner via `current_member_id()` — a global resolver that returned the user's
 *   OLDEST actor across ALL teams, regardless of which team the shortcut belonged to.
 *   For users with actors in multiple teams this silently attributed shortcuts to the
 *   wrong team's actor.
 *
 *   In this implementation `createShortcut` and `batchMoveShortcuts` require an
 *   explicit `ownerActorId` parameter (the caller's actor in THIS team's context).
 *   When it is absent and a `ctx.userId` is available the actor is resolved via
 *   `requireActorForTeam(db, userId, teamId)` which is correctly team-scoped.
 *   The global "oldest actor" resolution is NEVER used.
 *
 * visibleRoleIds mapping:
 *   Shortcuts do not have a `visible_role_ids` column. Visibility is stored in the
 *   `permissions` + `permission_roles` join table with `resource_type = 'shortcut'`
 *   and `resource_id = shortcut.id`. `listShortcuts` left-joins these tables to
 *   build the `visibleRoleIds` array on each returned shortcut.
 *   `setShortcutVisibleRoles` atomically swaps the permission_roles in a transaction:
 *     1. Find (or create) the permissions row for this shortcut.
 *     2. Delete all existing permission_roles for that permissions row.
 *     3. Insert the new roleIds.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  shortcuts,
  teamRoles,
  permissions,
  permissionRoles,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, checkTeamMembership } from "./authz.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface ShortcutsCtx {
  userId?: string;
}

// Snake_case wire shape — matches supabase-repo's mapShortcutRow and the
// desktop client's ShortcutRow (consumed directly, no client-side mapper).
// Role visibility is exposed separately via listShortcutRoleBindings, so it is
// intentionally NOT part of the shortcut row (mirrors supabase). The unused
// roleIds param is retained so existing call sites stay unchanged.
function mapShortcut(r: any, _visibleRoleIds: string[] = []) {
  return {
    id: r.id,
    scope: r.scope,
    label: r.label,
    owner_member_id: r.ownerMemberId ?? null,
    team_id: r.teamId ?? null,
    parent_id: r.parentId ?? null,
    icon: r.icon ?? null,
    order: r.order ?? 0,
    node_type: r.nodeType,
    target: r.target ?? "",
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

export function makeShortcutsRepo(db: DbLike, ctx: ShortcutsCtx = {}) {
  // ── Internal helper: resolve visibleRoleIds for a set of shortcut ids ──────
  async function fetchVisibleRoleIds(
    shortcutIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (!shortcutIds.length) return result;

    // Find permissions rows for these shortcuts (resource_type = 'shortcut')
    const permRows = await (db.select() as any)
      .from(permissions)
      .where(
        and(
          eq(permissions.resourceType, "shortcut"),
          inArray(permissions.resourceId, shortcutIds),
        ),
      );

    if (!permRows.length) return result;

    const permIds = permRows.map((p: any) => p.id);
    const prRows = await (db.select() as any)
      .from(permissionRoles)
      .where(inArray(permissionRoles.permissionId, permIds));

    // Build permId → resourceId map
    const permIdToResourceId = new Map<string, string>();
    for (const p of permRows) permIdToResourceId.set(p.id, p.resourceId);

    // Accumulate roleIds per shortcut
    for (const pr of prRows) {
      const shortcutId = permIdToResourceId.get(pr.permissionId);
      if (!shortcutId) continue;
      if (!result.has(shortcutId)) result.set(shortcutId, []);
      result.get(shortcutId)!.push(pr.roleId);
    }

    return result;
  }

  return {
    // ── listShortcuts ─────────────────────────────────────────────────────────
    async listShortcuts(
      teamId: string,
      { parentId }: { parentId?: string | null } = {},
    ) {
      let query = (db.select() as any)
        .from(shortcuts)
        .where(eq(shortcuts.teamId, teamId))
        .orderBy(shortcuts.order);

      if (parentId !== undefined) {
        if (parentId === null) {
          query = (db.select() as any)
            .from(shortcuts)
            .where(and(eq(shortcuts.teamId, teamId), isNull(shortcuts.parentId)))
            .orderBy(shortcuts.order);
        } else {
          query = (db.select() as any)
            .from(shortcuts)
            .where(and(eq(shortcuts.teamId, teamId), eq(shortcuts.parentId, parentId)))
            .orderBy(shortcuts.order);
        }
      }

      const rows: any[] = await query;
      const ids = rows.map((r: any) => r.id);
      const roleMap = await fetchVisibleRoleIds(ids);
      return rows.map((r: any) => mapShortcut(r, roleMap.get(r.id) ?? []));
    },

    // ── listShortcutsByScope ──────────────────────────────────────────────────
    /**
     * AUTHZ FIX (#2): personal shortcuts were unfiltered → cross-tenant leak.
     *
     * - scope='team'    → always filter by teamId (unchanged).
     * - scope='personal' → filter by teamId AND ownerMemberId = caller's actor.
     *   Requires ctx.userId; throws 403 if absent (fail closed).
     * NEVER returns unfiltered rows.
     */
    async listShortcutsByScope({
      scope,
      teamId,
      parentId,
    }: {
      scope: string;
      teamId?: string;
      parentId?: string | null;
    }) {
      const conditions: any[] = [eq(shortcuts.scope, scope)];

      if (scope === "team") {
        if (!teamId) throw new ApiError(400, "bad_request", "teamId required for team scope");
        conditions.push(eq(shortcuts.teamId, teamId));
      } else if (scope === "personal") {
        // Personal shortcuts must be scoped to the caller — fail closed if no identity.
        if (!ctx.userId) {
          throw new ApiError(403, "forbidden", "listShortcutsByScope: personal scope requires authenticated caller");
        }
        if (!teamId) throw new ApiError(400, "bad_request", "teamId required for personal scope");
        const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);
        conditions.push(eq(shortcuts.teamId, teamId));
        conditions.push(eq(shortcuts.ownerMemberId, callerActorId));
      } else {
        // Unknown scope — require teamId at minimum to avoid cross-tenant leaks.
        if (!teamId) throw new ApiError(400, "bad_request", "teamId required");
        conditions.push(eq(shortcuts.teamId, teamId));
      }

      if (parentId !== undefined) {
        if (parentId === null) conditions.push(isNull(shortcuts.parentId));
        else conditions.push(eq(shortcuts.parentId, parentId));
      }

      const rows: any[] = await (db.select() as any)
        .from(shortcuts)
        .where(and(...conditions))
        .orderBy(shortcuts.order);

      const ids = rows.map((r: any) => r.id);
      const roleMap = await fetchVisibleRoleIds(ids);
      return rows.map((r: any) => mapShortcut(r, roleMap.get(r.id) ?? []));
    },

    // ── createShortcut ────────────────────────────────────────────────────────
    /**
     * AUTHZ FIX (#4): never trust a client-supplied ownerActorId. The owner is
     * ALWAYS resolved server-side from the authenticated user's actor in THIS
     * team via requireActorForTeam (team-scoped — fixes the multi-team
     * current_member_id() bug AND prevents a caller forging another actor's id).
     *
     * A client MAY still send ownerActorId, but it is only honored when it
     * EXACTLY equals the resolved actor; any mismatch is rejected 403. When no
     * identity is available (ctx.userId absent — e.g. a trusted server caller
     * with no JWT), the explicit ownerActorId is used as-is so internal/gateway
     * callers keep working.
     */
    async createShortcut(body: {
      teamId: string;
      kind: string;
      label: string;
      position?: number;
      parentId?: string | null;
      icon?: string | null;
      payload?: string | null;
      scope?: string;
      /** Client hint only — validated against the resolved actor, never trusted blindly */
      ownerActorId?: string;
      /** Overrides ctx.userId for the resolution (used by trusted callers) */
      userId?: string;
    }) {
      let ownerMemberId: string | null = null;

      const uid = body.userId ?? ctx.userId;
      if (uid) {
        // Authenticated path: resolve the caller's team-scoped actor (403 if not
        // a member). This is authoritative — a forged ownerActorId is rejected.
        const resolved = await requireActorForTeam(db, uid, body.teamId);
        if (body.ownerActorId && body.ownerActorId !== resolved) {
          throw new ApiError(403, "forbidden", "ownerActorId does not match the caller's actor in this team");
        }
        ownerMemberId = resolved;
      } else if (body.ownerActorId) {
        // No authenticated user (trusted server/gateway caller) — accept the
        // explicit team-scoped actor as provided.
        ownerMemberId = body.ownerActorId;
      }
      // If neither identity nor ownerActorId is available the shortcut is
      // team-owned (no personal owner).

      const [r] = await (db.insert(shortcuts) as any)
        .values({
          scope: body.scope ?? "team",
          label: body.label,
          nodeType: body.kind,
          teamId: body.teamId,
          parentId: body.parentId ?? null,
          icon: body.icon ?? null,
          order: body.position ?? 0,
          target: body.payload ?? "",
          ownerMemberId,
        })
        .returning();

      return mapShortcut(r, []);
    },

    // ── updateShortcut ────────────────────────────────────────────────────────
    /**
     * AUTHZ FIX (#3): verify caller belongs to the shortcut's team before mutating.
     * Fail closed — 403 if ctx.userId absent.
     */
    async updateShortcut(
      shortcutId: string,
      patch: { label?: string; payload?: string | null; parentId?: string | null; position?: number },
    ) {
      if (!ctx.userId) {
        throw new ApiError(403, "forbidden", "updateShortcut: authenticated caller required");
      }

      // Load shortcut to obtain teamId for membership check.
      const [existing] = await (db.select() as any)
        .from(shortcuts)
        .where(eq(shortcuts.id, shortcutId))
        .limit(1);
      if (!existing) throw new ApiError(404, "not_found", "shortcut not found");

      const isMember = await checkTeamMembership(db, ctx.userId, existing.teamId);
      if (!isMember) throw new ApiError(403, "forbidden", "not a member of this team");

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.label !== undefined) updates.label = patch.label;
      if (patch.payload !== undefined) updates.target = patch.payload;
      if (patch.parentId !== undefined) updates.parentId = patch.parentId;
      if (patch.position !== undefined) updates.order = patch.position;

      const [r] = await (db.update(shortcuts) as any)
        .set(updates)
        .where(eq(shortcuts.id, shortcutId))
        .returning();
      if (!r) throw new ApiError(404, "not_found", "shortcut not found");
      return mapShortcut(r, []);
    },

    // ── deleteShortcut ────────────────────────────────────────────────────────
    /**
     * AUTHZ FIX (#3): verify caller belongs to the shortcut's team before deleting.
     * Fail closed — 403 if ctx.userId absent.
     */
    async deleteShortcut(shortcutId: string) {
      if (!ctx.userId) {
        throw new ApiError(403, "forbidden", "deleteShortcut: authenticated caller required");
      }

      const [existing] = await (db.select() as any)
        .from(shortcuts)
        .where(eq(shortcuts.id, shortcutId))
        .limit(1);
      if (!existing) throw new ApiError(404, "not_found", "shortcut not found");

      const isMember = await checkTeamMembership(db, ctx.userId, existing.teamId);
      if (!isMember) throw new ApiError(403, "forbidden", "not a member of this team");

      await (db.delete(shortcuts) as any).where(eq(shortcuts.id, shortcutId));
    },

    // ── batchMoveShortcuts ────────────────────────────────────────────────────
    /**
     * BUG FIX: the legacy RPC resolved the owner via current_member_id() globally.
     * This implementation updates position/parentId only — no owner attribution.
     *
     * AUTHZ FIX (#3): verify caller is a member of every affected shortcut's team.
     * Fail closed — 403 if ctx.userId absent.
     */
    async batchMoveShortcuts({
      moves,
    }: {
      moves: Array<{ shortcutId: string; parentId: string | null; position: number }>;
    }) {
      if (!moves.length) return;

      if (!ctx.userId) {
        throw new ApiError(403, "forbidden", "batchMoveShortcuts: authenticated caller required");
      }

      // Load all affected shortcuts to validate team membership.
      const shortcutIds = moves.map((m) => m.shortcutId);
      const rows: any[] = await (db.select() as any)
        .from(shortcuts)
        .where(inArray(shortcuts.id, shortcutIds));

      // Collect unique teamIds and verify membership in all of them.
      const teamIds = [...new Set(rows.map((r: any) => r.teamId as string))];
      for (const tid of teamIds) {
        const isMember = await checkTeamMembership(db, ctx.userId, tid);
        if (!isMember) throw new ApiError(403, "forbidden", "not a member of this team");
      }

      await (db as any).transaction(async (tx: any) => {
        for (const move of moves) {
          await (tx.update(shortcuts) as any)
            .set({
              parentId: move.parentId,
              order: move.position,
              updatedAt: new Date(),
            })
            .where(eq(shortcuts.id, move.shortcutId));
        }
      });
    },

    // ── setShortcutVisibleRoles ───────────────────────────────────────────────
    /**
     * Atomically swap the permission_roles for a shortcut.
     * Mirrors the `shortcut_set_visible_roles` plpgsql RPC logic:
     *   1. Upsert a permissions row (resource_type='shortcut', resource_id=shortcutId).
     *   2. Delete all existing permission_roles for that permissions row.
     *   3. Insert new permission_roles for each roleId.
     */
    async setShortcutVisibleRoles(
      shortcutId: string,
      { roleIds }: { roleIds: string[] },
    ) {
      // Look up the shortcut to get teamId (required for permissions row)
      const [sc] = await (db.select() as any)
        .from(shortcuts)
        .where(eq(shortcuts.id, shortcutId))
        .limit(1);
      if (!sc) throw new ApiError(404, "not_found", "shortcut not found");

      await (db as any).transaction(async (tx: any) => {
        // Find existing permissions row for this shortcut
        let [perm] = await (tx.select() as any)
          .from(permissions)
          .where(
            and(
              eq(permissions.resourceType, "shortcut"),
              eq(permissions.resourceId, shortcutId),
            ),
          )
          .limit(1);

        if (!perm) {
          // Create a permissions row for this shortcut
          [perm] = await (tx.insert(permissions) as any)
            .values({
              teamId: sc.teamId,
              resourceType: "shortcut",
              resourceId: shortcutId,
              code: `shortcut-${shortcutId}`,
            })
            .returning();
        }

        // Delete existing permission_roles
        await (tx.delete(permissionRoles) as any).where(
          eq(permissionRoles.permissionId, perm.id),
        );

        // Insert new roleIds
        if (roleIds.length) {
          await (tx.insert(permissionRoles) as any).values(
            roleIds.map((roleId) => ({ permissionId: perm.id, roleId })),
          );
        }
      });
    },

    // ── listTeamRoles ─────────────────────────────────────────────────────────
    async listTeamRoles(teamId: string) {
      const rows = await (db.select() as any)
        .from(teamRoles)
        .where(eq(teamRoles.teamId, teamId));
      return rows.map((r: any) => ({
        id: r.id,
        teamId: r.teamId,
        code: r.code,
        name: r.name,
      }));
    },

    // ── listTeamPermissions ───────────────────────────────────────────────────
    async listTeamPermissions(teamId: string) {
      const permRows = await (db.select() as any)
        .from(permissions)
        .where(eq(permissions.teamId, teamId));

      if (!permRows.length) return [];

      const permIds = permRows.map((p: any) => p.id);
      const prRows = await (db.select() as any)
        .from(permissionRoles)
        .where(inArray(permissionRoles.permissionId, permIds));

      // Build permId → roleIds
      const permIdToRoles = new Map<string, string[]>();
      for (const pr of prRows) {
        if (!permIdToRoles.has(pr.permissionId)) permIdToRoles.set(pr.permissionId, []);
        permIdToRoles.get(pr.permissionId)!.push(pr.roleId);
      }

      return permRows.map((p: any) => ({
        resourceId: p.resourceId,
        roleIds: permIdToRoles.get(p.id) ?? [],
      }));
    },

    // ── listShortcutRoleBindings ──────────────────────────────────────────────
    /**
     * Returns raw permission_roles for shortcuts (resource_type='shortcut')
     * in a team. Mirrors the supabase-repo shape:
     *   [{ resource_id, permission_roles: [{ role_id }] }]
     */
    async listShortcutRoleBindings(teamId: string) {
      const permRows = await (db.select() as any)
        .from(permissions)
        .where(
          and(
            eq(permissions.teamId, teamId),
            eq(permissions.resourceType, "shortcut"),
          ),
        );

      if (!permRows.length) return [];

      const permIds = permRows.map((p: any) => p.id);
      const prRows = await (db.select() as any)
        .from(permissionRoles)
        .where(inArray(permissionRoles.permissionId, permIds));

      const permIdToRoles = new Map<string, Array<{ role_id: string }>>();
      for (const pr of prRows) {
        if (!permIdToRoles.has(pr.permissionId)) permIdToRoles.set(pr.permissionId, []);
        permIdToRoles.get(pr.permissionId)!.push({ role_id: pr.roleId });
      }

      return permRows.map((p: any) => ({
        resource_id: p.resourceId,
        permission_roles: permIdToRoles.get(p.id) ?? [],
      }));
    },
  };
}
