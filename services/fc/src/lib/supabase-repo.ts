import { randomUUID } from "node:crypto";
import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import { ApiError } from "./http-utils.js";
import { isLegalStatusTransition } from "./pg-repo/app-status.js";
import { isLegalFcTransition } from "./provisioning/app-fc-status.js";
import { appOssObjectName } from "./provisioning/app-deploy.js";
import { normalizeAgentTypes } from "./agent-types.js";
import { managedGitCredential } from "./admin-handlers.js";
import { computeRange, getLiteLlmSql, queryTeamUsage } from "./litellm-usage.js";
import { litellmFetch as sharedLitellmFetch } from "./litellm.js";
import {
  REALTIME_TRANSPORT_OPTS, requiredRow, requiredString, requiredInteger,
  DEFAULT_ATTACHMENT_BUCKET, TEAM_COLUMNS, MESSAGE_COLUMNS, WORKSPACE_COLUMNS, mapDefaultAgentError,
  APP_COLUMNS, slugify, appIso, mapApp, SESSION_FULL_COLUMNS, ACTOR_DIRECTORY_COLUMNS,
  mapSessionFull, mapDirectoryActor, publishableKeyFromEnv, outgoingMessageRow,
  mapTeam, mapSession, mapMessage, mapWorkspace, mapShortcut, mapTeamRole, mapPermission,
  mapActor, mapTeamMember, mapIdeaRow, mapShortcutRow, mapAgentRuntimeRow, mapIdeaActivityRow,
  mapFeedbackRow, mapLeaderboardRow,
} from "./supabase-repo/shared.js";
export { publishableKeyFromEnv } from "./supabase-repo/shared.js";
export { createSupabaseAuthRepository } from "./supabase-repo/auth.js";
import { normalizePhone } from "./supabase-repo/phone-auth.js";

/** Archive sessions bound to a workspace via agent_runtimes.workspace_id. */
async function archiveSessionsForWorkspace(supabase, workspaceId) {
  const { data: runtimes, error: rtError } = await supabase
    .from("agent_runtimes")
    .select("session_id")
    .eq("workspace_id", workspaceId)
    .not("session_id", "is", null);
  if (rtError) throw rtError;

  const sessionIds = [...new Set(
    (runtimes ?? [])
      .map((row) => row.session_id)
      .filter((id) => typeof id === "string" && id.length > 0),
  )];
  if (sessionIds.length === 0) return;

  const archivedAt = new Date().toISOString();
  const { error } = await supabase
    .from("sessions")
    .update({ archived_at: archivedAt, updated_at: archivedAt })
    .in("id", sessionIds)
    .is("archived_at", null);
  if (error) throw error;
}

