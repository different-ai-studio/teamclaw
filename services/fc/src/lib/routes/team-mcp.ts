import { ApiError } from "../http-utils.js";

/**
 * Team MCP catalog routes.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * The catalog is writable by any team member; installing is per-member and
 * self-only. Adding a server here does not run anything on anyone's machine —
 * that only happens once a member installs it, which is what makes the open
 * write policy safe (`command` is spawned locally by the installer's daemon).
 */
export function registerTeamMcp(router) {
  // Full catalog, decorated with the caller's own `installed` flag.
  router.get("/v1/teams/:teamId/mcp-servers", async (ctx) => {
    const items = await ctx.repository.listTeamMcpServers(ctx.params.teamId);
    return { body: { items } };
  });

  // Daemon-facing. Returns exactly a Cursor `mcpServers` map containing only
  // the caller's installed servers — the same byte shape the daemon used to
  // read off disk, so its parser needs no changes.
  //
  // Registered before /:name so "config" is not swallowed as a server name.
  router.get("/v1/teams/:teamId/mcp-servers/config", async (ctx) => {
    const cfg = await ctx.repository.getTeamMcpConfig(ctx.params.teamId);
    return { body: cfg };
  });

  router.post("/v1/teams/:teamId/mcp-servers", async (ctx) => {
    const server = await ctx.repository.createTeamMcpServer(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: server };
  });

  router.patch("/v1/teams/:teamId/mcp-servers/:name", async (ctx) => {
    const server = await ctx.repository.updateTeamMcpServer(
      ctx.params.teamId,
      ctx.params.name,
      ctx.json ?? {},
    );
    return { body: server };
  });

  router.delete("/v1/teams/:teamId/mcp-servers/:name", async (ctx) => {
    await ctx.repository.deleteTeamMcpServer(ctx.params.teamId, ctx.params.name);
    return { statusCode: 204, body: null };
  });

  // Install/uninstall take no actor parameter by design: "run this command on
  // my machine" is not a decision that can be made on someone else's behalf.
  router.put("/v1/teams/:teamId/mcp-servers/:name/install", async (ctx) => {
    if (ctx.json && ctx.json.actorId !== undefined) {
      throw new ApiError(
        400,
        "validation_failed",
        "actorId is not accepted — team MCP servers can only be installed for yourself",
      );
    }
    const install = await ctx.repository.installTeamMcpServer(
      ctx.params.teamId,
      ctx.params.name,
    );
    return { body: install };
  });

  router.delete("/v1/teams/:teamId/mcp-servers/:name/install", async (ctx) => {
    await ctx.repository.uninstallTeamMcpServer(ctx.params.teamId, ctx.params.name);
    return { statusCode: 204, body: null };
  });
}
