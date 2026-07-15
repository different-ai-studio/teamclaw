import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, execSh, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// Verifies the fix for delete propagation: a file removed locally on one node is
// pushed as a server-side tombstone (fc.delete_file) and other nodes drop it on
// the next sync. Previously the PUSH phase ignored locally-removed files entirely.

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("remote delete + local clean: B drops the file after A deletes", { timeout: 150000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // Establish skills/x.md on both nodes (pull-until-present for eventual consistency).
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("v1\n"));
  await sync(nodes.a);
  let treeB = {};
  for (let i = 0; i < 6; i++) {
    const b = await sync(nodes.b);
    assert.equal(b.lastError ?? null, null, `B sync error: ${b.lastError}`);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (treeB["skills/x.md"]) break;
    await settle(3000);
  }
  assert.ok(treeB["skills/x.md"], "precondition: B should have pulled x.md");

  // A deletes x.md locally and syncs → emits a server-side tombstone.
  await execSh("node-a", `rm -f ${root}/skills/x.md`);
  const a2 = await sync(nodes.a);
  assert.equal(a2.lastError ?? null, null, `A delete-sync error: ${a2.lastError}`);

  // B syncs (pull-until-gone for eventual consistency) and should drop the file.
  for (let i = 0; i < 6; i++) {
    const b = await sync(nodes.b);
    assert.equal(b.lastError ?? null, null, `B sync error: ${b.lastError}`);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (!treeB["skills/x.md"]) break;
    await settle(3000);
  }

  const treeA = await ctx.lsContentRoot("node-a", teamId);
  assert.equal(treeA["skills/x.md"], undefined, "A removed x.md locally");
  assert.equal(treeB["skills/x.md"], undefined, "B should have removed x.md after the deletion propagated");
  assertConverged(treeA, treeB, "remote-delete-clean");
});
