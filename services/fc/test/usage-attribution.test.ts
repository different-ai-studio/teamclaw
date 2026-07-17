import { test } from "node:test";
import assert from "node:assert/strict";
import { rollUpUsageByOwner } from "../src/lib/usage-attribution.js";

const HUMAN = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_HUMAN = "bbbbbbbb-2222-4222-8222-222222222222";
const DAEMON_A = "cccccccc-3333-4333-8333-333333333333";
const DAEMON_B = "dddddddd-4444-4444-8444-444444444444";

const key = (actorId: string | null, over: Partial<any> = {}) => ({
  apiKey: `hash-${actorId ?? "orphan"}`,
  alias: `member-${(actorId ?? "orphan").slice(0, 8)}`,
  actorId,
  tokens: 100,
  spend: 1,
  requests: 2,
  ...over,
});

/** Resolver over a fixed actor→owner table; unknown ids are simply absent. */
const resolver = (table: Record<string, { actorId: string; displayName: string }>) =>
  async (ids: string[]) => {
    const m = new Map<string, { actorId: string; displayName: string }>();
    for (const id of ids) if (table[id]) m.set(id, table[id]);
    return m;
  };

const OWNERS = {
  [HUMAN]: { actorId: HUMAN, displayName: "周金亮" },
  [DAEMON_A]: { actorId: HUMAN, displayName: "周金亮" },
  [DAEMON_B]: { actorId: OTHER_HUMAN, displayName: "matt" },
};

test("daemon spend is attributed to the owning human", async () => {
  const rows = await rollUpUsageByOwner([key(DAEMON_A)], resolver(OWNERS));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorId, HUMAN);
  assert.equal(rows[0].displayName, "周金亮");
});

test("a human's own key and their daemons' keys merge into one row", async () => {
  const rows = await rollUpUsageByOwner(
    [key(HUMAN, { tokens: 10, spend: 0.5, requests: 1 }), key(DAEMON_A, { tokens: 90, spend: 2, requests: 4 })],
    resolver(OWNERS),
  );
  assert.equal(rows.length, 1, "one human ⇒ one row");
  assert.deepEqual(
    { tokens: rows[0].tokens, spend: rows[0].spend, requests: rows[0].requests },
    { tokens: 100, spend: 2.5, requests: 5 },
  );
});

test("distinct owners stay distinct and sort by spend", async () => {
  const rows = await rollUpUsageByOwner(
    [key(DAEMON_A, { spend: 1 }), key(DAEMON_B, { spend: 9 })],
    resolver(OWNERS),
  );
  assert.deepEqual(rows.map((r) => r.displayName), ["matt", "周金亮"]);
});

test("unresolvable keys collapse into ONE unattributed row, never dropped", async () => {
  // The exact failure the live data shows: keys minted before an actor-id
  // rebaseline. Their spend is real money — losing it would make the rows stop
  // summing to the team total.
  const rows = await rollUpUsageByOwner(
    [key(null, { spend: 3 }), key("stale-actor-id", { spend: 4 }), key(DAEMON_A, { spend: 1 })],
    resolver(OWNERS),
  );
  assert.equal(rows.length, 2);
  const un = rows.find((r) => r.actorId === null)!;
  assert.equal(un.spend, 7, "both unresolvable keys land in the same bucket");
  assert.equal(un.displayName, null, "no server-side label — client localizes it");
});

test("unattributed sorts last even when it is the biggest spender", async () => {
  const rows = await rollUpUsageByOwner(
    [key(null, { spend: 1000 }), key(DAEMON_A, { spend: 1 })],
    resolver(OWNERS),
  );
  assert.equal(rows[0].actorId, HUMAN, "a real person tops the board");
  assert.equal(rows[1].actorId, null);
});

test("resolver failure degrades to unattributed instead of throwing", async () => {
  const rows = await rollUpUsageByOwner([key(DAEMON_A, { spend: 2 })], async () => {
    throw new Error("db down");
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorId, null);
  assert.equal(rows[0].spend, 2, "spend survives a resolution outage");
});

test("no resolver call when nothing carries an actor id", async () => {
  let called = false;
  const rows = await rollUpUsageByOwner([key(null)], async (ids) => {
    called = true;
    return new Map();
  });
  assert.equal(called, false);
  assert.equal(rows[0].actorId, null);
});
