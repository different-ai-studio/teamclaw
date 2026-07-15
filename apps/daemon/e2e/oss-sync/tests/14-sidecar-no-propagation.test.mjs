import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync, conflicts } from "../harness/daemon-client.mjs";
import { isSidecar } from "../harness/converge.mjs";

// Invariant: a conflict sidecar created on one node must NEVER sync to the other
// node as a new file (the scanner skips *.conflict.* files).
const settle = (ms = 10000) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("conflict sidecar stays local — never propagates to the other node", { timeout: 180000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // Force a conflict on B so it writes a sidecar (same setup as scenario 03).
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("base\n"));
  await sync(nodes.a);
  await settle();
  await sync(nodes.b);
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("A-edit\n"));
  await sync(nodes.a);
  await settle();
  await writeFile("node-b", `${root}/skills/x.md`, Buffer.from("B-edit\n"));
  const b1 = await sync(nodes.b);
  assert.ok(b1.conflicts >= 1, `B should have a conflict, got ${b1.conflicts}`);

  // B has a sidecar locally.
  const treeB = await ctx.lsContentRoot("node-b", teamId);
  const bSidecars = Object.keys(treeB).filter(isSidecar);
  assert.ok(bSidecars.length >= 1, `B should have a local sidecar, tree=${JSON.stringify(Object.keys(treeB))}`);

  // Now sync A repeatedly. A must NEVER receive the sidecar.
  for (let i = 0; i < 3; i++) { await sync(nodes.a); await settle(2500); }
  const treeA = await ctx.lsContentRoot("node-a", teamId);
  const aSidecars = Object.keys(treeA).filter(isSidecar);
  assert.equal(aSidecars.length, 0, `A must NOT receive any sidecar, got ${JSON.stringify(aSidecars)}`);

  // And the daemon-reported conflicts on A should not list a propagated sidecar.
  const csA = await conflicts(nodes.a);
  assert.equal(
    csA.filter((c) => c.kind === "oss-sidecar").length,
    0,
    `A should report no oss-sidecar conflicts, got ${JSON.stringify(csA)}`,
  );
});
