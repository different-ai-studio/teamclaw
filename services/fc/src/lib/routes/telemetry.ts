import { ApiError } from "../http-utils.js";
import { requireString } from "../routing-utils.js";

const VALID_KINDS = new Set(["positive", "negative"]);
const VALID_PERIODS = new Set(["day", "week", "month"]);
const VALID_CLIENT_TYPES = new Set(["tauri", "ios", "expo", "daemon"]);

export function registerTelemetry(router) {
  router.post("/v1/feedback", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.messageId, "messageId");
    requireString(body.actorId, "actorId");
    requireString(body.teamId, "teamId");
    requireString(body.kind, "kind");
    if (!VALID_KINDS.has(body.kind)) {
      throw new ApiError(400, "validation_failed", "kind must be one of: positive, negative");
    }
    if (body.starRating !== undefined && body.starRating !== null) {
      const r = Number(body.starRating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        throw new ApiError(400, "validation_failed", "starRating must be an integer from 1 to 5");
      }
    }
    const feedback = await ctx.repository.submitFeedback(body);
    return { statusCode: 201, body: feedback };
  });

  router.get("/v1/feedback", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const result = await ctx.repository.listFeedback({ sessionId });
    return { body: result };
  });

  router.delete("/v1/feedback/:messageId", async (ctx) => {
    const messageId = decodeURIComponent(ctx.params.messageId);
    await ctx.repository.deleteFeedback(messageId, null);
    return { statusCode: 204, body: null };
  });

  router.get("/v1/feedback-summary", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    // listFeedbackSummary already returns { items: [...] }; pass it through
    // (do NOT re-wrap — that would double-nest the items array).
    const result = await ctx.repository.listFeedbackSummary(teamId);
    return { body: result };
  });

  router.post("/v1/session-report", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.actorId, "actorId");
    requireString(body.teamId, "teamId");
    requireString(body.sessionId, "sessionId");
    await ctx.repository.submitSessionReport(body);
    return { statusCode: 201, body: null };
  });

  router.post("/v1/skill-usage", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.actorId, "actorId");
    requireString(body.teamId, "teamId");
    requireString(body.skill, "skill");
    if (body.count !== undefined && body.count !== null) {
      const c = Number(body.count);
      if (!Number.isInteger(c) || c < 1) {
        throw new ApiError(400, "validation_failed", "count must be a positive integer");
      }
    }
    await ctx.repository.submitSkillUsage(body);
    return { statusCode: 201, body: null };
  });

  router.post("/v1/teams/:teamId/client-version", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const body = ctx.json ?? {};
    requireString(body.clientType, "clientType");
    requireString(body.version, "version");
    requireString(body.deviceId, "deviceId");
    if (!VALID_CLIENT_TYPES.has(body.clientType)) {
      throw new ApiError(400, "validation_failed", "clientType must be one of: tauri, ios, expo, daemon");
    }
    await ctx.repository.reportClientVersion(teamId, {
      clientType: body.clientType,
      version: body.version,
      deviceId: body.deviceId,
      build: body.build ?? null,
    });
    return { body: { ok: true } };
  });

  router.get("/v1/teams/:teamId/leaderboard", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const period = ctx.query.get("period") ?? "week";
    if (!VALID_PERIODS.has(period)) {
      throw new ApiError(400, "validation_failed", "period must be one of: day, week, month");
    }
    const result = await ctx.repository.getTeamLeaderboard(teamId, { period });
    return { body: result };
  });
}
