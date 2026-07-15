import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { provisionTwoNodeTeam } from "../harness/setup.mjs";
import { execSh, contentRootPath } from "../harness/docker.mjs";
import { sync } from "../harness/daemon-client.mjs";
import { assertConverged } from "../harness/converge.mjs";

// "Offline node catches up": A makes many changes while B is idle; B then drains
// the whole manifest (cursor pagination) in subsequent syncs and converges.
// HEAVY (multi-file catch-up): opt-in via RUN_HEAVY=1 — see 10-nested for why
// (prod FC rate-limiting makes it time out; run against a non-rate-limited FC).
const RUN_HEAVY = process.env.RUN_HEAVY === "1";
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 8;

let ctx;
before(async () => { if (RUN_HEAVY) ctx = await provisionTwoNodeTeam(); }, { timeout: 180000 });
after(async () => { await ctx?.teardown(); }, { timeout: 150000 });

test(`offline catch-up: B pulls all ${N} files A created while B was idle`, { skip: !RUN_HEAVY, timeout: 260000 }, async () => {
  const { nodes, teamId } = ctx;
  const root = contentRootPath(teamId);

  // A creates N files under skills/ in one shot.
  await execSh(
    "node-a",
    `mkdir -p ${root}/skills && for i in $(seq 1 ${N}); do printf 'file-%s\\n' "$i" > ${root}/skills/f$i.md; done`,
  );

  // Upload success is only observable via B, and a transiently-failed upload stays
  // dirty and is retried on A's next tick — so interleave A-push + B-pull until B
  // holds all N. (A's LOCAL tree always has all N, so it can't gate on that.)
  // Transient prod errors are retried inside sync(); converge by re-syncing.
  const count = (t) => Object.keys(t).filter((k) => k.startsWith("skills/f")).length;
  let treeB = {};
  for (let i = 0; i < 14; i++) {
    await sync(nodes.a);
    await sync(nodes.b);
    treeB = await ctx.lsContentRoot("node-b", teamId);
    if (count(treeB) >= N) break;
    await settle(3000);
  }

  assert.equal(count(treeB), N, `B should have pulled all ${N} files, got ${count(treeB)}`);
  const treeA = await ctx.lsContentRoot("node-a", teamId);
  assertConverged(treeA, treeB, "offline-catchup");
});
