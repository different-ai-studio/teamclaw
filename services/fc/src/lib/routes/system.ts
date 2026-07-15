import { ApiError } from "../http-utils.js";

export function registerSystem(router) {
  router.post("/v1/heartbeat", async (ctx) => {
    await ctx.repository.heartbeat();
    return { statusCode: 204 };
  });

  router.post("/v1/presence/foreground", async (ctx) => {
    const body = ctx.json ?? {};
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (!deviceId) {
      throw new ApiError(400, "invalid_request", "deviceId is required");
    }
    const foregroundUntil = typeof body.foregroundUntil === "string" ? body.foregroundUntil : "";
    if (!foregroundUntil || Number.isNaN(Date.parse(foregroundUntil))) {
      throw new ApiError(400, "invalid_request", "foregroundUntil must be ISO 8601");
    }
    await ctx.repository.writeForegroundPresence({ deviceId, foregroundUntil });
    return { statusCode: 204 };
  });
}