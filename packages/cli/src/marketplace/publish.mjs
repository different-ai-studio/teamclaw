import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { adminFetch } from "../_shared/api.mjs";
import { resolveApiEnv } from "../_shared/env.mjs";
import { loadYamlish, zipDir } from "../_shared/fs-pack.mjs";

function usage() {
  console.error(`Usage: teamclu marketplace publish <skill-dir> --slug <slug> --changelog <text> [--promote] [--no-create]
Env: MARKETPLACE_ADMIN_SECRET or TEAMCLU_ADMIN_SECRET (required)
     MARKETPLACE_API_BASE or TEAMCLU_API_BASE (optional)`);
  process.exit(2);
}

function parsePublishArgs(argv) {
  const out = { dir: null, slug: null, changelog: null, promote: false, create: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slug") out.slug = argv[++i];
    else if (a === "--changelog") out.changelog = argv[++i];
    else if (a === "--promote") out.promote = true;
    else if (a === "--no-create") out.create = false;
    else if (a.startsWith("-")) usage();
    else out.dir = a;
  }
  if (!out.dir || !out.slug || !out.changelog) usage();
  return out;
}

export async function publishSkill(argv) {
  const args = parsePublishArgs(argv);
  const dir = resolve(args.dir);
  const { base, secret } = resolveApiEnv();
  if (!secret) {
    console.error("MARKETPLACE_ADMIN_SECRET or TEAMCLU_ADMIN_SECRET is required");
    process.exit(1);
  }

  if (!existsSync(join(dir, "SKILL.md"))) {
    console.error("SKILL.md not found in", dir);
    process.exit(1);
  }

  const catalog = loadYamlish(join(dir, "catalog.yaml"));
  const displayName = catalog.displayName || catalog.name || basename(dir);
  const publisher = catalog.publisher || "TeamClu";
  const summary = catalog.summary || displayName;
  const category = catalog.category || "general";
  const whenToUse = catalog.whenToUse || catalog.when_to_use || "";
  const whenNotToUse = catalog.whenNotToUse || catalog.when_not_to_use || "";
  const requires = catalog.requires ?? null;
  const tags = catalog.tags || [];

  const zip = zipDir(dir);
  const contentHash = createHash("sha256").update(zip).digest("hex");
  const size = zip.length;

  console.log(`Packaged ${dir} → ${size} bytes, sha256=${contentHash.slice(0, 12)}…`);

  if (args.create) {
    try {
      await adminFetch(base, secret, "POST", "/v1/admin/marketplace/skills", {
        slug: args.slug,
        displayName,
        publisher,
        summary,
        category,
        whenToUse,
        whenNotToUse,
        requires,
        tags,
      });
      console.log(`Created catalog item ${args.slug}`);
    } catch (err) {
      if (!String(err.message).includes("409")) throw err;
      console.log(`Catalog item ${args.slug} already exists`);
    }
  }

  const prepared = await adminFetch(
    base,
    secret,
    "POST",
    "/v1/admin/marketplace/skill-blobs/prepare",
    { contentHash, size },
  );
  if (prepared.requiresUpload && prepared.presignedPut) {
    const put = await fetch(prepared.presignedPut, {
      method: "PUT",
      headers: { "content-type": "application/zip" },
      body: zip,
    });
    if (!put.ok) throw new Error(`PUT blob failed: ${put.status}`);
    console.log("Uploaded package blob");
  } else {
    console.log("Blob already present — skipped upload");
  }

  await adminFetch(base, secret, "POST", "/v1/admin/marketplace/skill-blobs/complete", {
    contentHash,
    size,
  });

  const version = await adminFetch(
    base,
    secret,
    "POST",
    `/v1/admin/marketplace/skills/${args.slug}/versions`,
    {
      contentHash,
      size,
      changelog: args.changelog,
      summary,
      category,
      whenToUse,
      whenNotToUse,
      requires,
    },
  );
  console.log(`Created version v${version.version} (unpublished)`);

  if (args.promote) {
    await adminFetch(
      base,
      secret,
      "POST",
      `/v1/admin/marketplace/skills/${args.slug}/versions/${version.version}/promote`,
      {},
    );
    console.log(`Promoted v${version.version} → latest`);
  } else {
    console.log(
      `Not promoted. Run:\n  curl -X POST -H "x-webhook-secret: $MARKETPLACE_ADMIN_SECRET" \\\n    ${base}/v1/admin/marketplace/skills/${args.slug}/versions/${version.version}/promote`,
    );
  }
}
