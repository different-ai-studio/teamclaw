import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// Coverage breadth: nested subdirectories + every allowed sync prefix.
// HEAVY (multi-file): opt-in via RUN_HEAVY=1. Against the shared, aggressively
// rate-limited prod FC these multi-upload scenarios cannot converge within a sane
// test timeout even with retries; run them against a non-rate-limited FC (local
// postgres+minio+FC stack). They are correct/code-complete — just infra-bound on prod.
const RUN_HEAVY = process.env.RUN_HEAVY === "1";
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { if (RUN_HEAVY) ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

const FILES = {
  "skills/deep/nested/dir/a.md": "nested skill\n",
  "knowledge/notes/k.md": "knowledge entry\n",
  ".mcp/servers/m.json": "{\"mcp\":true}\n",
  "_meta/info.txt": "meta\n",
};

test("nested dirs + multiple prefixes all sync and converge", { skip: !RUN_HEAVY, timeout: 180000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  for (const [rel, content] of Object.entries(FILES)) {
    await writeFile("node-a", `${root}/${rel}`, Buffer.from(content));
  }

  // Interleave A (push, retrying any transiently-failed upload each tick) + B
  // (pull) until B holds every file.
  // Transient prod errors are retried inside sync(); converge by re-syncing.
  const keys = Object.keys(FILES);
  let treeB = {};
  for (let i = 0; i < 10; i++) {
    await sync(nodes.a);
    await sync(nodes.b);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (keys.every((k) => treeB[k])) break;
    await settle(3000);
  }

  for (const [rel, content] of Object.entries(FILES)) {
    assert.ok(treeB[rel], `B should have ${rel}`);
    assert.equal(Buffer.from(treeB[rel], "base64").toString(), content, `content of ${rel}`);
  }
  const treeA = await ctx.lsContentRoot("node-a", teamId);
  assertConverged(treeA, treeB, "nested-prefixes");
});
