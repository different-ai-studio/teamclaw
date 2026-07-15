import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, execSh, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// Path resurrection: delete propagates, then the same path is re-created and
// must sync again (version continues monotonically).
// HEAVY (3 phases × multi-op): opt-in via RUN_HEAVY=1 — see 10-nested for why
// (prod FC rate-limiting makes it time out; run against a non-rate-limited FC).
const RUN_HEAVY = process.env.RUN_HEAVY === "1";
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { if (RUN_HEAVY) ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("delete then re-add same path: B converges to the reborn file", { skip: !RUN_HEAVY, timeout: 260000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // v1 → both have it. (sync A inside the loop so a transiently-failed upload retries.)
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("v1\n"));
  let treeB = {};
  for (let i = 0; i < 8; i++) { await sync(nodes.a); await sync(nodes.b); treeB = await ctx.lsContentRoot("node-b", teamId); if (treeB["skills/x.md"]) break; await settle(3000); }
  assert.ok(treeB["skills/x.md"], "precondition: B has v1");

  // delete → propagates → B drops it.
  await execSh("node-a", `rm -f ${root}/skills/x.md`);
  for (let i = 0; i < 8; i++) { await sync(nodes.a); await sync(nodes.b); treeB = await ctx.lsContentRoot("node-b", teamId); if (!treeB["skills/x.md"]) break; await settle(3000); }
  assert.equal(treeB["skills/x.md"], undefined, "B dropped x.md after delete");

  // re-create same path with new content → B picks it up again.
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("v2-reborn\n"));
  for (let i = 0; i < 10; i++) {
    await sync(nodes.a);
    await sync(nodes.b);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (treeB["skills/x.md"] && Buffer.from(treeB["skills/x.md"], "base64").toString() === "v2-reborn\n") break;
    await settle(3000);
  }

  assert.equal(Buffer.from(treeB["skills/x.md"], "base64").toString(), "v2-reborn\n", "B should have reborn x.md");
  const treeA = await ctx.lsContentRoot("node-a", teamId);
  assertConverged(treeA, treeB, "delete-readd");
});
