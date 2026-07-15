import { ApiError } from "../http-utils.js";

const ALLOWED_BUCKETS = new Set(["attachments", "avatars"]);
const DEFAULT_BUCKET = "attachments";

function resolveBucket(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_BUCKET;
  if (!ALLOWED_BUCKETS.has(value)) {
    throw new ApiError(400, "invalid_request", `unsupported bucket: ${value}`);
  }
  return value;
}

export function registerAttachments(router) {
  router.postRaw("/v1/attachments", async (ctx) => {
    const path = ctx.query.get("path");
    if (!path) throw new ApiError(400, "invalid_request", "path query parameter is required");
    const bucket = resolveBucket(ctx.query.get("bucket"));
    const mime = ctx.headers["content-type"] ?? "application/octet-stream";
    const out = await ctx.repository.uploadAttachment({ path, mime, bytes: ctx.rawBody, bucket });
    return { statusCode: 200, body: out };
  });

  router.get("/v1/attachments/:path", async (ctx) => {
    const bucket = resolveBucket(ctx.query.get("bucket"));
    const out = await ctx.repository.downloadAttachment(ctx.params.path, { bucket });
    if (!out) throw new ApiError(404, "not_found", "attachment not found");
    return { binary: { mime: out.mime, bytes: out.bytes } };
  });
}
