import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged, isSidecar } from "../harness/converge.mjs";

// Three nodes: A edits + syncs first; B has an unsynced edit (gets a sidecar,
// remote wins); C (clean observer) pulls A's version. All three converge.
const RUN = process.env.RUN_THREE_NODE === "1";
// Generous settle so A's version reliably propagates before B's competing sync.
const settle = (ms = 20000) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { if (RUN) ctx = await provisionTwoNodeTeam({ threeNode: true }); }, { timeout: 240000 });
after(async () => { await ctx?.teardown(); }, { timeout: 150000 });

test("three-node conflict: A wins the file, B keeps a sidecar, C follows; all converge", { skip: !RUN, timeout: 220000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // Base on all three.
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("base\n"));
  await sync(nodes.a);
  await settle();
  await sync(nodes.b);
  await sync(nodes.c);

  // A edits + syncs first.
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("A-edit\n"));
  await sync(nodes.a);
  await settle();

  // B has an unsynced edit then syncs → sidecar + remote wins.
  await writeFile("node-b", `${root}/skills/x.md`, Buffer.from("B-edit\n"));
  const b1 = await sync(nodes.b);
  assert.ok(b1.conflicts >= 1, `B should report a conflict, got ${b1.conflicts}`);

  // C was clean → just pulls A-edit.
  let treeC = {};
  for (let i = 0; i < 6; i++) {
    await sync(nodes.c);
    treeC = await ctx.lsContentRoot("node-c", teamId);
    if (treeC["skills/x.md"] && Buffer.from(treeC["skills/x.md"], "base64").toString() === "A-edit\n") break;
    await settle(3000);
  }

  const treeA = await ctx.lsContentRoot("node-a", teamId);
  const treeB = await ctx.lsContentRoot("node-b", teamId);
  for (const [lbl, t] of [["A", treeA], ["B", treeB], ["C", treeC]]) {
    assert.equal(Buffer.from(t["skills/x.md"], "base64").toString(), "A-edit\n", `${lbl} x.md should be A-edit`);
  }
  // B preserved its edit as a sidecar; A and C have none.
  assert.ok(Object.keys(treeB).some(isSidecar), "B should keep a sidecar of its edit");
  assert.ok(!Object.keys(treeA).some(isSidecar), "A should have no sidecar");
  assert.ok(!Object.keys(treeC).some(isSidecar), "C should have no sidecar");
  assertConverged(treeA, treeC, "tri-AC");
});
