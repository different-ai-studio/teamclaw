import { ApiError } from "../http-utils.js";

export function registerRuntime(router) {

  router.post("/v1/agents/types/ensure", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.supportedTypes)) throw new ApiError(400, "validation_failed", "supportedTypes is required and must be an array");
    // An empty list is how a daemon says "I currently run nothing" — its
    // configured runtime is not installed, or none is configured. That has to
    // be recordable: refusing it left the previous answer standing, so clients
    // painted a runtime badge for a backend the machine could no longer start.
    // A default is still required whenever there *are* types to be default of.
    if (body.supportedTypes.length > 0 && !body.defaultAgentType) {
      throw new ApiError(400, "validation_failed", "defaultAgentType is required");
    }
    await ctx.repository.ensureAgentTypes({
      supportedTypes: body.supportedTypes,
      defaultAgentType: body.defaultAgentType ?? null,
    });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/runtime/agent-defaults", async (ctx) => {
    const agentIds = ctx.query.getAll("agentId");
    const items = await ctx.repository.listAgentDefaults(agentIds);
    return { body: { items } };
  });

}