export function createSupabaseBusinessRepository(options) {
  const {
    supabaseUrl,
    // Browser-reachable base for public asset URLs. SUPABASE_URL is typically an
    // internal/VPC address the frontend can't reach; fall back to it when unset.
    supabasePublicUrl = supabaseUrl,
    publishableKey,
    accessToken,
    createClient = defaultCreateClient,
    createServiceRoleClient: createServiceRoleClientOpt,
    provisionLiteLlm,
    // Injectable for tests; defaults to proxying the LiteLLM gateway /v1/models.
    fetchLiteLlmModels: fetchLiteLlmModelsOpt,
    provisionAppRepo,
    startDeploy,
    finalizeDeploy,
    // Injectable for tests; defaults to querying the LiteLLM RDS directly.
    queryLiteLlmUsage = (litellmTeamId, range) => queryTeamUsage(getLiteLlmSql(), litellmTeamId, range),
    // Injectable for tests; defaults to the shared LiteLLM HTTP client.
    litellmFetch: litellmFetchOpt,
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  if (!accessToken) throw new Error("accessToken is required");

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "amux" }, realtime: REALTIME_TRANSPORT_OPTS,
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  async function requireCallerTeamOwner(targetTeamId) {
    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }

    const { data: actor, error: actorErr } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", targetTeamId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (actorErr) throw actorErr;
    if (!actor?.id) {
      throw new ApiError(403, "forbidden", "not a member of this team");
    }

    const { data: membership, error: memberErr } = await supabase
      .from("team_members")
      .select("role")
      .eq("team_id", targetTeamId)
      .eq("member_id", actor.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!membership || membership.role !== "owner") {
      throw new ApiError(403, "forbidden", "only team owners may change team share mode");
    }
  }

  async function requireCallerTeamMember(targetTeamId) {
    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }
    const { data: actor, error: actorErr } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", targetTeamId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (actorErr) throw actorErr;
    if (!actor?.id) {
      throw new ApiError(403, "forbidden", "not a member of this team");
    }
  }

  // Like requireCallerTeamMember, but returns the caller's own team-scoped
  // actors.id instead of discarding it. Used by endpoints (e.g.
  // ensureMemberKey) that must resolve "my own actor in this team" — this is
  // intentionally NOT the same as the legacy current_member_id() DB helper,
  // which returns the oldest actor across ALL teams (not team-scoped) and has
  // caused cross-team leakage bugs.
  async function requireCallerTeamMemberActor(targetTeamId) {
    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }
    const { data: actor, error: actorErr } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", targetTeamId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (actorErr) throw actorErr;
    if (!actor?.id) {
      throw new ApiError(403, "forbidden", "not a member of this team");
    }
    return actor.id as string;
  }

  // Shared by setupLiteLlm() and ensureMemberKey(): provisions a LiteLLM team
  // (if not already configured) and persists litellm_team_id +
  // ai_gateway_endpoint via the update_team_litellm RPC. Returns the FULL
  // provisioning result (including the LiteLLM-generated litellmTeamId) so
  // callers never need to reconstruct/guess the id — provisionTeamLiteLLM
  // persists whatever team_id LiteLLM's own POST /team/new assigns, NOT a
  // deterministic `tc-${teamId}` value, so any code that assumed the latter
  // would silently talk to the wrong (or a non-existent) LiteLLM team.
  async function provisionLiteLlmForTeam(teamId) {
    const provisioner = provisionLiteLlm ?? (await import("./team-provisioning.js")).provisionTeamLiteLLM;
    const { data: teamRow, error: teamErr } = await supabase
      .from("teams")
      .select("id, name")
      .eq("id", teamId)
      .single();
    if (teamErr) throw teamErr;
    const provisioning = await provisioner(teamRow?.name ?? teamId);
    if (!provisioning) {
      throw new ApiError(
        503,
        "litellm_unavailable",
        "LiteLLM provisioning is not configured (LITELLM_MASTER_KEY missing)",
      );
    }
    const { error: rpcErr } = await supabase.rpc("update_team_litellm", {
      p_team_id: teamId,
      p_litellm_team_id: provisioning.litellmTeamId,
      p_ai_gateway_endpoint: provisioning.aiGatewayEndpoint,
    });
    if (rpcErr) throw rpcErr;
    return provisioning;
  }

  async function shareModeServiceRpc(rpcName, args) {
    let admin;
    if (createServiceRoleClientOpt) {
      admin = createServiceRoleClientOpt();
    } else {
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
      if (!serviceKey) {
        throw new Error(
          "SUPABASE_SERVICE_ROLE_KEY is not configured on FC; cannot change team share mode",
        );
      }
      const { createServiceRoleClient } = await import("./supabase.js");
      admin = createServiceRoleClient();
    }
    const { data, error } = await admin.rpc(rpcName, args);
    if (error) {
      const code = error?.code || "";
      if (code === "PGRST202") {
        throw new Error(
          `${rpcName} RPC is missing on the database (apply migration 20260604120000_disable_team_share)`,
        );
      }
      throw error;
    }
    return data;
  }

  return {
    async listTeams({ limit = 50 } = {}) {
      // ACTOR-SCOPED "my current teams". RLS (teams_org_guard) already scopes
      // rows to the caller's current org, but an org can contain teams the
      // caller is NOT an actor in (e.g. a mis-provisioned / shared "Personal"
      // org, or a team created by another member). Returning those makes the
      // client adopt a "current team" it can't act on — every team-scoped RPC
      // then fails, most visibly `create_team_invite` ("create_team_invite
      // requires team membership") during daemon onboarding. The SECURITY
      // DEFINER RPC intersects org-scope with the caller's actor membership.
      const { data, error } = await supabase.rpc("list_my_teams_current_org");
      if (error) throw error;
      return (data ?? []).slice(0, limit).map(mapTeam);
    },

    // List the caller's teams across ALL orgs they belong to (cross-org team
    // picker). The `list_all_my_teams` function lives in the `amux` schema and is
    // SECURITY DEFINER (it bypasses teams_org_guard). The default client schema
    // here is `amux`, so it resolves via a plain `.rpc(...)` like create_team etc.
    async listAllMyTeams() {
      const { data, error } = await supabase.rpc("list_all_my_teams");
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.team_id,
        name: r.team_name,
        slug: r.team_slug ?? null,
        orgId: r.org_id ?? null,
        orgName: r.org_name ?? null,
      }));
    },

    async createTeam(input) {
      // Bootstrap (no-invite) onboarding. Behavior depends on the caller's org:
      //   * DEFAULT_ORG (betly's shared consumer tenant): each user gets their
      //     OWN independent solo team — random individuals stay isolated.
      //   * a REAL customer org (e.g. a climbing gym): everyone bootstrapping
      //     into that org joins ONE shared team (the org's oldest team). The
      //     first user seeds it as owner; later users join as plain members.
      // The amux.join_or_create_org_team RPC makes this decision server-side,
      // keying the join strictly off the verified token's org (it cannot be
      // steered by the client).
      const defaultOrgId = process.env.DEFAULT_ORG_ID || null;
      // Resolve a fallback org to STAMP on a newly created team when the token
      // carries no org. Same order as before: JWT app_metadata.org_id →
      // DEFAULT_ORG_ID → lazily provisioned personal org. The RPC prefers the
      // authoritative token org and only uses this fallback when that is null.
      const { data: caller } = await supabase.auth.getUser();
      let fallbackOrg: string | null =
        (caller?.user?.app_metadata as any)?.org_id ?? null;
      if (!fallbackOrg) fallbackOrg = defaultOrgId;
      if (!fallbackOrg && caller?.user?.id) {
        const { data: provisioned, error: orgErr } =
          await supabase.rpc("ensure_personal_org");
        if (orgErr) throw orgErr;
        fallbackOrg = (provisioned as string | null) ?? null;
      }
      // p_name/p_slug/p_litellm_team_id/p_ai_gateway_endpoint only apply to the
      // CREATE branch (default org, or the org's first user). When joining an
      // existing org team the RPC ignores them.
      const { data, error } = await supabase.rpc("join_or_create_org_team", {
        p_fallback_org: fallbackOrg,
        p_default_org_id: defaultOrgId,
        p_name: input.name ?? null,
        p_slug: input.slug ?? null,
        p_display_name: input.displayName ?? null,
        p_litellm_team_id: input.litellmTeamId ?? null,
        p_ai_gateway_endpoint: input.aiGatewayEndpoint ?? null,
      });
      if (error) throw error;
      const row = requiredRow(data, "teams.createTeam");
      return mapTeam({
        id: row.team_id ?? row.id,
        name: row.team_name ?? row.name,
        slug: row.team_slug ?? row.slug,
        created_at: row.created_at ?? null,
      });
    },

    async getTeam(teamId) {
      const { data, error } = await supabase
        .from("teams")
        .select(`${TEAM_COLUMNS}, oid`)
        .eq("id", teamId)
        .single();
      if (error) throw error;
      // Resolve the org name with an explicit lookup instead of a PostgREST
      // embed (`orgs:oid(name)`). The teams→orgs FK crosses schemas
      // (amux.teams.oid → public.orgs.id); PostgREST's cross-schema relationship
      // inference is not reliably present in the self-host schema cache, which
      // surfaced as PGRST200 "Could not find a relationship between 'teams' and
      // 'oid'". A direct query against public.orgs works on both prod and
      // self-host.
      let orgs: { name: string } | null = null;
      if (data?.oid) {
        const { data: org } = await supabase
          .schema("public")
          .from("orgs")
          .select("name")
          .eq("id", data.oid)
          .maybeSingle();
        orgs = org ?? null;
      }
      return mapTeam({ ...data, orgs });
    },

    async renameTeam(teamId, { name }) {
      const { data, error } = await supabase.rpc("rename_team", { p_team_id: teamId, p_name: name });
      if (error) throw error;
      return mapTeam(requiredRow(data, "teams.renameTeam"));
    },

    // Account upgrade: graduate the caller out of the shared DEFAULT_ORG into
    // their own org (create org + reparent/rename their team). See
    // docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md §8.
    async upgradeAccount({ teamId, orgName, contact }) {
      const defaultOrgId = process.env.DEFAULT_ORG_ID || null;
      const { data, error } = await supabase.rpc("upgrade_account_to_org", {
        p_team_id: teamId,
        p_org_name: orgName,
        p_contact: contact ?? null,
        p_default_org_id: defaultOrgId,
      });
      if (error) {
        const code = error?.code || "";
        if (code === "42501") throw new ApiError(403, "forbidden", error.message ?? "not allowed");
        if (code === "23514") throw new ApiError(400, "validation_failed", error.message ?? "invalid upgrade");
        throw new ApiError(400, "validation_failed", error.message ?? "upgrade failed");
      }
      const row = requiredRow(data, "account.upgradeAccount");
      return {
        orgId: requiredString(row.org_id, "account.upgradeAccount", "org_id"),
        teamId: requiredString(row.team_id, "account.upgradeAccount", "team_id"),
        teamName: requiredString(row.team_name, "account.upgradeAccount", "team_name"),
      };
    },

    // Phone identity upgrade (betly-aligned): bind a phone to the caller's
    // account via our own verification code + a public.users row in the default
    // org (NOT GoTrue phone_change). See bind_phone_to_account RPC.
    async bindPhone({ phone, code }) {
      const defaultOrgId = process.env.DEFAULT_ORG_ID || null;
      // Match send-code's canonical bare 11-digit form so the verify-code lookup
      // (and the stored public.users.mobile) line up; clients send E.164 +86….
      const { data, error } = await supabase.rpc("bind_phone_to_account", {
        p_phone: normalizePhone(phone),
        p_code: code,
        p_default_org_id: defaultOrgId,
      });
      if (error) {
        const c = error?.code || "";
        if (c === "42501") throw new ApiError(403, "forbidden", error.message ?? "not allowed");
        if (c === "23505") throw new ApiError(409, "conflict", error.message ?? "phone already in use");
        if (c === "23514") throw new ApiError(400, "validation_failed", error.message ?? "invalid bind");
        throw new ApiError(400, "validation_failed", error.message ?? "phone bind failed");
      }
      const row = requiredRow(data, "account.bindPhone");
      return { userId: requiredString(row.user_id, "account.bindPhone", "user_id"), bound: Boolean(row.bound) };
    },

    async createTeamInvite(teamId, input) {
      // Default-org teams are solo-only: a personal team sitting in the shared
      // DEFAULT_ORG cannot pull in members. The user must first upgrade their
      // account (which moves the team into their own org). Agent invites (the
      // daemon's amuxd init) are still allowed so local runtimes work.
      const defaultOrgId = process.env.DEFAULT_ORG_ID || "";
      if (defaultOrgId && input.kind === "member") {
        const { data: team } = await supabase
          .schema("amux")
          .from("teams")
          .select("oid")
          .eq("id", teamId)
          .maybeSingle();
        if (team?.oid === defaultOrgId) {
          throw new ApiError(
            403,
            "upgrade_required",
            "升级账号后才能邀请成员加入团队",
          );
        }
      }
      const args: any = {
        p_team_id: teamId,
        p_kind: input.kind,
        p_display_name: input.displayName,
      };
      if (input.teamRole != null) args.p_team_role = input.teamRole;
      if (input.agentKind != null) args.p_agent_kind = input.agentKind;
      if (input.ttlSeconds != null) args.p_ttl_seconds = input.ttlSeconds;
      if (input.targetActorId != null) args.p_target_actor_id = input.targetActorId;
      const { data, error } = await supabase.rpc("create_team_invite", args);
      if (error) throw error;
      const row = requiredRow(data, "teams.createTeamInvite");
      return {
        token: requiredString(row.token, "teams.createTeamInvite", "token"),
        expiresAt: row.expires_at ?? null,
        deeplink: row.deeplink ?? null,
      };
    },

    async removeTeamActor(_teamId, actorId) {
      const { error } = await supabase.rpc("remove_team_actor", { p_actor_id: actorId });
      if (error) throw error;

      // Best-effort: delete the removed actor's LiteLLM key (replaces the
      // legacy POST /ai/remove-member endpoint). Never blocks/fails actor
      // removal — deleteMemberKey swallows its own errors, and we also guard
      // the dynamic import itself so a module-resolution failure can't throw
      // out of an already-committed removal (parity with pg-repo).
      try {
        const { deleteMemberKey } = await import("./team-provisioning.js");
        await deleteMemberKey(actorId);
      } catch (e) {
        console.warn("[removeTeamActor] LiteLLM key cleanup skipped:", (e as any)?.message);
      }
    },

    async updateCurrentActorProfile(actorId, { displayName, avatarUrl }) {
      const { data, error } = await supabase.rpc("update_current_actor_profile", {
        p_actor_id: actorId,
        p_display_name: displayName,
        p_avatar_url: avatarUrl ?? null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return mapDirectoryActor(row);
    },

    async getMemberDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_member_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      // RPC returns a scalar uuid (or null).
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async setMemberDefaultAgent(teamId, agentId) {
      const { data, error } = await supabase.rpc("set_member_default_agent", {
        p_team_id: teamId,
        p_agent_id: agentId ?? null,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async getTeamDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_team_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async setTeamDefaultAgent(teamId, agentId) {
      const { data, error } = await supabase.rpc("set_team_default_agent", {
        p_team_id: teamId,
        p_agent_id: agentId ?? null,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async getEffectiveDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_effective_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async reportClientVersion(teamId, body) {
      const { error } = await supabase.rpc("report_client_version", {
        p_team_id: teamId,
        p_client_type: body.clientType,
        p_version: body.version,
        p_device_id: body.deviceId,
        p_build: body.build ?? null,
      });
      if (error) throw error;
    },

    // --- Team share mode (Task 3 of share-onboarding refactor) ---

    async enableShareMode(teamId, mode, gitConfig) {
      await requireCallerTeamOwner(teamId);
      const args = {
        p_team_id: teamId,
        p_mode: mode,
        p_git_remote_url: mode === "oss" ? null : (gitConfig?.remoteUrl ?? null),
        p_git_auth_kind: mode === "oss" ? null : (gitConfig?.authKind ?? null),
        p_git_credential_ref: mode === "oss" ? null : (gitConfig?.credentialRef ?? null),
      };
      const data = await shareModeServiceRpc("enable_team_share", args);
      const row = requiredRow(data, "teams.enableShareMode");
      return mapTeam(row);
    },

    async getShareMode(teamId) {
      const { data, error } = await supabase
        .from("teams")
        .select("share_mode, share_enabled_at, git_remote_url, git_auth_kind")
        .eq("id", teamId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return {
          mode: null,
          enabledAt: null,
          gitRemoteUrl: null,
          gitAuthKind: null,
        };
      }
      return {
        mode: data.share_mode ?? null,
        enabledAt: data.share_enabled_at ?? null,
        gitRemoteUrl: data.git_remote_url ?? null,
        gitAuthKind: data.git_auth_kind ?? null,
      };
    },

    async disableShareMode(teamId) {
      await requireCallerTeamOwner(teamId);
      const data = await shareModeServiceRpc("disable_team_share", {
        p_team_id: teamId,
      });
      if (data) requiredRow(data, "teams.disableShareMode");
      return {
        mode: null,
        enabledAt: null,
        gitRemoteUrl: null,
        gitAuthKind: null,
      };
    },

    async setupLiteLlm(teamId) {
      // Lazy import keeps the LiteLLM client out of cold-path repo constructors
      // and makes it trivial to inject in tests via options.provisionLiteLlm.
      // Persist litellm_team_id + ai_gateway_endpoint via SECURITY DEFINER
      // RPC because team_workspace_config.litellm_team_id is guarded against
      // direct authenticated UPDATEs (see 20260527000004 guard trigger).
      const provisioning = await provisionLiteLlmForTeam(teamId);
      return {
        aiGatewayEndpoint: provisioning.aiGatewayEndpoint,
        litellmKey: provisioning.litellmKey,
      };
    },

    // Idempotently issues the CALLER's own per-member LiteLLM virtual key,
    // auto-provisioning the team's LiteLLM team first if it hasn't been set
    // up yet (A2-1). There is intentionally NO actorId parameter: the caller
    // can only ever provision a key for themselves, resolved team-scoped via
    // requireCallerTeamMemberActor (401 if unauthenticated, 403 if not a
    // member of teamId).
    async ensureMemberKey(teamId) {
      const actorId = await requireCallerTeamMemberActor(teamId);

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      let litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        // provisionLiteLlmForTeam persists the LiteLLM-generated team_id (from
        // provisionTeamLiteLLM's POST /team/new) into team_workspace_config —
        // NOT a deterministic `tc-${teamId}` value — so we take the id
        // straight from its return value rather than reconstructing it.
        const provisioning = await provisionLiteLlmForTeam(teamId);
        litellmTeamId = provisioning.litellmTeamId;
      }
      if (!litellmTeamId) {
        throw new ApiError(
          502,
          "litellm_team_id_missing",
          "LiteLLM team id was not persisted after setup",
        );
      }

      const { ensureMemberKeyFor } = await import("./team-provisioning.js");
      return ensureMemberKeyFor(litellmTeamId, actorId);
    },

    // Team-wide LiteLLM token + spend usage from the migrated LiteLLM RDS.
    // Any team member may read. The LiteLLM team id is NOT a deterministic
    // `tc-${teamId}` value — it's provisioner-generated and persisted into
    // team_workspace_config.litellm_team_id by setupLiteLlm/ensureMemberKey
    // (see the read pattern mirrored from ensureMemberKey above). If the team
    // has never provisioned LiteLLM, return an empty usage shape without
    // querying LiteLLM.
    async getLiteLlmUsage(teamId, opts: { range?: string; date?: string } = {}) {
      await requireCallerTeamMember(teamId);
      const range = computeRange((opts.range ?? "month") as any, opts.date);

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      const litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        return {
          litellmTeamId: null,
          range: range.range,
          startDate: range.startDate,
          endDate: range.endDate,
          startUtc: range.startUtc,
          endUtc: range.endUtc,
          summary: {
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalSpend: 0,
            requestCount: 0,
          },
          maxBudget: null,
          members: [],
          byModel: [],
        };
      }

      return queryLiteLlmUsage(litellmTeamId, range);
    },

    // Lists the team's LiteLLM virtual keys (masked). Any team member may
    // read — resolved via requireCallerTeamMemberActor (401/403). The
    // LiteLLM team id is NOT a deterministic `tc-${teamId}` value; it's
    // provisioner-generated and persisted into
    // team_workspace_config.litellm_team_id (see ensureMemberKey/getLiteLlmUsage
    // above). If the team has never provisioned LiteLLM, return an empty
    // keys list without calling LiteLLM.
    async listLiteLlmKeys(teamId) {
      await requireCallerTeamMemberActor(teamId);

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      const litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        return { teamId: null, keys: [] };
      }

      const fetcher = litellmFetchOpt ?? sharedLitellmFetch;
      const res = await fetcher(`/team/info?team_id=${litellmTeamId}`, "GET");
      if (!res.ok) {
        throw new ApiError(502, "litellm_error", "Failed to fetch team info from LiteLLM");
      }
      const keys = ((res.data as any)?.keys || []).map((k: any) => ({
        key: k.token ? `${k.token.slice(0, 10)}...` : "",
        alias: k.key_alias || "",
        spend: k.spend || 0,
        created_at: k.created_at || "",
      }));
      return { teamId: litellmTeamId, keys };
    },

    // Sets the team's LiteLLM max budget. Owner-only — resolved via
    // requireCallerTeamOwner (401/403). The LiteLLM team id is read from the
    // persisted team_workspace_config.litellm_team_id, NEVER reconstructed as
    // `tc-${teamId}`. If the team has never provisioned LiteLLM, throws 409
    // litellm_not_provisioned rather than implicitly setting it up — owner
    // intent must be explicit (call /litellm/setup first).
    async setLiteLlmBudget(teamId, { maxBudget }: { maxBudget?: unknown } = {}) {
      await requireCallerTeamOwner(teamId);

      if (maxBudget === undefined || maxBudget === null || Number.isNaN(Number(maxBudget))) {
        throw new ApiError(400, "missing_maxBudget", "maxBudget is required and must be numeric");
      }

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      const litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        throw new ApiError(409, "litellm_not_provisioned", "team has not provisioned LiteLLM");
      }

      const fetcher = litellmFetchOpt ?? sharedLitellmFetch;
      const res = await fetcher("/team/update", "POST", {
        team_id: litellmTeamId,
        max_budget: Number(maxBudget),
      });
      if (!res.ok) {
        throw new ApiError(502, "litellm_error", "Failed to update LiteLLM budget");
      }

      return { maxBudget: Number(maxBudget) };
    },

    async getWorkspaceConfig(teamId) {
      const [teamRes, configRes] = await Promise.all([
        supabase
          .from("teams")
          .select("share_mode, git_remote_url, git_auth_kind")
          .eq("id", teamId)
          .maybeSingle(),
        supabase
          .from("team_workspace_config")
          .select("sync_mode, litellm_team_id, ai_gateway_endpoint, llm_enabled, llm_base_url, llm_models")
          .eq("team_id", teamId)
          .maybeSingle(),
      ]);
      if (teamRes.error) throw teamRes.error;
      if (configRes.error) throw configRes.error;
      const aiGatewayEndpoint = configRes.data?.ai_gateway_endpoint ?? null;
      // availableModels proxies the LiteLLM gateway GET /v1/models (the gateway
      // authoritatively lists its models) and degrades to [] whenever the
      // dep/endpoint/credential is missing or the call throws — it must never
      // fail the workspace-config request. FC does not persist a per-team
      // LiteLLM key, so the FC-level LITELLM_MASTER_KEY is used (same credential
      // setupLiteLlm/provisioning uses; the catalogue is gateway-wide).
      let availableModels: Array<{ id: string; name: string }> = [];
      try {
        if (aiGatewayEndpoint) {
          const fetcher =
            fetchLiteLlmModelsOpt ??
            (await import("./team-provisioning.js")).fetchLiteLlmModels;
          const key = process.env.LITELLM_MASTER_KEY || "";
          if (fetcher && key) {
            const out = await fetcher(aiGatewayEndpoint, key);
            if (Array.isArray(out)) availableModels = out;
          }
        }
      } catch {
        availableModels = [];
      }
      const storedModels = Array.isArray(configRes.data?.llm_models) ? configRes.data.llm_models : [];
      return {
        shareMode: teamRes.data?.share_mode ?? null,
        gitRemoteUrl: teamRes.data?.git_remote_url ?? null,
        gitAuthKind: teamRes.data?.git_auth_kind ?? null,
        syncMode: configRes.data?.sync_mode ?? null,
        litellmTeamId: configRes.data?.litellm_team_id ?? null,
        // `models` is the STORED, authoritative per-team list; `availableModels`
        // is the optional gateway picker source.
        llm: {
          enabled: configRes.data?.llm_enabled ?? false,
          baseUrl: configRes.data?.llm_base_url ?? null,
          models: storedModels,
          availableModels,
          aiGatewayEndpoint,
        },
      };
    },

    async setLlmConfig(teamId, input) {
      const { error } = await supabase
        .from("team_workspace_config")
        .upsert(
          {
            team_id: teamId,
            llm_enabled: input.enabled,
            llm_base_url: input.baseUrl,
            llm_models: input.models,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "team_id" },
        );
      if (error) throw error;
      return {
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        models: input.models,
      };
    },

    async listTeamActors(teamId, { kind = null, limit = 500 } = {}) {
      let query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("team_id", teamId);
      if (kind) query = query.eq("actor_type", kind);
      query = query.order("last_active_at", { ascending: false, nullsFirst: false })
                   .order("display_name", { ascending: true })
                   .limit(limit);
      const { data, error } = await query;
      if (error) throw error;
      return { items: (data ?? []).map(mapDirectoryActor) };
    },

    async getTeamDirectory(teamId) {
      const [actorsRes, membersRes] = await Promise.all([
        supabase
          .from("actor_directory")
          .select("id, team_id, kind, display_name, avatar_url, metadata")
          .eq("team_id", teamId),
        supabase
          .from("team_members")
          .select("actor_id, team_id, role, joined_at")
          .eq("team_id", teamId),
      ]);
      if (actorsRes.error) throw actorsRes.error;
      if (membersRes.error) throw membersRes.error;
      return {
        actors: (actorsRes.data ?? []).map(mapActor),
        members: (membersRes.data ?? []).map(mapTeamMember),
      };
    },

    async listSessions({ limit = 50, cursor = null } = {}) {
      const { data, error } = await supabase.rpc("list_current_actor_sessions", {
        p_limit: limit,
        p_before_last_message_at: cursor?.lastMessageAt ?? null,
        p_before_created_at: cursor?.createdAt ?? null,
        p_before_id: cursor?.id ?? null,
      });
      if (error) throw error;
      return (data ?? []).map(mapSession);
    },

    async listMessages(sessionId) {
      const query = supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId);
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapMessage);
    },

    async insertMessage(sessionId, input) {
      const { data, error } = await supabase
        .from("messages")
        .insert(outgoingMessageRow(sessionId, input))
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) throw error;
      return mapMessage(data);
    },

    async patchMessage(messageId, patch) {
      const row: any = {};
      if (patch.content !== undefined) row.content = patch.content;
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
      const { data, error } = await supabase
        .from("messages")
        .update(row)
        .eq("id", messageId)
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapMessage(data);
    },

    async deleteMessage(messageId) {
      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("id", messageId);
      if (error) throw error;
    },

    async listWorkspaces({ teamId, limit = 50, cursor = null, agentId = null }: any = {}) {
      let query = supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (agentId) {
        query = query.eq("agent_id", agentId);
      }
      if (cursor?.updatedAt) {
        query = query.lt("updated_at", cursor.updatedAt);
      }
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapWorkspace) };
    },

    async upsertWorkspace(input) {
      const row = {
        id: input.id,
        team_id: input.teamId,
        name: input.name,
        path: input.path ?? input.slug ?? null,
        agent_id: input.agentId ?? null,
        created_by_member_id: input.createdByMemberId ?? null,
        archived: input.archived ?? false,
      };
      const { data, error } = await supabase
        .from("workspaces")
        .upsert(row, { onConflict: "id" })
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) throw error;
      return mapWorkspace(data);
    },

    async getWorkspace(workspaceId) {
      const { data, error } = await supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("id", workspaceId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapWorkspace(data);
    },

    async patchWorkspace(workspaceId, patch) {
      const row: any = {};
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.archived !== undefined) row.archived = patch.archived;
      if (patch.slug !== undefined) row.path = patch.slug;
      if (patch.path !== undefined) row.path = patch.path;
      if (patch.agentId !== undefined) row.agent_id = patch.agentId;
      const { data, error } = await supabase
        .from("workspaces")
        .update(row)
        .eq("id", workspaceId)
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      if (patch.archived === true) {
        await archiveSessionsForWorkspace(supabase, workspaceId);
      }
      return mapWorkspace(data);
    },

    async getTeamWorkspaceConfig(teamId) {
      const { data, error } = await supabase
        .from("team_workspace_config")
        .select("team_id, default_workspace_id, pinned_workspace_ids, updated_at")
        .eq("team_id", teamId)
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        teamId: requiredString(row.team_id, "workspaces.getTeamWorkspaceConfig", "team_id"),
        defaultWorkspaceId: row.default_workspace_id ?? null,
        pinnedWorkspaceIds: row.pinned_workspace_ids ?? [],
        updatedAt: row.updated_at ?? null,
      };
    },

    async putTeamWorkspaceConfig(teamId, input) {
      const row = {
        team_id: teamId,
        default_workspace_id: input.defaultWorkspaceId ?? null,
        pinned_workspace_ids: input.pinnedWorkspaceIds ?? [],
      };
      const { data, error } = await supabase
        .from("team_workspace_config")
        .upsert(row, { onConflict: "team_id" })
        .select("team_id, default_workspace_id, pinned_workspace_ids, updated_at")
        .single();
      if (error) throw error;
      return {
        teamId: requiredString(data.team_id, "workspaces.putTeamWorkspaceConfig", "team_id"),
        defaultWorkspaceId: data.default_workspace_id ?? null,
        pinnedWorkspaceIds: data.pinned_workspace_ids ?? [],
        updatedAt: data.updated_at ?? null,
      };
    },

    async writeForegroundPresence({ deviceId, foregroundUntil }) {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) {
        throw new ApiError(401, "unauthorized", "no authenticated user");
      }
      const { error } = await supabase
        .from("client_presence")
        .upsert(
          { user_id: userId, device_id: deviceId, foreground_until: foregroundUntil },
          { onConflict: "user_id,device_id" }
        );
      if (error) throw error;
    },

    async listShortcutsByScope({ scope, teamId, parentId }: any = {}) {
      let query = supabase.from("shortcuts").select("*").eq("scope", scope);
      if (scope === "team" && teamId) query = query.eq("team_id", teamId);
      // Personal scope is gated by RLS on owner_member_id; no extra filter here.
      if (parentId !== undefined) {
        if (parentId === null) query = query.is("parent_id", null);
        else query = query.eq("parent_id", parentId);
      }
      const { data, error } = await query.order("order", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapShortcut);
    },

    async getNotificationPrefs() {
      const { data, error } = await supabase
        .from("notification_prefs")
        .select("user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at")
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      // Frontend expects snake_case raw row shape; returns null when caller
      // has no prefs row yet so it can fall back to DEFAULT_PREFS.
      return row ?? null;
    },

    async registerDevicePushToken(input) {
      // Identity comes from the bearer token, not the client, mirroring
      // writeForegroundPresence. Clients send device/platform/provider/token.
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const row = {
        user_id: userId,
        device_id: input.deviceId,
        platform: input.platform ?? "ios",
        provider: input.provider ?? "apns",
        token: input.token,
        app_version: input.appVersion ?? null,
        last_seen_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("device_push_tokens")
        .upsert(row, { onConflict: "user_id,device_id,provider" });
      if (error) throw error;
    },

    async putNotificationPrefs(input) {
      // Identity comes from the bearer token (auth.getUser), not the body —
      // CloudAPI clients no longer hold a Supabase user id.
      const { data: prefUser, error: prefUserErr } = await supabase.auth.getUser();
      if (prefUserErr) throw prefUserErr;
      const prefUserId = input.user_id ?? prefUser?.user?.id;
      if (!prefUserId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Accept snake_case from the frontend (matches the on-disk row shape).
      const row = {
        user_id: prefUserId,
        enabled: input.enabled ?? true,
        dnd_start_min: input.dnd_start_min ?? null,
        dnd_end_min: input.dnd_end_min ?? null,
        dnd_tz: input.dnd_tz ?? "Asia/Shanghai",
      };
      const { data, error } = await supabase
        .from("notification_prefs")
        .upsert(row, { onConflict: "user_id" })
        .select("user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at")
        .single();
      if (error) throw error;
      return data;
    },

    async muteSession(sessionId, input) {
      const row = {
        session_id: sessionId,
        until: input.until ?? null,
      };
      const { error } = await supabase
        .from("session_mutes")
        .upsert(row, { onConflict: "user_id,session_id" });
      if (error) throw error;
    },

    async unmuteSession(sessionId) {
      const { error } = await supabase
        .from("session_mutes")
        .delete()
        .eq("session_id", sessionId);
      if (error) throw error;
    },

    async listMutedSessions() {
      const { data, error } = await supabase
        .from("session_mutes")
        .select("session_id");
      if (error) throw error;
      return { items: (data ?? []).map((r) => r.session_id) };
    },

    async listIdeas({ teamId, archived = false, limit = 50, cursor = null }: any = {}) {
      let query = supabase
        .from("ideas")
        .select("*")
        .eq("team_id", teamId)
        .eq("archived", archived)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (cursor?.updatedAt) {
        query = query.lt("updated_at", cursor.updatedAt);
      }
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapIdeaRow) };
    },

    async getIdea(ideaId) {
      const { data, error } = await supabase
        .from("ideas")
        .select("*")
        .eq("id", ideaId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapIdeaRow(data);
    },

    async createIdea(body) {
      const args: any = {
        p_team_id: body.teamId,
        p_title: body.title,
        p_description: body.description ?? body.body ?? "",
      };
      if (body.workspaceId != null) args.p_workspace_id = body.workspaceId;
      const { data, error } = await supabase.rpc("create_idea", args);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const id = requiredString(row?.id, "ideas.createIdea", "id");
      return this.getIdea(id);
    },

    async updateIdea(ideaId, body) {
      const { error } = await supabase.rpc("update_idea", {
        p_idea_id: ideaId,
        p_title: body.title ?? null,
        p_workspace_id: body.workspaceId ?? null,
        p_description: body.description ?? body.body ?? null,
        p_status: body.status ?? null,
      });
      if (error) throw error;
      return this.getIdea(ideaId);
    },

    async archiveIdea(ideaId, { archived = true } = {}) {
      const { error } = await supabase.rpc("archive_idea", { p_idea_id: ideaId, p_archived: archived });
      if (error) throw error;
    },

    async listShortcuts(teamId, { parentId }: any = {}) {
      let query = supabase
        .from("shortcuts")
        .select("*")
        .eq("team_id", teamId)
        .order("order", { ascending: true });
      if (parentId !== undefined) {
        if (parentId === null) {
          query = query.is("parent_id", null);
        } else {
          query = query.eq("parent_id", parentId);
        }
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map(mapShortcutRow);
    },

    async getShortcut(shortcutId) {
      const { data, error } = await supabase
        .from("shortcuts")
        .select("*")
        .eq("id", shortcutId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapShortcutRow(data);
    },

    async createShortcut(body) {
      const args = {
        p_scope: body.scope,
        p_label: body.label,
        p_node_type: body.nodeType ?? body.kind,
        p_team_id: body.teamId ?? null,
        p_parent_id: body.parentId ?? null,
        p_icon: body.icon ?? null,
        p_order: body.order ?? body.position ?? 0,
        p_target: body.target ?? "",
      };
      const { data, error } = await supabase.rpc("shortcut_create", args);
      if (error) throw error;
      const id = requiredString(data, "shortcuts.createShortcut", "id");
      return this.getShortcut(id);
    },

    async updateShortcut(shortcutId, patch) {
      const body: any = {};
      if (patch.label !== undefined) body.label = patch.label;
      if (patch.payload !== undefined) body.payload = patch.payload;
      if (patch.parentId !== undefined) body.parent_id = patch.parentId;
      if (patch.position !== undefined) body.position = patch.position;
      const { data, error } = await supabase
        .from("shortcuts")
        .update(body)
        .eq("id", shortcutId)
        .select("*")
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapShortcutRow(data);
    },

    async deleteShortcut(shortcutId) {
      const { error } = await supabase
        .from("shortcuts")
        .delete()
        .eq("id", shortcutId);
      if (error) throw error;
    },

    async batchMoveShortcuts({ moves }) {
      const { error } = await supabase.rpc("shortcut_batch_move", {
        p_moves: moves.map((m) => ({ shortcut_id: m.shortcutId, parent_id: m.parentId, position: m.position })),
      });
      if (error) throw error;
    },

    async setShortcutVisibleRoles(shortcutId, { roleIds }) {
      const { error } = await supabase.rpc("shortcut_set_visible_roles", {
        p_shortcut_id: shortcutId,
        p_role_ids: roleIds,
      });
      if (error) throw error;
    },

    async listTeamRoles(teamId) {
      const { data, error } = await supabase
        .from("team_roles")
        .select("id, team_id, code, name")
        .eq("team_id", teamId);
      if (error) throw error;
      return (data ?? []).map((r) => ({ id: r.id, teamId: r.team_id, code: r.code, name: r.name }));
    },

    async listTeamPermissions(teamId) {
      const { data, error } = await supabase
        .from("permissions")
        .select("resource_id, permission_roles(role_id)")
        .eq("team_id", teamId);
      if (error) throw error;
      return (data ?? []).map((r) => ({ resourceId: r.resource_id, roleIds: (r.permission_roles ?? []).map((x) => x.role_id) }));
    },

    async createIdeaActivity(ideaId, body) {
      const { data, error } = await supabase.rpc("create_idea_activity", {
        p_idea_id: ideaId,
        p_activity_type: body.activityType ?? body.kind,
        p_content: body.content ?? null,
        p_metadata: body.metadata ?? null,
        p_attachment_urls: body.attachmentUrls ?? [],
      });
      if (error) throw error;
      return mapIdeaActivityRow(requiredRow(data, "ideas.createIdeaActivity"));
    },

    async listIdeaActivities(ideaId) {
      const { data, error } = await supabase
        .from("idea_activities")
        .select("id, team_id, idea_id, actor_id, activity_type, content, metadata, attachment_urls, created_at, updated_at")
        .eq("idea_id", ideaId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return { items: (data ?? []).map(mapIdeaActivityRow) };
    },

    async reorderIdeas({ teamId, ideaIds }) {
      const { error } = await supabase.rpc("reorder_ideas", {
        p_team_id: teamId,
        p_idea_ids: ideaIds,
      });
      if (error) throw error;
    },

    async upsertAgentRuntime(body) {
      // team_id is NOT NULL on public.agent_runtimes, but the daemon does not
      // send teamId in its request body. Derive it server-side from the agent
      // actor (actors.team_id) when the caller omits it. This Supabase client
      // is bound to the caller's bearer token, so the read runs under the
      // agent's RLS context (an agent can read its own actor row).
      let teamId = body.teamId;
      if (!teamId) {
        const { data: actorRow, error: actorErr } = await supabase
          .from("actors")
          .select("team_id")
          .eq("id", body.agentActorId)
          .maybeSingle();
        if (actorErr) throw actorErr;
        teamId = actorRow?.team_id ?? null;
      }
      if (!teamId) {
        throw new ApiError(
          400,
          "missing_team",
          "Unable to resolve team_id for agent runtime: agent actor not found or not visible",
        );
      }
      const row = {
        id: body.id ?? randomUUID(),
        team_id: teamId,
        agent_id: body.agentActorId,
        session_id: body.sessionId,
        runtime_id: body.runtimeId,
        backend_type: body.backendType ?? "claude",
        backend_session_id: body.backendSessionId,
        status: body.status ?? "running",
        workspace_id: body.workspaceId ?? null,
        current_model: body.currentModel ?? null,
        updated_at: new Date().toISOString(),
      };
      // The only matching unique index is agent_runtimes_agent_backend_uniq on
      // (agent_id, backend_session_id) (migration 202604220027). onConflict must
      // name a real unique constraint or Postgres raises 42P10.
      const { data, error } = await supabase
        .from("agent_runtimes")
        .upsert(row, { onConflict: "agent_id,backend_session_id" })
        .select("id")
        .single();
      if (error) throw error;
      return { id: data?.id ?? null };
    },

    async getAgentRuntime({ sessionId, runtimeId, backendSessionId }) {
      let query = supabase
        .from("agent_runtimes")
        .select("*")
        .eq("session_id", sessionId);
      if (runtimeId !== undefined && runtimeId !== null) {
        query = query.eq("runtime_id", runtimeId);
      }
      if (backendSessionId !== undefined && backendSessionId !== null) {
        query = query.eq("backend_session_id", backendSessionId);
      }
      const { data, error } = await query.limit(1).single();
      if (error && error.code === "PGRST116") return null;
      if (error) throw error;
      return data ? mapAgentRuntimeRow(data) : null;
    },

    async getLatestAgentRuntime({ agentId, sessionId }) {
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("*")
        .eq("agent_id", agentId)
        .eq("session_id", sessionId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .single();
      if (error && error.code === "PGRST116") return null;
      if (error) throw error;
      return data ? mapAgentRuntimeRow(data) : null;
    },

    async updateRuntimeCursor(runtimeRowId, { lastProcessedMessageId }) {
      const { error } = await supabase
        .from("agent_runtimes")
        .update({ last_processed_message_id: lastProcessedMessageId })
        .eq("id", runtimeRowId);
      if (error) throw error;
    },

    async ensureAgentTypes({ supportedTypes, defaultAgentType }) {
      // Keep the default a member of the supported set (see normalizeAgentTypes).
      const norm = normalizeAgentTypes(supportedTypes, defaultAgentType);
      const { data: authData, error: authErr } = await supabase.auth.getUser();
      if (authErr || !authData?.user?.id) {
        throw new Error("ensureAgentTypes: authenticated user required");
      }
      // Resolve the caller's own agent actor — NOT `.limit(1)` on all team
      // agents (that picks the wrong row when multiple agents exist). Daemon
      // JWTs may have empty app_metadata; actors.user_id = auth.uid() is the
      // stable routing identity (see app.is_current_agent).
      const { data: actorRow, error: actorErr } = await supabase
        .from("actors")
        .select("id")
        .eq("user_id", authData.user.id)
        .eq("actor_type", "agent")
        .maybeSingle();
      if (actorErr) throw actorErr;
      if (!actorRow?.id) {
        throw new Error("ensureAgentTypes: no agent actor visible to caller");
      }
      const { data: updated, error } = await supabase
        .from("agents")
        .update({
          agent_types: norm.supportedTypes,
          default_agent_type: norm.defaultAgentType,
        })
        .eq("id", actorRow.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!updated?.id) {
        throw new Error(
          "ensureAgentTypes: update did not apply (agent row missing or RLS denied)",
        );
      }
    },

    async uploadAttachment({ path, mime, bytes, bucket }) {
      const targetBucket = bucket || DEFAULT_ATTACHMENT_BUCKET;
      const { error } = await supabase.storage
        .from(targetBucket)
        .upload(path, bytes, { contentType: mime, upsert: true });
      if (error) throw error;
      return {
        path,
        url: `${supabasePublicUrl}/storage/v1/object/public/${targetBucket}/${path}`,
      };
    },

    async downloadAttachment(path, { bucket }: any = {}) {
      const targetBucket = bucket || DEFAULT_ATTACHMENT_BUCKET;
      const { data, error } = await supabase.storage
        .from(targetBucket)
        .download(path);
      if (error) {
        const status = Number(error?.status || error?.statusCode || 0);
        if (status === 404 || error?.message?.includes("not found") || error?.error === "not_found") return null;
        throw error;
      }
      if (!data) return null;
      const arrayBuffer = await data.arrayBuffer();
      const mime = data.type || "application/octet-stream";
      return { mime, bytes: Buffer.from(arrayBuffer) };
    },

    async submitFeedback(body) {
      const row = {
        message_id: body.messageId,
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        kind: body.kind,
        star_rating: body.starRating ?? null,
        skill: body.skill ?? null,
      };
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .upsert(row, { onConflict: "actor_id,message_id" })
        .select("*")
        .single();
      if (error) throw error;
      return mapFeedbackRow(data);
    },

    async listFeedback({ sessionId }) {
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .select("*")
        .eq("session_id", sessionId);
      if (error) throw error;
      return { items: (data ?? []).map(mapFeedbackRow) };
    },

    async deleteFeedback(messageId, actorId) {
      const query = supabase
        .from("actor_message_feedback")
        .delete()
        .eq("message_id", messageId);
      if (actorId) query.eq("actor_id", actorId);
      const { error } = await query;
      if (error) throw error;
    },

    async getTeamLeaderboard(teamId, { period = "week" } = {}) {
      const { data, error } = await supabase
        .rpc("team_leaderboard", { p_team_id: teamId, p_period: period });
      if (error) throw error;
      const rows = (data ?? []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return { items: rows.map(mapLeaderboardRow) };
    },

    async submitSessionReport(body) {
      // Not transactional: the report row may be written even if the
      // subsequent skill-usage insert fails. Acceptable for best-effort
      // telemetry — a throw here means the caller sees failure, but the
      // report row can still exist. supabase-js has no multi-table txn.
      const reportRow = {
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        tokens_used: body.tokensUsed ?? 0,
        cost_usd: body.costUsd ?? 0,
        model: body.model ?? null,
        agent_kind: body.agentKind ?? null,
        ended_at: body.endedAt ?? null,
      };
      const { error: reportErr } = await supabase
        .from("actor_session_report")
        .insert(reportRow);
      if (reportErr) throw reportErr;

      const skillRows = Object.entries(body.skillUsage ?? {})
        .filter(([, count]) => Number(count) > 0)
        .map(([skill, count]) => ({
          actor_id: body.actorId,
          team_id: body.teamId,
          session_id: body.sessionId ?? null,
          skill,
          count: Number(count),
        }));
      if (skillRows.length > 0) {
        const { error: skillErr } = await supabase
          .from("actor_skill_usage")
          .insert(skillRows);
        if (skillErr) throw skillErr;
      }
    },

    async submitSkillUsage(body) {
      const row = {
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        skill: body.skill,
        count: Number(body.count ?? 1),
      };
      const { error } = await supabase.from("actor_skill_usage").insert(row);
      if (error) throw error;
    },

    async listFeedbackSummary(teamId) {
      // TODO: replace with a DB-side GROUP BY aggregate (or a view/rpc) when
      // per-team feedback row counts grow — this fetches all rows and reduces
      // in JS. displayName is left null here; callers resolve it separately
      // (the leaderboard rpc already returns display_name).
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .select("actor_id, kind")
        .eq("team_id", teamId);
      if (error) throw error;
      const byActor = new Map();
      for (const r of data ?? []) {
        const e = byActor.get(r.actor_id) ?? { actorId: r.actor_id, displayName: null, positive: 0, negative: 0, total: 0 };
        if (r.kind === "positive") e.positive += 1;
        if (r.kind === "negative") e.negative += 1;
        e.total += 1;
        byActor.set(r.actor_id, e);
      }
      return { items: [...byActor.values()] };
    },

    // --- Directory resolution (frontend supabase delegate parity) ---

    async resolveCallerActorForTeam(teamId) {
      // Resolve the bearer caller's member actor in this team (not any member).
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) return null;
      return this.resolveCurrentMemberActor(teamId, userId);
    },

    async resolveCurrentMemberActor(teamId, userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id } : null;
    },

    async resolveFirstMemberActorForUser(userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id, team_id")
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, team_id: data.team_id ?? null } : null;
    },

    async getCurrentTeamMember(teamId, userId) {
      const { data: actorRows, error: actorError } = await supabase
        .from("actor_directory")
        .select("id, display_name, team_role")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1);
      if (actorError) throw actorError;
      const actor = actorRows?.[0];
      if (!actor) return null;
      const { data: memberRows, error: memberError } = await supabase
        .from("team_members")
        .select("joined_at")
        .eq("team_id", teamId)
        .eq("member_id", actor.id)
        .limit(1);
      return {
        id: actor.id,
        displayName: actor.display_name || "",
        role: actor.team_role ?? null,
        joinedAt: memberError ? null : memberRows?.[0]?.joined_at ?? null,
      };
    },

    // --- Sync (incremental) ---

    async listActorDirectoryForSync(teamId, updatedAfter) {
      let q = supabase
        .from("actor_directory")
        .select(
          "id, team_id, actor_type, display_name, member_status, agent_status, last_active_at, created_at, updated_at",
        )
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listIdeasForSync(teamId, updatedAfter) {
      let q = supabase
        .from("ideas")
        .select(
          "id, team_id, workspace_id, parent_idea_id, title, description, status, created_by_actor_id, archived, sort_order, created_at, updated_at",
        )
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listSessionParticipantsForSync(sessionId, updatedAfter) {
      let q = supabase
        .from("session_participants")
        .select("id, session_id, actor_id, joined_at, created_at, updated_at")
        .eq("session_id", sessionId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    // --- Actor directory by ids + remove agent access ---

    async listActorDirectoryByIds(actorIds, teamId) {
      if (!Array.isArray(actorIds) || actorIds.length === 0) return [];
      let q = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .in("id", actorIds);
      if (teamId) q = q.eq("team_id", teamId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map(mapDirectoryActor);
    },

    async removeAgentAccessById(accessId) {
      const { error } = await supabase
        .from("agent_member_access")
        .delete()
        .eq("id", accessId);
      if (error) throw error;
    },

    // --- Team workspace git config (separate column set from
    // existing default/pinned workspace config) ---

    async getMeBootstrap() {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) {
        throw new ApiError(401, "unauthorized", "no authenticated user");
      }
      const { data: actorRows, error: actorErr } = await supabase
        .from("actors")
        .select("id")
        .eq("user_id", userId)
        .eq("actor_type", "member");
      if (actorErr) throw actorErr;
      const actorIds = (actorRows ?? []).map((r) => r.id);
      if (actorIds.length === 0) {
        return { memberActorId: null, teams: [], memberActorIdByTeam: {} };
      }
      const { data: memberRows, error: memberErr } = await supabase
        .from("team_members")
        .select("role, member_id, teams!inner(id, name, slug)")
        .in("member_id", actorIds);
      if (memberErr) throw memberErr;
      const seenTeam = new Map();
      const memberByTeam = {};
      for (const m of memberRows ?? []) {
        const t = m.teams;
        if (!t?.id) continue;
        if (!seenTeam.has(t.id)) {
          seenTeam.set(t.id, { id: t.id, name: t.name, slug: t.slug, role: m.role });
        }
        memberByTeam[t.id] = m.member_id;
      }
      const teams = Array.from(seenTeam.values());
      const primary = teams[0] ? memberByTeam[teams[0].id] : null;
      return {
        memberActorId: primary ?? null,
        teams,
        memberActorIdByTeam: memberByTeam,
      };
    },

    async listTeamSessionsFull(teamId) {
      const FULL_COLUMNS =
        "id, team_id, title, mode, primary_agent_id, idea_id, summary, last_message_preview, last_message_at, created_by_actor_id, created_at, updated_at";
      const { data: sessionRows, error: sessionErr } = await supabase
        .from("sessions")
        .select(FULL_COLUMNS)
        .eq("team_id", teamId)
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (sessionErr) throw sessionErr;
      const rows = sessionRows ?? [];
      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const { data: pRows, error: pErr } = await supabase
        .from("session_participants")
        .select("session_id")
        .in("session_id", ids);
      if (pErr) throw pErr;
      const counts = (pRows ?? []).reduce((acc, r) => {
        acc[r.session_id] = (acc[r.session_id] ?? 0) + 1;
        return acc;
      }, {});

      return rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        title: row.title ?? "",
        mode: row.mode ?? "solo",
        ideaId: row.idea_id ?? null,
        primaryAgentId: row.primary_agent_id ?? null,
        createdByActorId: row.created_by_actor_id ?? null,
        summary: row.summary ?? null,
        lastMessageAt: row.last_message_at ?? null,
        lastMessagePreview: row.last_message_preview ?? null,
        participantCount: counts[row.id] ?? 0,
        hasUnread: false,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
      }));
    },

    async listAgentRuntimesForTeam(teamId) {
      const COLS =
        "id, team_id, agent_id, session_id, workspace_id, backend_type, status, backend_session_id, runtime_id, current_model, last_seen_at, created_at, updated_at";
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select(COLS)
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        teamId: row.team_id,
        agentId: row.agent_id,
        sessionId: row.session_id ?? null,
        workspaceId: row.workspace_id ?? null,
        backendType: row.backend_type,
        status: row.status,
        backendSessionId: row.backend_session_id ?? null,
        runtimeId: row.runtime_id ?? null,
        currentModel: row.current_model ?? null,
        lastSeenAt: row.last_seen_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    async listSessionsForTeamSince(teamId, updatedAfter) {
      const SESSION_SYNC_COLUMNS =
        "id, team_id, title, mode, primary_agent_id, idea_id, summary, last_message_preview, last_message_at, created_by_actor_id, created_at, updated_at";
      let q = supabase
        .from("sessions")
        .select(SESSION_SYNC_COLUMNS)
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listMessagesForSessionSince(sessionId, updatedAfter) {
      const MESSAGE_SYNC_COLUMNS =
        "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";
      let q = supabase
        .from("messages")
        .select(MESSAGE_SYNC_COLUMNS)
        .eq("session_id", sessionId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listSessionDisplayRows(teamId, sessionIds) {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
      const { data, error } = await supabase
        .from("sessions")
        .select("id, title")
        .eq("team_id", teamId)
        .in("id", sessionIds);
      if (error) throw error;
      return data ?? [];
    },

    async listSessionIdsForActor(actorId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id")
        .eq("actor_id", actorId);
      if (error) throw error;
      return (data ?? []).map((r) => r.session_id).filter(Boolean);
    },

    async listWorkspacesByIdsSlim(teamId, workspaceIds) {
      if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) return [];
      const { data, error } = await supabase
        .from("workspaces")
        .select("id, name, path")
        .eq("team_id", teamId)
        .in("id", workspaceIds);
      if (error) throw error;
      return data ?? [];
    },

    async listShortcutRoleBindings(teamId) {
      const { data, error } = await supabase
        .from("permissions")
        .select("resource_id, permission_roles(role_id)")
        .eq("team_id", teamId)
        .eq("resource_type", "shortcut");
      if (error) throw error;
      return data ?? [];
    },

    async loadTeamWorkspaceGitConfig(teamId) {
      const { data, error } = await supabase
        .from("team_workspace_config")
        .select("team_id, git_url, git_branch, git_token, ai_gateway_endpoint, enabled, updated_at")
        .eq("team_id", teamId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    async saveTeamWorkspaceGitConfig(input) {
      const { error } = await supabase
        .from("team_workspace_config")
        .upsert(input, { onConflict: "team_id" });
      if (error) throw error;
    },

    // --- Sessions CRUD (single-session ops; list uses listSessions above) ---

    async getSession(sessionId) {
      const { data, error } = await supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("id", sessionId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapSessionFull(data) : null;
    },

    async joinSession(sessionId) {
      // SECURITY DEFINER RPC: verifies team membership and inserts the caller as
      // a participant, bypassing the participant-only RLS that would otherwise
      // hide the session and block self-insert. Idempotent.
      const { error } = await supabase.rpc("join_session", { p_session_id: sessionId });
      if (error) {
        if (error.code === "P0002") throw new ApiError(404, "not_found", "session not found");
        if (error.code === "42501") throw new ApiError(403, "forbidden", "not a member of this session's team");
        throw error;
      }
      // The caller is now a participant, so RLS lets getSession read the row.
      const session = await this.getSession(sessionId);
      if (!session) throw new ApiError(404, "not_found", "session not found");
      return session;
    },

    async createSession(input) {
      // The frontend createSessionShell path supplies a client-generated id
      // plus an additionalActorIds list. Insert the session row directly and
      // bootstrap participants. The `create_session` RPC isn't used because
      // it requires `idea_id` (NOT NULL via legacy schema gated behind
      // newer migrations) and assumes the caller as the only seat.
      const id = input.id ?? randomUUID();
      // AUTHZ: created_by is ALWAYS resolved server-side from the authenticated
      // caller scoped to the target team. Any client-supplied
      // `input.createdByActorId` is ignored — a multi-team user's client can
      // send the wrong team's member actor id (stale current-team value),
      // which the `sessions` INSERT RLS WITH CHECK
      // (`created_by_actor_id = current_actor_id_for_team(team_id)`) then
      // rejects with a 403. Deriving it here guarantees the row always
      // satisfies RLS regardless of what the client sends.
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const resolved = await this.resolveCurrentMemberActor(input.teamId, userId);
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByActorId = resolved.id;
      const insertRow: any = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        idea_id: input.ideaId ?? null,
        created_by_actor_id: createdByActorId,
      };
      // App-linked sessions carry app_id so listAppSessions / the app workspace
      // can resolve them (mirrors pg-repo createSession). Omitted for plain
      // sessions so the column stays NULL.
      if (input.appId) insertRow.app_id = input.appId;
      if (input.primaryAgentId) insertRow.primary_agent_id = input.primaryAgentId;
      const { data, error } = await supabase
        .from("sessions")
        .insert(insertRow)
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (error) throw error;

      const additionalIds = Array.isArray(input.additionalActorIds) ? input.additionalActorIds : [];
      const participantIds = Array.isArray(input.participantActorIds) ? input.participantActorIds : [];
      const seedActorIds = Array.from(
        new Set(
          [
            createdByActorId,
            ...additionalIds,
            ...participantIds,
          ].filter((x) => typeof x === "string" && x.length > 0),
        ),
      );
      if (seedActorIds.length > 0) {
        const rows = seedActorIds.map((actorId) => ({ session_id: id, actor_id: actorId }));
        const { error: partError } = await supabase
          .from("session_participants")
          .upsert(rows, { onConflict: "session_id,actor_id" });
        if (partError) throw partError;
      }
      return mapSessionFull(data);
    },

    async patchSession(sessionId, patch) {
      const update: any = {};
      if (patch.title !== undefined) update.title = patch.title;
      if (patch.summary !== undefined) update.summary = patch.summary;
      if (patch.archivedAt !== undefined) update.archived_at = patch.archivedAt;
      if (patch.mode !== undefined) update.mode = patch.mode;
      if (Object.keys(update).length === 0) {
        return this.getSession(sessionId);
      }
      const { data, error } = await supabase
        .from("sessions")
        .update(update)
        .eq("id", sessionId)
        .select(SESSION_FULL_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? mapSessionFull(data) : null;
    },

    async markSessionViewed(sessionId, lastReadMessageId = null) {
      const { error } = await supabase.rpc("mark_current_actor_session_viewed", {
        p_session_id: sessionId,
        p_last_read_message_id: lastReadMessageId ?? null,
      });
      if (error) throw error;
    },

    async markSessionUnread(sessionId) {
      // Delete the caller's read marker so the session re-derives as unread.
      // RLS scopes the delete to the current actor via the "write own markers"
      // FOR ALL policy, so no explicit actor filter is needed here.
      const { error } = await supabase
        .from("session_read_markers")
        .delete()
        .eq("session_id", sessionId);
      if (error) throw error;
    },

    async getSessionByAcp(acpSessionId) {
      const { data, error } = await supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("acp_session_id", acpSessionId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // The amuxd daemon (get_gateway_session_by_acp_id) deserializes this into
      // { sessionId: required String, gatewaySessionId: Option<String> } and
      // uses gatewaySessionId as the chat binding for the per-session MCP
      // config. mapSessionFull alone exposes `id`/`binding` (not the camelCase
      // names the daemon expects), so surface both explicitly.
      return {
        ...mapSessionFull(data),
        sessionId: data.id,
        gatewaySessionId: data.binding ?? null,
      };
    },

    async ensureGatewaySession(input) {
      const { data, error } = await supabase.rpc("ensure_gateway_session", {
        p_team_id: input.teamId,
        p_binding: input.binding,
        p_title: input.title,
        p_primary_agent_actor_id: input.primaryAgentActorId,
        p_owner_member_actor_ids: input.ownerMemberActorIds ?? [],
        p_participant_actor_ids: input.participantActorIds ?? [],
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new ApiError(502, "upstream_unavailable", "ensure_gateway_session returned no row");
      const acpSessionId = row.acp_session_id ?? row.acpSessionId ?? null;
      return {
        sessionId: row.session_id ?? row.sessionId ?? null,
        // The amuxd daemon deserializes `gatewaySessionId` as a REQUIRED field
        // and uses it as the logical ACP session id it later looks up via
        // getSessionByAcp (which queries the acp_session_id column) — so it must
        // equal acp_session_id to round-trip. Omitting it made WeCom inbound
        // messages fail with "missing field gatewaySessionId". The pg-repo
        // backend already returns this field; this keeps the two in lockstep.
        gatewaySessionId: acpSessionId,
        acpSessionId,
        created: row.created === true,
      };
    },

    async createCronSession(input) {
      // Cron sessions are plain `mode='collab'` sessions with no idea_id and
      // a marker in `summary` or metadata. The supabase create_session RPC
      // requires an idea_id, so we insert directly to bypass that constraint.
      const id = input.id ?? randomUUID();
      const insertRow: any = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: "collab",
        primary_agent_id: input.primaryAgentActorId,
      };
      if (input.createdByActorId) insertRow.created_by_actor_id = input.createdByActorId;
      else insertRow.created_by_actor_id = input.primaryAgentActorId;
      const { data, error } = await supabase
        .from("sessions")
        .insert(insertRow)
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (error) throw error;
      // Bootstrap primary agent as participant.
      const { error: partError } = await supabase
        .from("session_participants")
        .upsert(
          [{ session_id: id, actor_id: input.primaryAgentActorId }],
          { onConflict: "session_id,actor_id" },
        );
      if (partError) throw partError;

      // Mirror gateway sessions: add human admins of the primary agent so
      // desktop users can open cron run history via "查看对话". Without this,
      // sessions_select_if_participant_or_creator hides the row from members
      // who are not the agent actor (see 202605060001_sessions_select_only_participants).
      const { data: adminRows, error: adminErr } = await supabase.rpc(
        "list_agent_admin_member_actor_ids",
        { p_agent_actor_id: input.primaryAgentActorId },
      );
      if (adminErr) throw adminErr;
      const adminActorIds = (adminRows ?? [])
        .map((row) => (typeof row === "string" ? row : row?.member_actor_id))
        .filter((id) => typeof id === "string" && id.length > 0);
      if (adminActorIds.length > 0) {
        const { error: adminPartErr } = await supabase
          .from("session_participants")
          .upsert(
            adminActorIds.map((actor_id) => ({ session_id: id, actor_id })),
            { onConflict: "session_id,actor_id" },
          );
        if (adminPartErr) throw adminPartErr;
      }

      return { sessionId: data.id, ...mapSessionFull(data) };
    },

    // --- Session members (participants) ---

    async listSessionParticipants(sessionId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id, actor_id, role, joined_at")
        .eq("session_id", sessionId);
      if (error) throw error;
      const rows = data ?? [];
      const actorIds = rows.map((r) => r.actor_id).filter(Boolean);
      let actorsById = new Map();
      if (actorIds.length > 0) {
        const { data: actors, error: actorsErr } = await supabase
          .from("actor_directory")
          .select("id, team_id, actor_type, display_name, avatar_url")
          .in("id", actorIds);
        if (actorsErr) throw actorsErr;
        actorsById = new Map((actors ?? []).map((a) => [a.id, a]));
      }
      const items = rows.map((row) => {
        const actor = actorsById.get(row.actor_id);
        return {
          sessionId: row.session_id,
          actorId: row.actor_id,
          role: row.role ?? null,
          joinedAt: row.joined_at ?? null,
          teamId: actor?.team_id ?? null,
          actorType: actor?.actor_type ?? null,
          displayName: actor?.display_name ?? null,
          avatarUrl: actor?.avatar_url ?? null,
        };
      });
      return { items };
    },

    async upsertSessionParticipant(sessionId, input) {
      const row: any = {
        session_id: sessionId,
        actor_id: input.actorId,
      };
      if (input.role !== undefined) row.role = input.role;
      const { data, error } = await supabase
        .from("session_participants")
        .upsert(row, { onConflict: "session_id,actor_id" })
        .select("session_id, actor_id, role, joined_at")
        .single();
      if (error) throw error;
      return {
        sessionId: data.session_id,
        actorId: data.actor_id,
        role: data.role ?? null,
        joinedAt: data.joined_at ?? null,
      };
    },

    async removeSessionParticipant(sessionId, actorId) {
      const { error } = await supabase
        .from("session_participants")
        .delete()
        .eq("session_id", sessionId)
        .eq("actor_id", actorId);
      if (error) throw error;
    },

    // --- Actor reads + external + access (member-access table) ---

    async getActor(actorId) {
      const { data, error } = await supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("id", actorId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const actor = mapDirectoryActor(data);
      const { data: versions, error: vErr } = await supabase
        .from("actor_client_versions")
        .select("client_type, version, device_id, build, last_reported_at")
        .eq("actor_id", actorId)
        .order("client_type", { ascending: true })
        .order("last_reported_at", { ascending: false });
      if (vErr) throw vErr;
      return {
        ...actor,
        clientVersions: (versions ?? []).map((v) => ({
          clientType: v.client_type,
          version: v.version,
          deviceId: v.device_id,
          build: v.build ?? null,
          lastReportedAt: v.last_reported_at,
        })),
      };
    },

    async upsertExternalActor(input) {
      const { data, error } = await supabase.rpc("upsert_external_actor", {
        p_team_id: input.teamId,
        p_source: input.source,
        p_source_id: input.sourceId,
        p_display_name: input.displayName,
      });
      if (error) throw error;
      // RPC returns the actor uuid scalar.
      const actorId = typeof data === "string" ? data : (Array.isArray(data) ? data[0] : null);
      if (!actorId) throw new ApiError(502, "upstream_unavailable", "upsert_external_actor returned no id");
      return { actorId };
    },

    async checkAgentPermission(agentActorId, actorId) {
      const { data, error } = await supabase.rpc("check_agent_permission", {
        p_agent_id: agentActorId,
        p_actor_id: actorId,
      });
      if (error) throw error;
      // RPC returns a text scalar (permission_level) or null.
      const role = typeof data === "string" && data.length > 0 ? data : null;
      return { allowed: role !== null, role };
    },

    async grantAgentAccess(agentActorId, { actorId, role }) {
      const { data, error } = await supabase
        .from("agent_member_access")
        .upsert(
          {
            agent_id: agentActorId,
            member_id: actorId,
            permission_level: role,
          },
          { onConflict: "agent_id,member_id" },
        )
        .select("id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at")
        .single();
      if (error) throw error;
      return {
        id: data.id,
        agentActorId: data.agent_id,
        actorId: data.member_id,
        role: data.permission_level,
        grantedByMemberId: data.granted_by_member_id ?? null,
        createdAt: data.created_at ?? null,
        updatedAt: data.updated_at ?? null,
      };
    },

    async revokeAgentAccess(agentActorId, actorId) {
      const { error } = await supabase
        .from("agent_member_access")
        .delete()
        .eq("agent_id", agentActorId)
        .eq("member_id", actorId);
      if (error) throw error;
    },

    async listAgentAdminMembers(agentActorId) {
      const { data, error } = await supabase.rpc("list_agent_admin_member_actor_ids", {
        p_agent_actor_id: agentActorId,
      });
      if (error) throw error;
      const items = (data ?? [])
        .map((row) => (typeof row === "string" ? row : row?.member_actor_id))
        .filter((id) => typeof id === "string" && id.length > 0);
      return { items };
    },

    // --- Runtime liveness ---

    async heartbeat() {
      // Probe + update last_active_at so clients see the daemon as online.
      const { error } = await supabase.rpc("update_actor_last_active");
      if (error) throw error;
    },

    // --- Actor agent management (RPCs) ---

    async listConnectedAgents(teamId) {
      const { data, error } = await supabase.rpc("list_connected_agents", { p_team_id: teamId });
      if (error) throw error;
      const items = (data ?? []).map((row) => {
        const id = row.id ?? row.agent_id;
        return {
          id,
          teamId: row.team_id ?? teamId,
          kind: row.actor_type ?? "agent",
          displayName: row.display_name ?? null,
          avatarUrl: row.avatar_url ?? null,
          userId: row.user_id ?? null,
          teamRole: row.team_role ?? null,
          memberStatus: row.member_status ?? null,
          agentStatus: row.agent_status ?? null,
          agentTypes: row.agent_types ?? null,
          defaultAgentType: row.default_agent_type ?? null,
          defaultWorkspaceId: row.default_workspace_id ?? null,
          lastActiveAt: row.last_active_at ?? null,
          createdAt: row.created_at ?? null,
          updatedAt: row.updated_at ?? null,
          agentId: row.agent_id ?? id,
          // Fields the list_connected_agents RPC computes that clients need
          // (iOS ConnectedAgent: permission level, visibility, ownership).
          permissionLevel: row.permission_level ?? null,
          visibility: row.visibility ?? null,
          isOwner: row.is_owner === true,
        };
      }).filter((row) => typeof row.id === "string" && row.id.length > 0);
      return { items };
    },

    async shareAgentToTeam(agentActorId) {
      const { error } = await supabase.rpc("share_agent_to_team", { p_agent_id: agentActorId });
      if (error) throw error;
    },

    async makeAgentPersonal(agentActorId) {
      const { error } = await supabase.rpc("make_agent_personal", { p_agent_id: agentActorId });
      if (error) throw error;
    },

    async updateOwnedAgentProfile(agentActorId, patch) {
      const { error } = await supabase.rpc("update_owned_agent_profile", {
        p_agent_id: agentActorId,
        p_display_name: patch.displayName ?? null,
        p_visibility: patch.visibility ?? null,
      });
      if (error) throw error;
    },

    async updateAgentDefaults(agentActorId, patch) {
      const { error } = await supabase.rpc("update_agent_defaults", {
        p_agent_id: agentActorId,
        p_default_workspace_id: patch.defaultWorkspaceId ?? null,
        p_agent_kind: patch.agentKind ?? null,
        p_default_agent_type: patch.defaultAgentType ?? null,
      });
      if (error) throw error;
    },

    async listAgentAccess(agentActorId) {
      const { data, error } = await supabase
        .from("agent_member_access")
        .select("id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at")
        .eq("agent_id", agentActorId)
        .order("permission_level", { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      const memberIds = [...new Set(rows.map((row) => row.member_id))];
      const memberInfo = new Map();
      if (memberIds.length > 0) {
        const { data: members, error: memberError } = await supabase
          .from("actor_directory")
          .select("id, display_name, actor_type, last_active_at")
          .in("id", memberIds);
        if (memberError) throw memberError;
        for (const member of members ?? []) {
          memberInfo.set(member.id, member);
        }
      }
      const items = rows.map((row) => {
        const member = memberInfo.get(row.member_id);
        return {
          id: row.id,
          agentId: row.agent_id,
          agentActorId: row.agent_id,
          actorId: row.member_id,
          memberId: row.member_id,
          memberName: member?.display_name || row.member_id,
          actorType: member?.actor_type ?? null,
          lastActiveAt: member?.last_active_at ?? null,
          role: row.permission_level,
          permissionLevel: row.permission_level,
          grantedByMemberId: row.granted_by_member_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
      return { items };
    },

    async listLatestAgentRuntimeHints(teamId, agentIds) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("id, agent_id, workspace_id, backend_type, runtime_id, session_id, status, current_model, updated_at")
        .eq("team_id", teamId)
        .in("agent_id", agentIds)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      const latest = new Map();
      for (const row of data ?? []) {
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
        updated_at: row.updated_at ?? null,
      }));
    },

    async listAgentDefaults(agentIds) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const { data, error } = await supabase
        .from("agents")
        .select("id, agent_types, default_agent_type, default_workspace_id")
        .in("id", agentIds);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        agentTypes: Array.isArray(row.agent_types) ? row.agent_types : null,
        defaultAgentType: row.default_agent_type ?? null,
        // The amuxd daemon reads this to resolve the gateway runtime's working
        // directory from its own agent's default workspace.
        defaultWorkspaceId: row.default_workspace_id ?? null,
      }));
    },

    async updateRuntimeModel(runtimeId, model) {
      const { error } = await supabase
        .from("agent_runtimes")
        .update({ current_model: model })
        .eq("runtime_id", runtimeId);
      if (error) throw error;
    },

    async listSessionRuntimeModels(sessionId) {
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("id, runtime_id, agent_id, workspace_id, backend_type, current_model, status")
        .eq("session_id", sessionId);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id ?? null,
        runtime_id: row.runtime_id ?? null,
        agent_id: row.agent_id ?? null,
        workspace_id: row.workspace_id ?? null,
        backend_type: row.backend_type ?? null,
        current_model: row.current_model ?? null,
        status: row.status ?? null,
      }));
    },

    async listRuntimeTargetsForSession(sessionId, agentIds) {
      let query = supabase
        .from("agent_runtimes")
        .select("agent_id, runtime_id")
        .eq("session_id", sessionId)
        .order("updated_at", { ascending: false });
      if (Array.isArray(agentIds) && agentIds.length > 0) {
        query = query.in("agent_id", agentIds);
      }
      const { data, error } = await query;
      if (error) throw error;
      const latest = new Map();
      for (const row of data ?? []) {
        if (!row.agent_id || latest.has(row.agent_id)) continue;
        latest.set(row.agent_id, row);
      }
      return [...latest.values()].map((row) => ({
        agent_id: row.agent_id ?? null,
        runtime_id: row.runtime_id ?? null,
      }));
    },

    async listDaemonRuntimes(teamId) {
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("id, runtime_id, team_id, agent_id, session_id, workspace_id, backend_type, backend_session_id, status, current_model, last_seen_at, created_at, updated_at")
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        runtimeId: row.runtime_id ?? null,
        teamId: row.team_id,
        agentId: row.agent_id,
        sessionId: row.session_id ?? null,
        workspaceId: row.workspace_id ?? null,
        backendType: row.backend_type,
        backendSessionId: row.backend_session_id ?? null,
        status: row.status,
        currentModel: row.current_model ?? null,
        lastSeenAt: row.last_seen_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    // --- Apps domain (production passthrough) ---
    //
    // With the caller's bearer forwarded, RLS already enforces visibility on
    // amux.apps / amux.sessions, so these methods are THINNER than pg-repo:
    // no manual visibility WHERE clause. Status transitions in createApp mirror
    // pg-repo exactly. mapApp exposes the canonical 12-key contract shape.

    async listApps({ teamId, limit = 100 }: { teamId: string; limit?: number }) {
      const { data, error } = await supabase
        .from("apps")
        .select(APP_COLUMNS)
        .eq("team_id", teamId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(mapApp);
    },

    async getApp(appId: string) {
      // RLS returns nothing (PGRST116 on .single()) when the app is not
      // visible to the caller; surface that as null so the route 404s.
      const { data, error } = await supabase
        .from("apps")
        .select(APP_COLUMNS)
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapApp(data) : null;
    },

    async getManagedGitCredential(teamId: string) {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) return null;
      // Accept any actor type (member or agent) — daemon actors are type 'agent'
      // and would be rejected by resolveCurrentMemberActor which filters member-only.
      const { data: actorRow, error: actorErr } = await supabase
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (actorErr) throw actorErr;
      if (!actorRow?.id) return null;
      const cred = managedGitCredential();
      if (!cred) throw new ApiError(503, "managed_git_unavailable", "managed git is not configured");
      return cred;
    },

    async createApp(input: { teamId: string; name: string; type: string; visibility?: string }) {
      // Resolve the caller's actor in this team — the RLS insert policy
      // (created_by_actor_id = app.current_actor_id_for_team(team_id)) requires
      // it. Reuse the same mechanism createSession uses (auth.getUser +
      // resolveCurrentMemberActor) so both paths satisfy the same policy.
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const resolved = await this.resolveCurrentMemberActor(input.teamId, userId);
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByActorId = resolved.id;
      const slug = slugify(input.name);
      const visibility = input.visibility === "team" ? "team" : "personal";

      // 1:1 workspace for the app. created_by_member_id = the resolved actor so
      // the workspace RLS insert policy is satisfied (same actor identity).
      const { data: ws, error: wsErr } = await supabase
        .from("workspaces")
        .insert({
          team_id: input.teamId,
          created_by_member_id: createdByActorId,
          name: `app-${slug}-${Math.random().toString(36).slice(2, 8)}`,
        })
        .select("id")
        .single();
      if (wsErr) throw wsErr;

      const { data: row, error: appErr } = await supabase
        .from("apps")
        .insert({
          team_id: input.teamId,
          created_by_actor_id: createdByActorId,
          name: input.name,
          slug,
          type: input.type,
          visibility,
          workspace_id: ws.id,
          provision_status: "pending",
        })
        .select(APP_COLUMNS)
        .single();
      if (appErr) throw appErr;

      // Provision the per-app git repo via the injected dependency (mirrors how
      // teams provision LiteLLM). On success record the remote + authKind and
      // advance provision_status to "repo_created"; on failure capture the error
      // and set provision_status to "error". The app row is created either way.
      if (provisionAppRepo) {
        try {
          const res = await provisionAppRepo({ appId: row.id, teamId: input.teamId });
          if (res?.gitRemoteUrl) {
            const { data: updated, error: updErr } = await supabase
              .from("apps")
              .update({
                git_remote_url: res.gitRemoteUrl,
                git_auth_kind: res.gitAuthKind,
                provision_status: "repo_created",
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.id)
              .select(APP_COLUMNS)
              .single();
            if (updErr) throw updErr;
            return mapApp(updated);
          }
        } catch (e: any) {
          const { data: errd, error: errUpdErr } = await supabase
            .from("apps")
            .update({
              provision_status: "error",
              provision_error: String(e?.message ?? e),
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
            .select(APP_COLUMNS)
            .single();
          if (errUpdErr) throw errUpdErr;
          return mapApp(errd);
        }
      }

      return mapApp(row);
    },

    async updateApp(appId: string, patch: { name?: string; visibility?: string; provisionStatus?: string }) {
      // RLS apps_update_if_creator blocks non-creators: the UPDATE matches zero
      // rows and .maybeSingle() returns null → surface as null (route 404s).
      const { data: cur } = await supabase.from("apps").select("provision_status").eq("id", appId).maybeSingle();
      const set: any = { updated_at: new Date().toISOString() };
      if (typeof patch.name === "string" && patch.name.length > 0) set.name = patch.name;
      if (patch.visibility === "team" || patch.visibility === "personal") {
        set.visibility = patch.visibility;
      }
      if (typeof patch.provisionStatus === "string") {
        const from = cur?.provision_status ?? "";
        if (isLegalStatusTransition(from, patch.provisionStatus)) {
          set.provision_status = patch.provisionStatus;
        } else if (set.name === undefined && set.visibility === undefined) {
          throw new ApiError(400, "invalid_status_transition",
            `cannot move provision_status ${from} -> ${patch.provisionStatus}`);
        }
      }
      const { data, error } = await supabase
        .from("apps")
        .update(set)
        .eq("id", appId)
        .select(APP_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? mapApp(data) : null;
    },

    async deployApp(appId: string) {
      // Visibility + readiness gate. RLS on amux.apps returns nothing when the
      // app is not visible to the caller → surface null so the route 404s.
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, slug, provision_status")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      if (existing.provision_status !== "ready") {
        throw new ApiError(409, "app_not_ready", "app must be seeded (provision_status=ready) before deploy");
      }
      if (!startDeploy) throw new ApiError(503, "deploy_unavailable", "deploy provisioning not configured");
      try {
        const r = await startDeploy({ appId, slug: existing.slug, region: process.env.REGION || "cn-hangzhou" });
        // Persist only fc_function_name / fc_region / fc_status. The app's own
        // DATABASE_URL from startDeploy is intentionally NOT persisted. The
        // UPDATE is RLS-gated (apps_update_if_creator): a non-creator matches
        // zero rows → .maybeSingle() returns null → surface as null (route 404s).
        const { data: row, error: updErr } = await supabase
          .from("apps")
          .update({
            fc_function_name: r.fcFunctionName,
            fc_region: r.fcRegion,
            fc_status: "awaiting_build",
            provision_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId)
          .select(APP_COLUMNS)
          .maybeSingle();
        if (updErr) throw updErr;
        if (!row) return null;
        return { ...mapApp(row), ossObjectName: r.ossObjectName, presignedPut: r.presignedPut };
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        await supabase
          .from("apps")
          .update({
            fc_status: "deploy_error",
            provision_error: String(e?.message ?? e),
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId);
        throw new ApiError(502, "deploy_failed", String(e?.message ?? e));
      }
    },

    async finalizeDeploy(appId: string) {
      // Visibility gate. RLS on amux.apps returns nothing when the app is not
      // visible to the caller → surface null so the route 404s.
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, fc_function_name, fc_status")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      if (!existing.fc_function_name) throw new ApiError(409, "not_deploying", "app has no function; call deploy first");
      if (!isLegalFcTransition(existing.fc_status, "deploying")) {
        throw new ApiError(409, "invalid_deploy_state", `cannot finalize from fc_status ${existing.fc_status}`);
      }
      if (!finalizeDeploy) throw new ApiError(503, "deploy_unavailable", "deploy provisioning not configured");
      // Mark deploying (RLS-gated UPDATE).
      await supabase.from("apps").update({ fc_status: "deploying", updated_at: new Date().toISOString() }).eq("id", appId);
      try {
        const r = await finalizeDeploy({
          fcFunctionName: existing.fc_function_name,
          ossObjectName: appOssObjectName(appId),
        });
        // Persist fc_status=live + fc_endpoint. No secret is persisted.
        const { data: row, error: updErr } = await supabase
          .from("apps")
          .update({
            fc_status: "live",
            fc_endpoint: r.fcEndpoint,
            provision_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId)
          .select(APP_COLUMNS)
          .maybeSingle();
        if (updErr) throw updErr;
        if (!row) return null;
        return mapApp(row);
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        await supabase
          .from("apps")
          .update({
            fc_status: "deploy_error",
            provision_error: String(e?.message ?? e),
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId);
        throw new ApiError(502, "finalize_failed", String(e?.message ?? e));
      }
    },

    async listAppSessions(appId: string) {
      // RLS on sessions governs visibility; a caller who cannot see the app's
      // sessions gets an empty list.
      const { data, error } = await supabase
        .from("sessions")
        .select("id, team_id, title, mode, last_message_at, created_at, updated_at")
        .eq("app_id", appId);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        teamId: r.team_id,
        title: r.title ?? "",
        mode: r.mode ?? "collab",
        lastMessageAt: appIso(r.last_message_at),
        createdAt: appIso(r.created_at)!,
        updatedAt: appIso(r.updated_at)!,
      }));
    },
  };
}

