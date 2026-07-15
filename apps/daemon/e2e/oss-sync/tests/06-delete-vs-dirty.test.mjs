import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, execSh, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("remote delete + local dirty: B keeps its local edit (no data loss)", { timeout: 120000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("v1\n"));
  await sync(nodes.a);
  await sync(nodes.b); // 双方有 x.md

  // A 删除并同步；B 在 sync 前本地改脏 x.md。
  await execSh("node-a", `rm -f ${root}/skills/x.md`);
  await sync(nodes.a);
  await writeFile("node-b", `${root}/skills/x.md`, Buffer.from("B-dirty-edit\n"));

  const b2 = await sync(nodes.b);
  assert.equal(b2.lastError ?? null, null, `B sync error: ${b2.lastError}`);

  // 期望：B 的本地改动不被远端删除直接抹掉（保留 / 备份）。
  const treeB = await ctx.lsContentRoot("node-b", teamId);
  const hasDirty =
    treeB["skills/x.md"] && Buffer.from(treeB["skills/x.md"], "base64").toString() === "B-dirty-edit\n";
  const hasSidecar = Object.keys(treeB).some((k) => /x\.conflict\./.test(k));
  assert.ok(
    hasDirty || hasSidecar,
    `B's dirty edit must survive (as x.md or sidecar); tree=${JSON.stringify(Object.keys(treeB))}`,
  );
});
