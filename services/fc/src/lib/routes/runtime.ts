import { ApiError } from "../http-utils.js";

export function registerRuntime(router) {

  router.post("/v1/agents/types/ensure", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.supportedTypes)) throw new ApiError(400, "validation_failed", "supportedTypes is required and must be an array");
    if (!body.defaultAgentType) throw new ApiError(400, "validation_failed", "defaultAgentType is required");
    await ctx.repository.ensureAgentTypes({ supportedTypes: body.supportedTypes, defaultAgentType: body.defaultAgentType });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/runtime/agent-defaults", async (ctx) => {
    const agentIds = ctx.query.getAll("agentId");
    const items = await ctx.repository.listAgentDefaults(agentIds);
    return { body: { items } };
  });

}
