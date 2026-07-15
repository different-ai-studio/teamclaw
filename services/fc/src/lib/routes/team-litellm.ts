export function registerTeamLiteLlm(router) {
  router.post("/v1/teams/:teamId/litellm/setup", async (ctx) => {
    const result = await ctx.repository.setupLiteLlm(ctx.params.teamId);
    return { body: result };
  });

  // Self-service: idempotently ensure the caller's own member key for this
  // team, auto-provisioning the team's LiteLLM if it hasn't been set up yet.
  router.post("/v1/teams/:teamId/litellm/member-key", async (ctx) => {
    const result = await ctx.repository.ensureMemberKey(ctx.params.teamId);
    return { body: result };
  });

  // Team-wide token + spend usage from LiteLLM. range = day|week|month|year
  // (default month); optional `date` (yyyy-mm-dd) selects the period to view.
  router.get("/v1/teams/:teamId/litellm/usage", async (ctx) => {
    const range = ctx.query.get("range") ?? "month";
    const date = ctx.query.get("date") ?? undefined;
    const result = await ctx.repository.getLiteLlmUsage(ctx.params.teamId, { range, date });
    return { body: result };
  });

  // Lists the team's LiteLLM virtual keys (masked). Any team member may read.
  router.get("/v1/teams/:teamId/litellm/keys", async (ctx) => {
    const result = await ctx.repository.listLiteLlmKeys(ctx.params.teamId);
    return { body: result };
  });

  // Sets the team's LiteLLM max budget. Owner-only.
  router.put("/v1/teams/:teamId/litellm/budget", async (ctx) => {
    const result = await ctx.repository.setLiteLlmBudget(ctx.params.teamId, { maxBudget: ctx.json?.maxBudget });
    return { body: result };
  });
}
