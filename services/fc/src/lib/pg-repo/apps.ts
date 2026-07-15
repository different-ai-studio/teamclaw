/**
 * Apps domain — pg-repo implementation.
 *
 * An "app" owns a 1:1 workspace. createApp provisions a workspaces row and
 * links it via apps.workspace_id. Identity is resolved server-side from
 * ctx.userId via the authz helpers (per-team actor resolution).
 */

import { eq, sql } from "drizzle-orm";
import { apps, workspaces, sessions } from "../../db/schema/index.js";
import { requireActorForTeam, resolveActorForTeam } from "./authz.js";
import { isLegalStatusTransition } from "./app-status.js";
import { isLegalFcTransition } from "../provisioning/app-fc-status.js";
import { appOssObjectName } from "../provisioning/app-deploy.js";
import { ApiError } from "../http-utils.js";
import { managedGitCredential } from "../admin-handlers.js";

type AppsCtx = { userId?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

function slugify(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string | null => (v ? new Date(v).toISOString() : null);

// Shared mapper — exposes EXACTLY the 12 canonical app fields. Reused by
// listApps/updateApp in the next task.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapApp(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    slug: r.slug,
    type: r.type,
    visibility: r.visibility,
    workspaceId: r.workspaceId ?? null,
    gitRemoteUrl: r.gitRemoteUrl ?? null,
    provisionStatus: r.provisionStatus,
    fcStatus: r.fcStatus ?? null,
    fcEndpoint: r.fcEndpoint ?? null,
    fcFunctionName: r.fcFunctionName ?? null,
    fcRegion: r.fcRegion ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

export type AppsRepoDeps = {
  provisionAppRepo?: (
    args: { appId: string; teamId: string },
  ) => Promise<{ gitRemoteUrl: string; gitAuthKind: string } | null>;
  startDeploy?: (a: { appId: string; slug: string; region: string }) =>
    Promise<{ fcFunctionName: string; fcRegion: string; ossObjectName: string; databaseUrl: string; presignedPut: string }>;
  finalizeDeploy?: (a: { fcFunctionName: string; ossObjectName: string }) =>
    Promise<{ fcEndpoint: string }>;
};

export function makeAppsRepo(db: DbLike, ctx: AppsCtx = {}, deps: AppsRepoDeps = {}) {
  // Loads the raw app row only if it is visible to the caller. A row is
  // visible when (a) there is no authenticated user (internal/system path),
  // or (b) the caller has an actor in the app's team AND the app is
  // team-visible OR the caller is its creator. Returns null otherwise.
  // Shared by getApp / updateApp / listAppSessions so visibility is enforced
  // in exactly one place.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function loadVisibleApp(appId: string): Promise<any | null> {
    const [row] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
    if (!row) return null;
    if (ctx.userId) {
      const callerActorId = await resolveActorForTeam(db, ctx.userId, row.teamId);
      if (!callerActorId) return null;
      if (row.visibility !== "team" && row.createdByActorId !== callerActorId) {
        return null;
      }
    }
    return row;
  }

  return {
    async createApp(input: { teamId: string; name: string; type: string; visibility?: string }) {
      if (!ctx.userId) throw new Error("unauthenticated");
      const createdByActorId = await requireActorForTeam(db, ctx.userId, input.teamId);
      const slug = slugify(input.name);

      const [ws] = await db
        .insert(workspaces)
        .values({
          teamId: input.teamId,
          createdByMemberId: createdByActorId,
          name: `app-${slug}-${Math.random().toString(36).slice(2, 8)}`,
        })
        .returning();

      const [row] = await db
        .insert(apps)
        .values({
          teamId: input.teamId,
          createdByActorId,
          name: input.name,
          slug,
          type: input.type,
          visibility: input.visibility === "team" ? "team" : "personal",
          workspaceId: ws.id,
          provisionStatus: "pending",
        })
        .returning();

      // Provision the per-app git repo via the injected dependency (mirrors how
      // teams provision LiteLLM). On success we record the remote + authKind and
      // advance provision_status to "repo_created"; on failure we capture the
      // error and set provision_status to "error" (the app row is still created).
      if (deps.provisionAppRepo) {
        try {
          const res = await deps.provisionAppRepo({ appId: row.id, teamId: input.teamId });
          if (res?.gitRemoteUrl) {
            const [updated] = await db
              .update(apps)
              .set({
                gitRemoteUrl: res.gitRemoteUrl,
                gitAuthKind: res.gitAuthKind,
                provisionStatus: "repo_created",
                updatedAt: new Date(),
              })
              .where(eq(apps.id, row.id))
              .returning();
            return mapApp(updated);
          }
        } catch (e: any) {
          const [errd] = await db
            .update(apps)
            .set({
              provisionStatus: "error",
              provisionError: String(e?.message ?? e),
              updatedAt: new Date(),
            })
            .where(eq(apps.id, row.id))
            .returning();
          return mapApp(errd);
        }
      }

      return mapApp(row);
    },

    async getApp(appId: string) {
      const row = await loadVisibleApp(appId);
      if (!row) return null;
      return mapApp(row);
    },

    async getManagedGitCredential(teamId: string) {
      if (ctx.userId) {
        const callerActorId = await resolveActorForTeam(db, ctx.userId, teamId);
        if (!callerActorId) return null;
      }
      const cred = managedGitCredential();
      if (!cred) throw new ApiError(503, "managed_git_unavailable", "managed git is not configured");
      return cred;
    },

    async listApps({ teamId, limit = 100 }: { teamId: string; limit?: number }) {
      if (!ctx.userId) return [];
      const callerActorId = await resolveActorForTeam(db, ctx.userId, teamId);
      if (!callerActorId) return [];

      const rows = await (db as any).execute(sql`
        SELECT id, team_id AS "teamId", name, slug, type, visibility,
               workspace_id AS "workspaceId", git_remote_url AS "gitRemoteUrl",
               provision_status AS "provisionStatus", fc_status AS "fcStatus",
               fc_endpoint AS "fcEndpoint", fc_function_name AS "fcFunctionName", fc_region AS "fcRegion",
               created_at AS "createdAt", updated_at AS "updatedAt"
          FROM apps
         WHERE team_id = ${teamId}
           AND (
             visibility = 'team'
             OR created_by_actor_id = ${callerActorId}
             OR EXISTS (
               SELECT 1 FROM app_member_access ama
                WHERE ama.app_id = apps.id AND ama.member_id = ${callerActorId}
             )
           )
         ORDER BY created_at DESC
         LIMIT ${limit}
      `);
      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return result.map(mapApp);
    },

    async updateApp(appId: string, patch: { name?: string; visibility?: string; provisionStatus?: string }) {
      // Authz: only the creator may mutate the app. Load the row (gated by
      // visibility), then require the caller to be its creator. Returning null
      // here makes the route surface a 404 rather than silently mutating an
      // app the caller cannot see/own — avoids an IDOR if the DB connection
      // bypasses RLS.
      const existing = await loadVisibleApp(appId);
      if (!existing) return null;
      if (ctx.userId) {
        const callerActorId = await resolveActorForTeam(db, ctx.userId, existing.teamId);
        if (!callerActorId || existing.createdByActorId !== callerActorId) return null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const set: any = { updatedAt: new Date() };
      if (typeof patch.name === "string" && patch.name.length > 0) set.name = patch.name;
      if (patch.visibility === "team" || patch.visibility === "personal") set.visibility = patch.visibility;
      if (typeof patch.provisionStatus === "string") {
        if (isLegalStatusTransition(existing.provisionStatus, patch.provisionStatus)) {
          set.provisionStatus = patch.provisionStatus;
        } else if (set.name === undefined && set.visibility === undefined) {
          throw new ApiError(400, "invalid_status_transition",
            `cannot move provision_status ${existing.provisionStatus} -> ${patch.provisionStatus}`);
        }
        // else: illegal status alongside other fields → silently ignore status.
      }
      const [row] = await db.update(apps).set(set).where(eq(apps.id, appId)).returning();
      if (!row) return null;
      return mapApp(row);
    },

    async deployApp(appId: string) {
      const existing = await loadVisibleApp(appId);
      if (!existing) return null;
      if (ctx.userId) {
        const a = await resolveActorForTeam(db, ctx.userId, existing.teamId);
        if (!a || existing.createdByActorId !== a) return null;
      }
      if (existing.provisionStatus !== "ready") {
        throw new ApiError(409, "app_not_ready", "app must be seeded (provision_status=ready) before deploy");
      }
      if (!deps.startDeploy) throw new ApiError(503, "deploy_unavailable", "deploy provisioning not configured");
      try {
        const r = await deps.startDeploy({ appId, slug: existing.slug, region: process.env.REGION || "cn-hangzhou" });
        const [row] = await db.update(apps).set({
          fcFunctionName: r.fcFunctionName, fcRegion: r.fcRegion,
          fcStatus: "awaiting_build", provisionError: null, updatedAt: new Date(),
        }).where(eq(apps.id, appId)).returning();
        return { ...mapApp(row), ossObjectName: r.ossObjectName, presignedPut: r.presignedPut };
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        await db.update(apps).set({
          fcStatus: "deploy_error", provisionError: String(e?.message ?? e), updatedAt: new Date(),
        }).where(eq(apps.id, appId));
        throw new ApiError(502, "deploy_failed", String(e?.message ?? e));
      }
    },

    async finalizeDeploy(appId: string) {
      const existing = await loadVisibleApp(appId);
      if (!existing) return null;
      if (ctx.userId) {
        const a = await resolveActorForTeam(db, ctx.userId, existing.teamId);
        if (!a || existing.createdByActorId !== a) return null;
      }
      if (!existing.fcFunctionName) throw new ApiError(409, "not_deploying", "app has no function; call deploy first");
      if (!isLegalFcTransition(existing.fcStatus, "deploying")) {
        throw new ApiError(409, "invalid_deploy_state", `cannot finalize from fc_status ${existing.fcStatus}`);
      }
      if (!deps.finalizeDeploy) throw new ApiError(503, "deploy_unavailable", "deploy provisioning not configured");
      await db.update(apps).set({ fcStatus: "deploying", updatedAt: new Date() }).where(eq(apps.id, appId));
      try {
        const r = await deps.finalizeDeploy({ fcFunctionName: existing.fcFunctionName, ossObjectName: appOssObjectName(appId) });
        const [row] = await db.update(apps).set({
          fcStatus: "live", fcEndpoint: r.fcEndpoint, provisionError: null, updatedAt: new Date(),
        }).where(eq(apps.id, appId)).returning();
        return mapApp(row);
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        await db.update(apps).set({ fcStatus: "deploy_error", provisionError: String(e?.message ?? e), updatedAt: new Date() }).where(eq(apps.id, appId));
        throw new ApiError(502, "finalize_failed", String(e?.message ?? e));
      }
    },

    async listAppSessions(appId: string) {
      // Reuse the same visibility gate as getApp: a caller who cannot see the
      // app gets an empty list rather than its sessions.
      const visible = await loadVisibleApp(appId);
      if (!visible) return [];
      const rows = await db
        .select({
          id: sessions.id,
          teamId: sessions.teamId,
          title: sessions.title,
          mode: sessions.mode,
          lastMessageAt: sessions.lastMessageAt,
          createdAt: sessions.createdAt,
          updatedAt: sessions.updatedAt,
        })
        .from(sessions)
        .where(eq(sessions.appId, appId));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({
        id: r.id,
        teamId: r.teamId,
        title: r.title ?? "",
        mode: r.mode ?? "collab",
        lastMessageAt: iso(r.lastMessageAt),
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
      }));
    },
  };
}
