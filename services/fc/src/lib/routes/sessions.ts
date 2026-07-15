import { ApiError } from "../http-utils.js";
import { parseLimit, decodeCursor, nextSessionCursor, requireString } from "../routing-utils.js";

export function registerSessions(router) {
  router.get("/v1/sessions", async (ctx) => {
    const limit = parseLimit(ctx.query.get("limit"));
    const cursor = decodeCursor(ctx.query.get("cursor"));
    const items = await ctx.repository.listSessions({ limit, cursor });
    return { body: { items, nextCursor: nextSessionCursor(items, limit) } };
  });

  router.post("/v1/sessions", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.title, "title");
    requireString(body.mode, "mode");
    const out = await ctx.repository.createSession(body);
    return { statusCode: 201, body: out };
  });

  router.get("/v1/sessions/muted", async (ctx) => {
    const out = await ctx.repository.listMutedSessions();
    return { body: out };
  });

  router.get("/v1/sessions/:sessionId", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const out = await ctx.repository.getSession(sessionId);
    if (!out) throw new ApiError(404, "not_found", "session not found");
    return { body: out };
  });

  router.patch("/v1/sessions/:sessionId", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const body = ctx.json ?? {};
    const out = await ctx.repository.patchSession(sessionId, body);
    if (!out) throw new ApiError(404, "not_found", "session not found");
    return { body: out };
  });

  router.post("/v1/sessions/:sessionId/mark-viewed", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const body = ctx.json ?? {};
    const lastReadMessageId = typeof body.lastReadMessageId === "string" && body.lastReadMessageId.length > 0
      ? body.lastReadMessageId
      : null;
    // The actor is resolved server-side from the authenticated user inside the
    // repo — the route never supplies a client actorId.
    await ctx.repository.markSessionViewed(sessionId, lastReadMessageId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/sessions/:sessionId/mark-unread", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    // The actor is resolved server-side from the authenticated user inside the
    // repo — the route never supplies a client actorId.
    await ctx.repository.markSessionUnread(sessionId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/sessions/:sessionId/join", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    // The actor is resolved server-side from the authenticated user inside the
    // repo (membership-checked self-join). Returns the full session (200) or
    // throws 404/403 from the repo, which the router adapter maps.
    const out = await ctx.repository.joinSession(sessionId);
    return { body: out };
  });

  router.get("/v1/me/bootstrap", async (ctx) => {
    const out = await ctx.repository.getMeBootstrap();
    return { body: out };
  });

  router.get("/v1/teams/:teamId/sessions", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const items = await ctx.repository.listTeamSessionsFull(teamId);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/agent-runtimes", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const items = await ctx.repository.listAgentRuntimesForTeam(teamId);
    return { body: { items } };
  });

  router.get("/v1/sessions/:sessionId/participants", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const out = await ctx.repository.listSessionParticipants(sessionId);
    return { body: out };
  });

  router.post("/v1/sessions/:sessionId/participants", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const body = ctx.json ?? {};
    requireString(body.actorId, "actorId");
    const out = await ctx.repository.upsertSessionParticipant(sessionId, body);
    return { body: out };
  });

  router.delete("/v1/sessions/:sessionId/participants/:actorId", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const actorId = decodeURIComponent(ctx.params.actorId);
    await ctx.repository.removeSessionParticipant(sessionId, actorId);
    return { statusCode: 204, body: null };
  });

  router.get("/v1/sessions/by-acp/:acpSessionId", async (ctx) => {
    const acpSessionId = decodeURIComponent(ctx.params.acpSessionId);
    const out = await ctx.repository.getSessionByAcp(acpSessionId);
    if (!out) throw new ApiError(404, "not_found", "no session bound to ACP id");
    return { body: out };
  });

  router.post("/v1/sessions/gateway/ensure", async (ctx) => {
    const body = ctx.json ?? {};
    for (const k of ["teamId", "binding", "title", "primaryAgentActorId"]) {
      requireString(body[k], k);
    }
    const out = await ctx.repository.ensureGatewaySession(body);
    return { body: out };
  });

  router.post("/v1/sessions/display-rows", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    if (!Array.isArray(body.sessionIds)) {
      throw new ApiError(400, "validation_failed", "sessionIds must be an array");
    }
    const items = await ctx.repository.listSessionDisplayRows(body.teamId, body.sessionIds);
    return { body: { items } };
  });

  router.post("/v1/sessions/cron", async (ctx) => {
    const body = ctx.json ?? {};
    for (const k of ["teamId", "primaryAgentActorId", "title"]) {
      requireString(body[k], k);
    }
    const out = await ctx.repository.createCronSession(body);
    return { body: out };
  });
}
