import { ApiError } from "../http-utils.js";

export function registerRuntime(router) {
  // GET /v1/agents/runtimes/latest — must be registered before /v1/agents/runtimes (no path conflict, but order matters for some routers)
  router.get("/v1/agents/runtimes/latest", async (ctx) => {
    const agentId = ctx.query.get("agentId");
    const sessionId = ctx.query.get("sessionId");
    if (!agentId) throw new ApiError(400, "validation_failed", "agentId is required");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const runtime = await ctx.repository.getLatestAgentRuntime({ agentId, sessionId });
    if (!runtime) throw new ApiError(404, "not_found", "agent runtime not found");
    return { body: runtime };
  });

  router.get("/v1/agents/runtimes", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const runtimeId = ctx.query.get("runtimeId") ?? undefined;
    const backendSessionId = ctx.query.get("backendSessionId") ?? undefined;
    const runtime = await ctx.repository.getAgentRuntime({ sessionId, runtimeId, backendSessionId });
    if (!runtime) throw new ApiError(404, "not_found", "agent runtime not found");
    return { body: runtime };
  });

  router.post("/v1/agents/runtimes", async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.agentActorId) throw new ApiError(400, "validation_failed", "agentActorId is required");
    if (!body.sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    if (!body.runtimeId) throw new ApiError(400, "validation_failed", "runtimeId is required");
    if (!body.backendSessionId) throw new ApiError(400, "validation_failed", "backendSessionId is required");
    const result = await ctx.repository.upsertAgentRuntime(body);
    return { body: result };
  });

  router.patch("/v1/agents/runtimes/:runtimeRowId/cursor", async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.lastProcessedMessageId) throw new ApiError(400, "validation_failed", "lastProcessedMessageId is required");
    await ctx.repository.updateRuntimeCursor(ctx.params.runtimeRowId, { lastProcessedMessageId: body.lastProcessedMessageId });
    return { statusCode: 204, body: null };
  });

  router.post("/v1/agents/types/ensure", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.supportedTypes)) throw new ApiError(400, "validation_failed", "supportedTypes is required and must be an array");
    if (!body.defaultAgentType) throw new ApiError(400, "validation_failed", "defaultAgentType is required");
    await ctx.repository.ensureAgentTypes({ supportedTypes: body.supportedTypes, defaultAgentType: body.defaultAgentType });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/runtime/hints", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const agentIds = ctx.query.getAll("agentId");
    const items = await ctx.repository.listLatestAgentRuntimeHints(teamId, agentIds);
    return { body: { items } };
  });

  router.get("/v1/runtime/agent-defaults", async (ctx) => {
    const agentIds = ctx.query.getAll("agentId");
    const items = await ctx.repository.listAgentDefaults(agentIds);
    return { body: { items } };
  });

  router.patch("/v1/runtime/:runtimeId/model", async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.model) throw new ApiError(400, "validation_failed", "model is required");
    await ctx.repository.updateRuntimeModel(ctx.params.runtimeId, body.model);
    return { statusCode: 204, body: null };
  });

  router.get("/v1/runtime", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    const items = await ctx.repository.listDaemonRuntimes(teamId);
    return { body: { items } };
  });

  router.get("/v1/sessions/:sessionId/runtime-models", async (ctx) => {
    const items = await ctx.repository.listSessionRuntimeModels(ctx.params.sessionId);
    return { body: { items } };
  });

  router.get("/v1/sessions/:sessionId/runtime-targets", async (ctx) => {
    const agentIds = ctx.query.getAll("agentId");
    const items = await ctx.repository.listRuntimeTargetsForSession(ctx.params.sessionId, agentIds);
    return { body: { items } };
  });

}
