import { ApiError } from "../http-utils.js";
import { parseLimit, decodeSyncCursor, nextSyncCursor } from "../routing-utils.js";

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

  // Paginated: a first-time sync of a large team used to return every session
  // row in one response. `limit`/`cursor` are optional — omitting the cursor
  // starts at the beginning, and `nextCursor` is null on the last page.
  router.get("/v1/sync/sessions", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const since = ctx.query.get("since") || null;
    const limit = parseLimit(ctx.query.get("limit"));
    const cursor = decodeSyncCursor(ctx.query.get("cursor"));
    const items = await ctx.repository.listSessionsForTeamSince(teamId, since, { limit, cursor });
    return { body: { items, nextCursor: nextSyncCursor(items, limit) } };
  });

  router.get("/v1/sync/messages", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const since = ctx.query.get("since") || null;
    const items = await ctx.repository.listMessagesForSessionSince(sessionId, since);
    return { body: { items } };
  });
}
