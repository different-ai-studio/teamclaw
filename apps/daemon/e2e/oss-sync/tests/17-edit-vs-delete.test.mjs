import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, execSh, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// Concurrent edit vs delete, edit syncs first: A edits + syncs (remote advances),
// then B deletes the same file and syncs. B's stale-parent delete loses to the
// newer edit; the file content survives and both converge to the edit. (The
// delete INTENT is dropped in favour of the concurrent edit — LWW, no data loss.)
const settle = (ms = 8000) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("edit vs delete (edit syncs first): edit wins, file survives, both converge", { timeout: 150000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // Base on both.
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("base\n"));
  await sync(nodes.a);
  await settle();
  await sync(nodes.b);

  // A edits + syncs FIRST → remote advances.
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("A-edit\n"));
  const a1 = await sync(nodes.a);
  assert.equal(a1.lastError ?? null, null, `A sync error: ${a1.lastError}`);
  await settle();

  // B deletes the file (based on the stale version) and syncs.
  await execSh("node-b", `rm -f ${root}/skills/x.md`);
  let treeB = {};
  for (let i = 0; i < 6; i++) {
    const b = await sync(nodes.b);
    assert.equal(b.lastError ?? null, null, `B sync error: ${b.lastError}`);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (treeB["skills/x.md"] && Buffer.from(treeB["skills/x.md"], "base64").toString() === "A-edit\n") break;
    await settle(3000);
  }

  // Edit wins: the file content survives as A-edit on both nodes.
  const treeA = await ctx.lsContentRoot("node-a", teamId);
  assert.equal(Buffer.from(treeA["skills/x.md"], "base64").toString(), "A-edit\n", "A keeps its edit");
  assert.equal(Buffer.from(treeB["skills/x.md"], "base64").toString(), "A-edit\n", "B's stale delete loses to the edit");
  assertConverged(treeA, treeB, "edit-vs-delete");
});
