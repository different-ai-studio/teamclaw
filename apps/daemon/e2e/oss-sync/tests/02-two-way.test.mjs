import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("two-way: A writes a.md, B writes b.md -> both have both, no conflicts", { timeout: 150000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  await writeFile("node-a", `${root}/skills/a.md`, Buffer.from("A-content\n"));
  await writeFile("node-b", `${root}/skills/b.md`, Buffer.from("B-content\n"));

  // Interleave syncs until both nodes hold both files (eventual consistency:
  // re-syncing also retries any upload that hit a transient FC error).
  let treeA = {}, treeB = {};
  const has = (t) => t["skills/a.md"] && t["skills/b.md"];
  // Transient prod errors are retried inside sync(); don't hard-fail the loop on a
  // lingering transient lastError — just keep going until both nodes converge.
  for (let i = 0; i < 10; i++) {
    const a = await sync(nodes.a);
    const b = await sync(nodes.b);
    assert.equal(a.conflicts, 0, `A unexpected conflicts: ${a.conflicts}`);
    assert.equal(b.conflicts, 0, `B unexpected conflicts: ${b.conflicts}`);
    treeA = await ctx.lsContentRoot("node-a", teamId);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (has(treeA) && has(treeB)) break;
    await settle(3000);
  }

  assert.ok(has(treeA), "A should have both files");
  assert.ok(has(treeB), "B should have both files");
  assertConverged(treeA, treeB, "two-way");
});
