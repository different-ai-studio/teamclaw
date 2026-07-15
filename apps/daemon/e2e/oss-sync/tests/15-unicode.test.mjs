import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// Non-ASCII filenames + content (Chinese + emoji) round-trip through encryption,
// presigned OSS, and the manifest.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const REL = "skills/中文-文件 名.md";
const CONTENT = "你好，世界 🌏\n第二行：测试 UTF-8 往返。\n";

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("unicode filename + content round-trips byte-identical", { timeout: 150000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  await writeFile("node-a", `${root}/${REL}`, Buffer.from(CONTENT, "utf8"));
  const a1 = await sync(nodes.a);
  assert.equal(a1.lastError ?? null, null, `A sync error: ${a1.lastError}`);
  assert.ok(a1.pushed >= 1, `A should push the unicode file, got ${a1.pushed}`);

  let treeB = {};
  for (let i = 0; i < 6; i++) {
    const b = await sync(nodes.b);
    assert.equal(b.lastError ?? null, null, `B sync error: ${b.lastError}`);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (treeB[REL]) break;
    await settle(3000);
  }

  assert.ok(treeB[REL], `B should have ${REL}, tree=${JSON.stringify(Object.keys(treeB))}`);
  assert.equal(Buffer.from(treeB[REL], "base64").toString("utf8"), CONTENT, "unicode content must match");
  const treeA = await ctx.lsContentRoot("node-a", teamId);
  assertConverged(treeA, treeB, "unicode");
});
