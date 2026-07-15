import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("idempotent: second sync with no changes is a no-op", { timeout: 120000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("stable\n"));
  await sync(nodes.a);
  await sync(nodes.b);
  await sync(nodes.a); // 收敛

  const treeBefore = await ctx.lsContentRoot("node-a", teamId);

  // 无改动再 sync 两次：pulled=pushed=0。
  const a2 = await sync(nodes.a);
  assert.equal(a2.lastError ?? null, null);
  assert.equal(a2.pushed, 0, `expected pushed=0, got ${a2.pushed}`);
  assert.equal(a2.pulled, 0, `expected pulled=0, got ${a2.pulled}`);

  const b2 = await sync(nodes.b);
  assert.equal(b2.pushed, 0, `expected B pushed=0, got ${b2.pushed}`);
  assert.equal(b2.pulled, 0, `expected B pulled=0, got ${b2.pulled}`);

  const treeAfter = await ctx.lsContentRoot("node-a", teamId);
  assertConverged(treeBefore, treeAfter, "idempotent");
});
