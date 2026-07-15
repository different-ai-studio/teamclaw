import { ApiError } from "../http-utils.js";
import { requireString } from "../routing-utils.js";

export function registerMessages(router) {
  router.get("/v1/sessions/:sessionId/messages", async (ctx) => {
    const items = await ctx.repository.listMessages(decodeURIComponent(ctx.params.sessionId));
    return { body: { items, nextCursor: null } };
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