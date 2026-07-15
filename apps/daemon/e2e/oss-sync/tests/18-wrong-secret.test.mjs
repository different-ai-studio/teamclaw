import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { writeFile, contentRootPath } from "../harness/docker.mjs";
import { sync, setSecret } from "../harness/daemon-client.mjs";
import { genTeamSecret } from "../harness/secret.mjs";

// Robustness / negative: a node holding the WRONG team secret cannot decrypt
// peers' blobs. The daemon must fail gracefully — no crash, and crucially no
// corrupted/garbage file written locally.
//
// Note (observation): decryption failures are currently swallowed per-file (the
// engine logs a warning and skips), so the sync reports no lastError. The safe
// invariant we assert is "no crash, no corrupted file". Surfacing a clearer
// "wrong secret" signal to the user would be a future improvement.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => { ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 120000 });

test("wrong team secret on B: decrypt fails gracefully, no corrupted file, no crash", { timeout: 150000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // A pushes a file encrypted with the correct shared secret.
  await writeFile("node-a", `${root}/skills/secret.md`, Buffer.from("top secret\n"));
  const a1 = await sync(nodes.a);
  assert.equal(a1.lastError ?? null, null, `A sync error: ${a1.lastError}`);
  assert.ok(a1.pushed >= 1, `A should push, got ${a1.pushed}`);

  // Re-key B to a DIFFERENT secret, then sync.
  const wrong = genTeamSecret();
  await setSecret(nodes.b, wrong);

  let treeB = {};
  for (let i = 0; i < 3; i++) {
    const b = await sync(nodes.b); // must not throw / crash the daemon
    assert.ok(b && typeof b === "object", "B sync should return a status object (no crash)");
    treeB = await ctx.lsContentRoot("node-b", teamId);
    await settle(2500);
  }

  // B must NOT have written a decrypted file (it couldn't decrypt) — no garbage.
  assert.equal(treeB["skills/secret.md"], undefined, "B must not write a file it cannot decrypt");

  // Daemon is still alive: a follow-up status/sync call still works.
  const after = await sync(nodes.b);
  assert.ok(after && typeof after === "object", "daemon still responsive after decrypt failure");
});
