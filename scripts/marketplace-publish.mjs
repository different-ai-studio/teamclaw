#!/usr/bin/env node
/**
 * Publish a skill directory to the first-party marketplace.
 *
 *   pnpm marketplace:publish ./path/to/skill --slug deploy-check --changelog "…"
 *   pnpm marketplace:publish ./path/to/skill --slug deploy-check --promote
 *
 * Reads SKILL.md + optional catalog.yaml (displayName, publisher, summary,
 * category, whenToUse, whenNotToUse, requires, tags). Catalog.yaml is CLI
 * input only — not an in-repo source of truth.
 *
 * Env:
 *   MARKETPLACE_API_BASE   default https://api.teamclu-dev.ucar.cc
 *   MARKETPLACE_ADMIN_SECRET  required (x-webhook-secret)
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

function usage() {
  console.error(`Usage: pnpm marketplace:publish <skill-dir> --slug <slug> --changelog <text> [--promote]
Env: MARKETPLACE_ADMIN_SECRET (required), MARKETPLACE_API_BASE (optional)`);
  process.exit(2);
}

function parseArgs(argv) {
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

function loadYamlish(path) {
  if (!existsSync(path)) return {};
  // Minimal key: value parser — enough for catalog.yaml, no nested structures.
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v.startsWith("[") && v.endsWith("]")) {
      out[m[1]] = v
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      out[m[1]] = v;
    }
  }
  return out;
}

/** Very small store-only zip (no compression) for skill directories. */
function zipDir(root) {
  const files = [];
  function walk(rel) {
    const abs = join(root, rel);
    // Sorted, not raw readdir order. The whole pipeline is content-addressed on
    // sha256(zip): the hash is the storage key and prepare/complete dedupe on
    // it. readdirSync returns entries in filesystem order — roughly insertion
    // order on APFS, hash order on ext4 — so publishing an unchanged skill from
    // a laptop and from CI produced two different hashes, two blobs, and a
    // second "new version" with byte-identical content.
    for (const name of readdirSync(abs).sort()) {
      if (name === "." || name === "..") continue;
      const child = rel ? `${rel}/${name}` : name;
      const st = statSync(join(root, child));
      if (st.isDirectory()) walk(child);
      else files.push({ name: child, data: readFileSync(join(root, child)) });
    }
  }
  walk("");
  // Depth-first with sorted siblings is already deterministic; this pins the
  // final order regardless of how walk() is refactored later.
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    const crc = crc32(f.data);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    parts.push(local, f.data);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    nameBuf.copy(cen, 46);
    central.push(cen);
    offset += local.length + f.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

async function api(base, secret, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": secret,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return json;
}

async function main() {
  void deflateRawSync; // keep zlib import for future compressed entries
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);
  const secret = process.env.MARKETPLACE_ADMIN_SECRET;
  if (!secret) {
    console.error("MARKETPLACE_ADMIN_SECRET is required");
    process.exit(1);
  }
  const base = (process.env.MARKETPLACE_API_BASE || "https://api.teamclu-dev.ucar.cc").replace(
    /\/$/,
    "",
  );

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
      await api(base, secret, "POST", "/v1/admin/marketplace/skills", {
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

  const prepared = await api(base, secret, "POST", "/v1/admin/marketplace/skill-blobs/prepare", {
    contentHash,
    size,
  });
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

  await api(base, secret, "POST", "/v1/admin/marketplace/skill-blobs/complete", {
    contentHash,
    size,
  });

  const version = await api(base, secret, "POST", `/v1/admin/marketplace/skills/${args.slug}/versions`, {
    contentHash,
    size,
    changelog: args.changelog,
    summary,
    category,
    whenToUse,
    whenNotToUse,
    requires,
  });
  console.log(`Created version v${version.version} (unpublished)`);

  if (args.promote) {
    await api(
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
