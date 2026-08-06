import { ApiError } from "../http-utils.js";

/**
 * Team skills registry routes.
 *
 * Design: docs/architecture/team-skills-registry.md
 *
 * The zip itself never travels through these handlers. Publishing is two steps:
 * the client uploads the package via the existing amuxc blob path and then
 * posts the resulting contentHash here. That keeps big bodies off the business
 * API and reuses the blob dedupe we already have.
 */
export function registerTeamSkills(router) {
  // Full registry. `actorId` picks whose install state decorates the rows —
  // omit it for "me", pass a team agent's actor id to inspect that agent.
  router.get("/v1/teams/:teamId/skills", async (ctx) => {
    const opts: any = {};
    const actorId = ctx.query.get("actorId");
    if (actorId) opts.actorId = actorId;
    const status = ctx.query.get("status");
    if (status) opts.status = status;
    const category = ctx.query.get("category");
    if (category) opts.category = category;
    const items = await ctx.repository.listTeamSkills(ctx.params.teamId, opts);
    return { body: { items } };
  });

  // What a given actor should have installed. The daemon hosting a team agent
  // polls this and reconciles the full set.
  router.get("/v1/teams/:teamId/skill-installs", async (ctx) => {
    const opts: any = {};
    const actorId = ctx.query.get("actorId");
    if (actorId) opts.actorId = actorId;
    const items = await ctx.repository.listTeamSkillInstalls(ctx.params.teamId, opts);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/skills/:slug", async (ctx) => {
    const opts: any = {};
    const actorId = ctx.query.get("actorId");
    if (actorId) opts.actorId = actorId;
    const skill = await ctx.repository.getTeamSkill(ctx.params.teamId, ctx.params.slug, opts);
    return { body: skill };
  });

  router.post("/v1/teams/:teamId/skills", async (ctx) => {
    const skill = await ctx.repository.createTeamSkill(ctx.params.teamId, ctx.json ?? {});
    return { statusCode: 201, body: skill };
  });

  // Content-addressed package upload (amuxc_blobs), without an amuxc_files path.
  // Client: prepare → optional PUT → complete → POST /skills with contentHash.
  router.post("/v1/teams/:teamId/skill-blobs/prepare", async (ctx) => {
    const prepared = await ctx.repository.prepareTeamSkillBlob(
      ctx.params.teamId,
      ctx.json ?? {},
    );
    const { getS3Client, OSS_BUCKET } = await import("../oss.js");
    const { HeadObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const s3 = getS3Client();
    const bucket = OSS_BUCKET();
    let requiresUpload = true;
    let presignedPut: string | null = null;
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: prepared.ossKey }),
      );
      if (head.ContentLength === prepared.size) {
        requiresUpload = false;
      }
    } catch (e: any) {
      if (
        e.$metadata?.httpStatusCode !== 404 &&
        e.name !== "NotFound" &&
        e.Code !== "NoSuchKey"
      ) {
        console.error("[skill-blobs/prepare] HEAD OSS error:", e.message);
      }
    }
    if (requiresUpload) {
      const putCmd = new PutObjectCommand({
        Bucket: bucket,
        Key: prepared.ossKey,
        ContentLength: prepared.size,
      });
      presignedPut = await getSignedUrl(s3 as any, putCmd, { expiresIn: 900 });
    }
    return {
      body: {
        contentHash: prepared.contentHash,
        size: prepared.size,
        ossKey: prepared.ossKey,
        requiresUpload,
        presignedPut,
      },
    };
  });

  router.post("/v1/teams/:teamId/skill-blobs/complete", async (ctx) => {
    const body = ctx.json ?? {};
    const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
    // Re-resolve placeholder so we know expected size before HEAD.
    const prepared = await ctx.repository.prepareTeamSkillBlob(ctx.params.teamId, body);
    const { getS3Client, OSS_BUCKET } = await import("../oss.js");
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = getS3Client();
    const bucket = OSS_BUCKET();
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: prepared.ossKey }),
      );
      if (head.ContentLength !== prepared.size) {
        throw new ApiError(
          422,
          "blob_missing",
          `Blob size mismatch: expected ${prepared.size}, got ${head.ContentLength}`,
        );
      }
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(422, "blob_missing", `Blob missing or unreachable: ${e.message}`);
    }
    const done = await ctx.repository.completeTeamSkillBlob(ctx.params.teamId, {
      contentHash,
      size: prepared.size,
    });
    return { body: done };
  });

  router.post("/v1/teams/:teamId/skills/:slug/versions", async (ctx) => {
    const version = await ctx.repository.createTeamSkillVersion(
      ctx.params.teamId,
      ctx.params.slug,
      ctx.json ?? {},
    );
    return { statusCode: 201, body: version };
  });

  router.get("/v1/teams/:teamId/skills/:slug/versions/:version", async (ctx) => {
    const version = Number(ctx.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "validation_failed", "version must be a positive integer");
    }
    const row = await ctx.repository.getTeamSkillVersion(
      ctx.params.teamId,
      ctx.params.slug,
      version,
    );
    return { body: row };
  });

  // Hands back a short-lived signed URL rather than proxying the bytes: the
  // package can be megabytes and the business API is not the place for that.
  router.get("/v1/teams/:teamId/skills/:slug/versions/:version/download", async (ctx) => {
    const version = Number(ctx.params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "validation_failed", "version must be a positive integer");
    }
    const blob = await ctx.repository.getTeamSkillDownload(
      ctx.params.teamId,
      ctx.params.slug,
      version,
    );
    const { getS3Client, OSS_BUCKET } = await import("../oss.js");
    const { signedDownloadUrl } = await import("../sync-handlers.js");
    const url = await signedDownloadUrl(getS3Client(), OSS_BUCKET(), blob.ossKey);
    return { body: { url, contentHash: blob.contentHash, size: blob.size } };
  });

  router.patch("/v1/teams/:teamId/skills/:slug", async (ctx) => {
    const skill = await ctx.repository.updateTeamSkill(
      ctx.params.teamId,
      ctx.params.slug,
      ctx.json ?? {},
    );
    return { body: skill };
  });

  router.delete("/v1/teams/:teamId/skills/:slug", async (ctx) => {
    await ctx.repository.deleteTeamSkill(ctx.params.teamId, ctx.params.slug);
    return { statusCode: 204, body: null };
  });

  router.put("/v1/teams/:teamId/skills/:slug/install", async (ctx) => {
    const install = await ctx.repository.installTeamSkill(
      ctx.params.teamId,
      ctx.params.slug,
      ctx.json ?? {},
    );
    return { body: install };
  });

  router.delete("/v1/teams/:teamId/skills/:slug/install", async (ctx) => {
    // DELETE bodies are legal but awkward for some clients, so the target actor
    // can also arrive as a query param.
    const body: any = ctx.json ?? {};
    const actorId = ctx.query.get("actorId");
    if (actorId && body.actorId === undefined) body.actorId = actorId;
    await ctx.repository.uninstallTeamSkill(ctx.params.teamId, ctx.params.slug, body);
    return { statusCode: 204, body: null };
  });
}
