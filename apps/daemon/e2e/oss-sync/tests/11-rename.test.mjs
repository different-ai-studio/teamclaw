import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, execSh, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// Rename = delete old + add new in one tick. Exercises delete propagation + add
// together (depends on the delete-propagation fix).
// HEAVY (multi-op: add + delete): opt-in via RUN_HEAVY=1 — see 10-nested for why
// (prod FC rate-limiting makes it time out; run against a non-rate-limited FC).
const RUN_HEAVY = process.env.RUN_HEAVY === "1";
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { if (RUN_HEAVY) ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("rename knowledge/old.md -> knowledge/new.md propagates (old gone, new present)", { skip: !RUN_HEAVY, timeout: 220000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  await writeFile("node-a", `${root}/knowledge/old.md`, Buffer.from("renamed-content\n"));
  let treeB = {};
  for (let i = 0; i < 8; i++) {
    await sync(nodes.a);
    await sync(nodes.b);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (treeB["knowledge/old.md"]) break;
    await settle(3000);
  }
  assert.ok(treeB["knowledge/old.md"], "precondition: B has old.md");

  // Rename on A (delete old + add new), then interleave syncs until B reflects it.
  await execSh("node-a", `mv ${root}/knowledge/old.md ${root}/knowledge/new.md`);
  for (let i = 0; i < 10; i++) {
    await sync(nodes.a);
    await sync(nodes.b);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (treeB["knowledge/new.md"] && !treeB["knowledge/old.md"]) break;
    await settle(3000);
  }

  assert.ok(treeB["knowledge/new.md"], "B should have new.md");
  assert.equal(Buffer.from(treeB["knowledge/new.md"], "base64").toString(), "renamed-content\n");
  assert.equal(treeB["knowledge/old.md"], undefined, "B should no longer have old.md");
  const treeA = await ctx.lsContentRoot("node-a", teamId);
  assertConverged(treeA, treeB, "rename");
});
