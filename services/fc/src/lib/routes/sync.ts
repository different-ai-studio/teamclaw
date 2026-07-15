import { ApiError } from "../http-utils.js";

export function registerSync(router) {
  router.get("/v1/sync/actor-directory", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const since = ctx.query.get("since") || null;
    const items = await ctx.repository.listActorDirectoryForSync(teamId, since);
    return { body: { items } };
  });

  router.get("/v1/sync/ideas", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const since = ctx.query.get("since") || null;
    const items = await ctx.repository.listIdeasForSync(teamId, since);
    return { body: { items } };
  });

  router.get("/v1/sync/session-participants", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const since = ctx.query.get("since") || null;
    const items = await ctx.repository.listSessionParticipantsForSync(sessionId, since);
    return { body: { items } };
  });

  router.get("/v1/sync/sessions", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const since = ctx.query.get("since") || null;
    const items = await ctx.repository.listSessionsForTeamSince(teamId, since);
    return { body: { items } };
  });

  router.get("/v1/sync/messages", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const since = ctx.query.get("since") || null;
    const items = await ctx.repository.listMessagesForSessionSince(sessionId, since);
    return { body: { items } };
  });
}
