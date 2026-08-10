import { ApiError } from "../http-utils.js";
import {
  requireString,
  parseMessageLimit,
  decodeMessageCursor,
  nextMessageCursor,
} from "../routing-utils.js";

export function registerMessages(router) {
  // Paginated backward from the newest message. `nextCursor` was hardcoded to
  // null here while the repository fetched the entire history unbounded, so a
  // long-running session degraded until it timed out — see the limits in
  // routing-utils. Omitting `limit` now yields the most recent
  // DEFAULT_MESSAGE_LIST_LIMIT messages (oldest-first within the page) plus a
  // cursor for the page before it.
  router.get("/v1/sessions/:sessionId/messages", async (ctx) => {
    const limit = parseMessageLimit(ctx.query.get("limit"));
    const cursor = decodeMessageCursor(ctx.query.get("cursor"));
    const items = await ctx.repository.listMessages(
      decodeURIComponent(ctx.params.sessionId),
      { limit, cursor },
    );
    return { body: { items, nextCursor: nextMessageCursor(items, limit) } };
  });

  router.post("/v1/sessions/:sessionId/messages", async (ctx) => {
    const body = ctx.json;
    requireString(body.id, "id");
    requireString(body.teamId, "teamId");
    requireString(body.senderActorId, "senderActorId");
    requireString(body.content, "content");

    const idempotencyKey = ctx.getHeader("idempotency-key");
    if (idempotencyKey && idempotencyKey !== body.id) {
      throw new ApiError(400, "validation_failed", "Idempotency-Key must match message id");
    }

    const message = await ctx.repository.insertMessage(decodeURIComponent(ctx.params.sessionId), body);
    return { body: message };
  });

  router.patch("/v1/messages/:messageId", async (ctx) => {
    const patch = ctx.json ?? {};
    const message = await ctx.repository.patchMessage(decodeURIComponent(ctx.params.messageId), patch);
    return { body: message };
  });

  router.delete("/v1/messages/:messageId", async (ctx) => {
    await ctx.repository.deleteMessage(decodeURIComponent(ctx.params.messageId));
    return { statusCode: 204 };
  });
}