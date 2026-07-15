import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync, resolve } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

// 构造一个 B 侧冲突：x.md 双方分别改，A 先 push，B sync 触发冲突。
async function makeConflict(ctx) {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("base\n"));
  await sync(nodes.a);
  await sync(nodes.b);
  await writeFile("node-a", `${root}/skills/x.md`, Buffer.from("A-edit\n"));
  await writeFile("node-b", `${root}/skills/x.md`, Buffer.from("B-edit\n"));
  await sync(nodes.a);
  await sync(nodes.b); // B 进入冲突态
  return root;
}

test("resolve KeepLocal: B's version re-pushed and wins; both converge to B", { timeout: 120000 }, async () => {
  const { nodes, teamId } = ctx;
  await makeConflict(ctx);

  // KeepLocal → 标 dirty → 下次 push 上传 B 当前本地。但 B 本地此刻已是远端(A)内容，
  // 故先把 B 想保留的内容写回，再 KeepLocal 重推。
  const root = contentRootPath(teamId);
  await writeFile("node-b", `${root}/skills/x.md`, Buffer.from("B-final\n"));
  await resolve(nodes.b, "skills/x.md", "keepLocal");
  const b2 = await sync(nodes.b);
  assert.equal(b2.lastError ?? null, null, `B resync error: ${b2.lastError}`);

  const a2 = await sync(nodes.a); // A 拉到 B-final
  assert.equal(a2.lastError ?? null, null);

  const treeA = await ctx.lsContentRoot("node-a", teamId);
  const treeB = await ctx.lsContentRoot("node-b", teamId);
  assert.equal(Buffer.from(treeA["skills/x.md"], "base64").toString(), "B-final\n", "A should converge to B-final");
  assertConverged(treeA, treeB, "resolve-keep-local");
});

test("resolve KeepRemote: B accepts remote; conflict cleared in state", { timeout: 120000 }, async () => {
  const { nodes, teamId } = ctx;
  await makeConflict(ctx);

  await resolve(nodes.b, "skills/x.md", "keepRemote");
  const b2 = await sync(nodes.b);
  assert.equal(b2.lastError ?? null, null, `B resync error: ${b2.lastError}`);
  // 接受远端后再 sync 不应再报新冲突。
  assert.equal(b2.conflicts, 0, `expected no new conflicts after KeepRemote, got ${b2.conflicts}`);

  const treeA = await ctx.lsContentRoot("node-a", teamId);
  const treeB = await ctx.lsContentRoot("node-b", teamId);
  assert.equal(Buffer.from(treeB["skills/x.md"], "base64").toString(), "A-edit\n", "B keeps remote(A)");
  assertConverged(treeA, treeB, "resolve-keep-remote");
});
