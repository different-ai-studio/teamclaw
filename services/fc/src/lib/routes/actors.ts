import { ApiError } from "../http-utils.js";
import { requireString } from "../routing-utils.js";

const DEFAULT_ACTOR_LIMIT = 200;
const MAX_ACTOR_LIMIT = 500;

function parseActorLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_ACTOR_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTOR_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 500");
  }
  return limit;
}

export function registerActors(router) {
  router.get("/v1/teams/:teamId/actors", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const kind = ctx.query.get("kind") ?? null;
    const limit = parseActorLimit(ctx.query.get("limit"));
    const page = await ctx.repository.listTeamActors(teamId, { kind, limit });
    return { body: { items: page.items, nextCursor: null } };
  });

  router.get("/v1/actors/:actorId", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    const actor = await ctx.repository.getActor(actorId);
    if (!actor) throw new ApiError(404, "not_found", "actor not found");
    return { body: actor };
  });

  router.patch("/v1/actors/:actorId/profile", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    const body = ctx.json ?? {};
    requireString(body.displayName, "displayName");
    const actor = await ctx.repository.updateCurrentActorProfile(actorId, {
      displayName: body.displayName,
      avatarUrl: body.avatarUrl ?? null,
    });
    return { body: actor };
  });

  router.delete("/v1/actors/:actorId", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    await ctx.repository.removeTeamActor(null, actorId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/actors/external", async (ctx) => {
    const body = ctx.json;
    if (!body) throw new ApiError(400, "validation_failed", "body is required");
    requireString(body.teamId, "teamId");
    requireString(body.source, "source");
    requireString(body.sourceId, "sourceId");
    requireString(body.displayName, "displayName");
    const result = await ctx.repository.upsertExternalActor({
      teamId: body.teamId,
      source: body.source,
      sourceId: body.sourceId,
      displayName: body.displayName,
    });
    return { body: { actorId: result.actorId } };
  });

  router.get("/v1/teams/:teamId/agents/connected", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.listConnectedAgents(teamId);
    return { body: { items: result.items } };
  });

  // Per-member default agent. "me" is resolved server-side from the bearer
  // token + team — the route never accepts a client-supplied member id, so a
  // caller can only read/write their own default.
  router.get("/v1/teams/:teamId/members/me/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getMemberDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  router.put("/v1/teams/:teamId/members/me/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    const agentId =
      body.agentId === undefined || body.agentId === null ? null : String(body.agentId);
    const result = await ctx.repository.setMemberDefaultAgent(teamId, agentId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  // Team-level default agent (fallback when a member has no default). Owner/
  // admin only on PUT — enforced in the RPC/repository layer.
  router.get("/v1/teams/:teamId/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getTeamDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  router.put("/v1/teams/:teamId/default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    const agentId =
      body.agentId === undefined || body.agentId === null ? null : String(body.agentId);
    const result = await ctx.repository.setTeamDefaultAgent(teamId, agentId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  // Effective default for the calling member (member default, else team default).
  router.get("/v1/teams/:teamId/members/me/effective-default-agent", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const result = await ctx.repository.getEffectiveDefaultAgent(teamId);
    return { body: { defaultAgentId: result.defaultAgentId ?? null } };
  });

  router.patch("/v1/agents/:agentActorId", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json ?? {};
    await ctx.repository.updateOwnedAgentProfile(agentActorId, {
      displayName: body.displayName ?? null,
      avatarUrl: body.avatarUrl ?? null,
      description: body.description ?? null,
      visibility: body.visibility ?? null,
    });
    return { statusCode: 204, body: null };
  });

  router.patch("/v1/agents/:agentActorId/defaults", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json ?? {};
    await ctx.repository.updateAgentDefaults(agentActorId, {
      defaultAgentType: body.defaultAgentType ?? null,
      supportedAgentTypes: body.supportedAgentTypes ?? null,
      defaultWorkspaceId: body.defaultWorkspaceId ?? null,
      agentKind: body.agentKind ?? null,
    });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/agents/:agentActorId/permission", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const actorId = ctx.query.get("actorId");
    if (!actorId) throw new ApiError(400, "validation_failed", "actorId is required");
    const result = await ctx.repository.checkAgentPermission(agentActorId, actorId);
    return { body: { allowed: result.allowed, role: result.role ?? null } };
  });

  router.get("/v1/agents/:agentActorId/access", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const result = await ctx.repository.listAgentAccess(agentActorId);
    return { body: { items: result.items } };
  });

  router.post("/v1/agents/:agentActorId/access", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const body = ctx.json;
    if (!body) throw new ApiError(400, "validation_failed", "body is required");
    requireString(body.actorId, "actorId");
    requireString(body.role, "role");
    const result = await ctx.repository.grantAgentAccess(agentActorId, {
      actorId: body.actorId,
      role: body.role,
    });
    return { body: result };
  });

  router.post("/v1/agents/:agentActorId/share-to-team", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    await ctx.repository.shareAgentToTeam(agentActorId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/agents/:agentActorId/make-personal", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    await ctx.repository.makeAgentPersonal(agentActorId);
    return { statusCode: 204, body: null };
  });

  router.delete("/v1/agents/:agentActorId/access/:actorId", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const actorId = decodeURIComponent(ctx.params.actorId);
    await ctx.repository.revokeAgentAccess(agentActorId, actorId);
    return { statusCode: 204, body: null };
  });

  router.get("/v1/agents/:agentActorId/admin-members", async (ctx) => {
    const agentActorId = decodeURIComponent(ctx.params.agentActorId);
    const result = await ctx.repository.listAgentAdminMembers(agentActorId);
    return { body: { items: result.items } };
  });

  router.post("/v1/actors/by-ids", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.actorIds)) {
      throw new ApiError(400, "validation_failed", "actorIds must be an array");
    }
    const teamId = typeof body.teamId === "string" && body.teamId.length > 0 ? body.teamId : null;
    const items = await ctx.repository.listActorDirectoryByIds(body.actorIds, teamId);
    return { body: { items } };
  });

  router.get("/v1/actors/:actorId/sessions", async (ctx) => {
    const actorId = decodeURIComponent(ctx.params.actorId);
    const items = await ctx.repository.listSessionIdsForActor(actorId);
    return { body: { items } };
  });

  router.delete("/v1/actors/access/:accessId", async (ctx) => {
    const accessId = decodeURIComponent(ctx.params.accessId);
    await ctx.repository.removeAgentAccessById(accessId);
    return { statusCode: 204, body: null };
  });
}