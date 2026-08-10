import { ApiError } from "../http-utils.js";
import { parseLimit, decodeSyncCursor, nextSyncCursor } from "../routing-utils.js";

/**
 * Incremental sync readers.
 *
 * Every route here is paginated on (updated_at, id) and reports `nextCursor`.
 * They used to return every changed row in a single response, which made a
 * first-time sync of a large team unbounded — 10k actors measured 3.1MB / 4.4s
 * on /v1/sync/actor-directory, and /v1/sync/messages had the same shape over a
 * session's whole history.
 *
 * Consequence for callers: a client that ignores `nextCursor` now sees only the
 * first page, so every consumer MUST page to exhaustion. That is the same
 * contract /v1/sync/sessions already had.
 */
export function registerSync(router) {
  // Reads the shared `limit`/`cursor` pair off a request.
  const page = (ctx) => ({
    limit: parseLimit(ctx.query.get("limit")),
    cursor: decodeSyncCursor(ctx.query.get("cursor")),
  });

  router.get("/v1/sync/actor-directory", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const since = ctx.query.get("since") || null;
    const { limit, cursor } = page(ctx);
    const items = await ctx.repository.listActorDirectoryForSync(teamId, since, { limit, cursor });
    return { body: { items, nextCursor: nextSyncCursor(items, limit) } };
  });

  router.get("/v1/sync/ideas", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const since = ctx.query.get("since") || null;
    const { limit, cursor } = page(ctx);
    const items = await ctx.repository.listIdeasForSync(teamId, since, { limit, cursor });
    return { body: { items, nextCursor: nextSyncCursor(items, limit) } };
  });

  router.get("/v1/sync/session-participants", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const since = ctx.query.get("since") || null;
    const { limit, cursor } = page(ctx);
    const items = await ctx.repository.listSessionParticipantsForSync(sessionId, since, { limit, cursor });
    return { body: { items, nextCursor: nextSyncCursor(items, limit) } };
  });

  router.get("/v1/sync/sessions", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const since = ctx.query.get("since") || null;
    const { limit, cursor } = page(ctx);
    const items = await ctx.repository.listSessionsForTeamSince(teamId, since, { limit, cursor });
    return { body: { items, nextCursor: nextSyncCursor(items, limit) } };
  });

  router.get("/v1/sync/messages", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const since = ctx.query.get("since") || null;
    const { limit, cursor } = page(ctx);
    const items = await ctx.repository.listMessagesForSessionSince(sessionId, since, { limit, cursor });
    return { body: { items, nextCursor: nextSyncCursor(items, limit) } };
  });
}
