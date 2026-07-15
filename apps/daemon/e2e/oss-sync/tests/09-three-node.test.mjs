import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

const RUN = process.env.RUN_THREE_NODE === "1";
let ctx;
before(async () => { if (RUN) ctx = await provisionTwoNodeTeam({ threeNode: true }); }, { timeout: 240000 });
after(async () => { await ctx?.teardown(); }, { timeout: 150000 });

test("three-node: A write converges to B and C", { skip: !RUN, timeout: 180000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);
  await writeFile("node-a", `${root}/skills/y.md`, Buffer.from("tri\n"));
  await sync(nodes.a);
  await sync(nodes.b);
  await sync(nodes.c);

  const ta = await ctx.lsContentRoot("node-a", teamId);
  const tb = await ctx.lsContentRoot("node-b", teamId);
  const tc = await ctx.lsContentRoot("node-c", teamId);
  assertConverged(ta, tb, "tri-AB");
  assertConverged(ta, tc, "tri-AC");
});
