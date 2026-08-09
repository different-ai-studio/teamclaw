/**
 * Team env secret routes.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * Values never travel in the clear: the client encrypts with the team key and
 * these handlers only ever see `{v, nonce, ciphertext}`. Nothing here can
 * decrypt, and that is the point — the server is storage, not a key holder.
 */
export function registerTeamEnvSecrets(router) {
  router.get("/v1/teams/:teamId/env-secrets", async (ctx) => {
    const items = await ctx.repository.listTeamEnvSecrets(ctx.params.teamId);
    return { body: { items } };
  });

  router.put("/v1/teams/:teamId/env-secrets/:keyId", async (ctx) => {
    const secret = await ctx.repository.putTeamEnvSecret(
      ctx.params.teamId,
      ctx.params.keyId,
      ctx.json ?? {},
    );
    return { body: secret };
  });

  router.delete("/v1/teams/:teamId/env-secrets/:keyId", async (ctx) => {
    await ctx.repository.deleteTeamEnvSecret(ctx.params.teamId, ctx.params.keyId);
    return { statusCode: 204, body: null };
  });
}
