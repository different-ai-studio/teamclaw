import { ApiError } from "../http-utils.js";
import { sharedSecretMatches } from "../shared-secret.js";
import { createSkillUploadUrl } from "../skills-storage.js";

/**
 * Skills marketplace routes.
 * Design: docs/architecture/skills-marketplace.md
 *
 * Admin endpoints authenticate with MARKETPLACE_ADMIN_SECRET via
 * `x-webhook-secret` (auth: "marketplace-admin"). Read/adopt use bearer JWT.
 */
function assertMarketplaceAdmin(ctx: any) {
  if (
    !sharedSecretMatches(
      ctx.getHeader?.("x-webhook-secret") ?? ctx.headers?.["x-webhook-secret"],
      process.env.MARKETPLACE_ADMIN_SECRET,
    )
  ) {
    throw new ApiError(401, "unauthorized", "marketplace admin secret required");
  }
}

export function registerMarketplace(router) {
  router.get("/v1/marketplace/skills", async (ctx) => {
    const opts: any = {};
    const q = ctx.query.get("q");
    if (q) opts.q = q;
    const category = ctx.query.get("category");
    if (category) opts.category = category;
    const teamId = ctx.query.get("teamId");
    if (teamId) opts.teamId = teamId;
    const cursor = ctx.query.get("cursor");
    if (cursor) opts.cursor = cursor;
    const items = await ctx.repository.listMarketplaceSkills(opts);
    return { body: { items } };
  });

  router.get("/v1/marketplace/skills/:slug", async (ctx) => {
    const opts: any = {};
    const teamId = ctx.query.get("teamId");
    if (teamId) opts.teamId = teamId;
    const skill = await ctx.repository.getMarketplaceSkill(ctx.params.slug, opts);
    return { body: skill };
  });

  router.post("/v1/teams/:teamId/skills/adopt", async (ctx) => {
    const skill = await ctx.repository.adoptMarketplaceSkill(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: skill };
  });

  router.post("/v1/teams/:teamId/skills/:slug/detach", async (ctx) => {
    const skill = await ctx.repository.detachMarketplaceSkill(
      ctx.params.teamId,
      ctx.params.slug,
    );
    return { body: skill };
  });

  // ── Admin (shared secret) ──────────────────────────────────────────────

  router.post(
    "/v1/admin/marketplace/skill-blobs/prepare",
    { auth: "marketplace-admin" },
    async (ctx) => {
      assertMarketplaceAdmin(ctx);
      const prepared = await ctx.repository.prepareMarketplaceSkillBlob(ctx.json ?? {});
      let presignedPut: string | null = null;
      if (prepared.requiresUpload) {
        presignedPut = await createSkillUploadUrl(prepared.objectPath);
      }
      return {
        body: {
          contentHash: prepared.contentHash,
          size: prepared.size,
          objectPath: prepared.objectPath,
          requiresUpload: prepared.requiresUpload,
          presignedPut,
        },
      };
    },
  );

  router.post(
    "/v1/admin/marketplace/skill-blobs/complete",
    { auth: "marketplace-admin" },
    async (ctx) => {
      assertMarketplaceAdmin(ctx);
      const done = await ctx.repository.completeMarketplaceSkillBlob(ctx.json ?? {});
      return { body: done };
    },
  );

  router.post("/v1/admin/marketplace/skills", { auth: "marketplace-admin" }, async (ctx) => {
    assertMarketplaceAdmin(ctx);
    const skill = await ctx.repository.createMarketplaceSkill(ctx.json ?? {});
    return { statusCode: 201, body: skill };
  });

  router.post(
    "/v1/admin/marketplace/skills/:slug/versions",
    { auth: "marketplace-admin" },
    async (ctx) => {
      assertMarketplaceAdmin(ctx);
      const version = await ctx.repository.createMarketplaceSkillVersion(
        ctx.params.slug,
        ctx.json ?? {},
      );
      return { statusCode: 201, body: version };
    },
  );

  router.post(
    "/v1/admin/marketplace/skills/:slug/versions/:version/promote",
    { auth: "marketplace-admin" },
    async (ctx) => {
      assertMarketplaceAdmin(ctx);
      const version = Number(ctx.params.version);
      if (!Number.isInteger(version) || version < 1) {
        throw new ApiError(400, "validation_failed", "version must be a positive integer");
      }
      const row = await ctx.repository.promoteMarketplaceSkillVersion(ctx.params.slug, version);
      return { body: row };
    },
  );

  router.post(
    "/v1/admin/marketplace/skills/:slug/versions/:version/revert",
    { auth: "marketplace-admin" },
    async (ctx) => {
      assertMarketplaceAdmin(ctx);
      const version = Number(ctx.params.version);
      if (!Number.isInteger(version) || version < 1) {
        throw new ApiError(400, "validation_failed", "version must be a positive integer");
      }
      const row = await ctx.repository.revertMarketplaceSkillVersion(ctx.params.slug, version);
      return { statusCode: 201, body: row };
    },
  );

  router.patch(
    "/v1/admin/marketplace/skills/:slug",
    { auth: "marketplace-admin" },
    async (ctx) => {
      assertMarketplaceAdmin(ctx);
      const skill = await ctx.repository.updateMarketplaceSkill(ctx.params.slug, ctx.json ?? {});
      return { body: skill };
    },
  );

  router.post("/v1/admin/marketplace/align", { auth: "marketplace-admin" }, async (ctx) => {
    assertMarketplaceAdmin(ctx);
    const result = await ctx.repository.alignAllMarketplaceSubscriptions();
    return { body: result };
  });
}
