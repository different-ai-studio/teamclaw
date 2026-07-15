import { requireString, optionalStringOrNull } from "../routing-utils.js";
import { optionalBearerToken } from "../http-utils.js";

export function registerTeams(router) {
  router.get("/v1/teams", async (ctx) => {
    // scope=all lists the caller's teams across ALL orgs (cross-org team picker);
    // omitted preserves the active-org listing.
    const scope = ctx.query?.get?.("scope") ?? null;
    if (scope === "all") {
      const items = await ctx.repository.listAllMyTeams();
      return { body: { items, nextCursor: null } };
    }
    const items = await ctx.repository.listTeams({ limit: 50 });
    return { body: { items, nextCursor: null } };
  });

  // Switch the caller's active team (and org), minting a fresh session. The
  // bearer is forwarded so the SECURITY DEFINER `switch_active_team` RPC resolves
  // `auth.uid()` for the member check + org swap. `auth: "none"` routes the call
  // to the auth repository (which owns switchActiveTeam alongside claimInvite);
  // the token is passed explicitly rather than baked into a business repo.
  router.post("/v1/teams/:id/activate", { auth: "none" }, async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.id);
    const accessToken = optionalBearerToken(ctx.headers) ?? undefined;
    const result = await ctx.repository.switchActiveTeam(teamId, { accessToken });
    return { body: result };
  });

  // POST /v1/teams — slim team creation (Task 3 of share-onboarding refactor).
  //
  // LiteLLM provisioning is now an explicit second step that the client
  // triggers via POST /v1/teams/:teamId/litellm/setup. This route only writes
  // the teams row + the bare team_workspace_config row (sync_mode=NULL,
  // litellm_team_id=NULL). The response still includes aiGatewayEndpoint and
  // litellmKey as null fields for back-compat with the Rust client
  // (`Option<String>` — see apps/desktop/src/commands/oss_sync/fc_client.rs).
  router.post("/v1/teams", async (ctx) => {
    const body = ctx.json;
    // name is optional: when omitted, the repository seeds it from the caller's
    // org name (saas-mono), falling back to a synthesized handle.
    const team = await ctx.repository.createTeam({
      name: optionalStringOrNull(body.name, "name") ?? undefined,
      slug: optionalStringOrNull(body.slug, "slug"),
      // Owner's real name (OS full name / email prefix) when the client knows
      // it; the repository synthesizes a stable handle when omitted.
      displayName: optionalStringOrNull(body.displayName, "displayName"),
      litellmTeamId: null,
      aiGatewayEndpoint: null,
    });

    return {
      body: {
        ...team,
        aiGatewayEndpoint: null,
        litellmKey: null,
      },
    };
  });

  router.get("/v1/teams/:id", async (ctx) => {
    const team = await ctx.repository.getTeam(decodeURIComponent(ctx.params.id));
    return { body: team };
  });

  router.patch("/v1/teams/:teamId", async (ctx) => {
    const body = ctx.json;
    requireString(body.name, "name");
    const team = await ctx.repository.renameTeam(ctx.params.teamId, { name: body.name });
    return { body: team };
  });

  router.post("/v1/teams/:teamId/invites", async (ctx) => {
    const body = ctx.json;
    const kind = body.kind ?? body.actorType;
    requireString(kind, "kind");
    requireString(body.displayName, "displayName");
    const result = await ctx.repository.createTeamInvite(ctx.params.teamId, {
      kind,
      displayName: body.displayName,
      teamRole: body.teamRole ?? body.role ?? null,
      agentKind: body.agentKind ?? null,
      ttlSeconds: body.ttlSeconds ?? null,
      targetActorId: body.targetActorId ?? null,
      // Optional, member-only. When present the invitee can find and accept the
      // invite at login (GET /v1/invites/pending) without the token.
      inviteEmail: body.inviteEmail ?? null,
      invitePhone: body.invitePhone ?? null,
    });
    return { statusCode: 201, body: result };
  });

  router.delete("/v1/teams/:teamId/members/:actorId", async (ctx) => {
    await ctx.repository.removeTeamActor(ctx.params.teamId, ctx.params.actorId);
    return { statusCode: 204 };
  });

  // OpenAPI removeTeamActorScoped: clients (cloud-api/teams.ts) call the
  // /actors/ path. Same operation as /members/ above — register both so the
  // route resolves instead of returning "Route not found".
  router.delete("/v1/teams/:teamId/actors/:actorId", async (ctx) => {
    await ctx.repository.removeTeamActor(ctx.params.teamId, ctx.params.actorId);
    return { statusCode: 204 };
  });

  router.get("/v1/teams/:teamId/directory", async (ctx) => {
    const result = await ctx.repository.getTeamDirectory(ctx.params.teamId);
    return { body: result };
  });
}