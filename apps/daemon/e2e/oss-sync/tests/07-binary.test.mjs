import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("binary: 5MB random blob round-trips byte-identical", { timeout: 180000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);
  const blob = randomBytes(5 * 1024 * 1024);
  const sha = createHash("sha256").update(blob).digest("hex");

  await writeFile("node-a", `${root}/skills/big.bin`, blob);
  const a1 = await sync(nodes.a);
  assert.equal(a1.lastError ?? null, null, `A sync error: ${a1.lastError}`);

  // Manifest is eventually consistent: B's first sync may run before A's blob is
  // visible. Pull until B has it (or give up after a few tries).
  let treeB = {};
  for (let i = 0; i < 6; i++) {
    const b1 = await sync(nodes.b);
    assert.equal(b1.lastError ?? null, null, `B sync error: ${b1.lastError}`);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (treeB["skills/big.bin"]) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert.ok(treeB["skills/big.bin"], "B should have the binary");
  const got = createHash("sha256").update(Buffer.from(treeB["skills/big.bin"], "base64")).digest("hex");
  assert.equal(got, sha, "binary content must be byte-identical after encrypt/presigned round-trip");
});
