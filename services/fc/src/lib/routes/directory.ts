import { ApiError } from "../http-utils.js";

export function registerDirectory(router) {
  router.get("/v1/directory/current-member-actor", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    const userId = ctx.query.get("userId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    if (!userId) throw new ApiError(400, "validation_failed", "userId is required");
    const out = await ctx.repository.resolveCurrentMemberActor(teamId, userId);
    return { body: out };
  });

  router.get("/v1/directory/first-member-actor-for-user", async (ctx) => {
    const userId = ctx.query.get("userId");
    if (!userId) throw new ApiError(400, "validation_failed", "userId is required");
    const out = await ctx.repository.resolveFirstMemberActorForUser(userId);
    return { body: out };
  });

  router.get("/v1/directory/current-team-member", async (ctx) => {
    const teamId = ctx.query.get("teamId");
    const userId = ctx.query.get("userId");
    if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
    if (!userId) throw new ApiError(400, "validation_failed", "userId is required");
    const out = await ctx.repository.getCurrentTeamMember(teamId, userId);
    return { body: out };
  });
}
