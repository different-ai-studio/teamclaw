import { ApiError } from "../http-utils.js";
import { requireString } from "../routing-utils.js";

export function registerNotifications(router) {
  router.post("/v1/devices/push-token", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.deviceId, "deviceId");
    requireString(body.token, "token");
    await ctx.repository.registerDevicePushToken({
      deviceId: body.deviceId,
      platform: body.platform ?? "ios",
      provider: body.provider ?? "apns",
      token: body.token,
      appVersion: body.appVersion ?? null,
    });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/notifications/prefs", async (ctx) => {
    const out = await ctx.repository.getNotificationPrefs();
    return { body: out };
  });

  router.put("/v1/notifications/prefs", async (ctx) => {
    const body = ctx.json ?? {};
    const out = await ctx.repository.putNotificationPrefs(body);
    return { body: out };
  });

  // Frontend client (cloud-api/notifications.ts) uses POST for save; mirror PUT.
  router.post("/v1/notifications/prefs", async (ctx) => {
    const body = ctx.json ?? {};
    const out = await ctx.repository.putNotificationPrefs(body);
    return { body: out };
  });

  router.get("/v1/notifications/muted-sessions", async (ctx) => {
    // repo.listMutedSessions already returns { items: [...] }
    const out = await ctx.repository.listMutedSessions();
    return { body: out };
  });

  router.post("/v1/sessions/:sessionId/mute", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    const body = ctx.json ?? {};
    await ctx.repository.muteSession(sessionId, body);
    return { statusCode: 204, body: null };
  });

  router.delete("/v1/sessions/:sessionId/mute", async (ctx) => {
    const sessionId = decodeURIComponent(ctx.params.sessionId);
    await ctx.repository.unmuteSession(sessionId);
    return { statusCode: 204, body: null };
  });
}