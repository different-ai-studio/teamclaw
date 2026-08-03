import test from "node:test";
import assert from "node:assert/strict";

import { chunkedIn, IN_FILTER_CHUNK_SIZE } from "../src/lib/supabase-repo/shared.js";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

test("chunkedIn issues one call when the list fits", async () => {
  const calls: any[][] = [];
  const out = await chunkedIn(ids(IN_FILTER_CHUNK_SIZE), async (chunk) => {
    calls.push(chunk);
    return chunk;
  });
  assert.equal(calls.length, 1);
  assert.equal(out.length, IN_FILTER_CHUNK_SIZE);
});

test("chunkedIn splits past the chunk size and concatenates in order", async () => {
  const calls: any[][] = [];
  const input = ids(2000);
  const out = await chunkedIn(input, async (chunk) => {
    calls.push(chunk);
    return chunk;
  });

  // 2000 / 100 — the production regression was 1296 ids in a single ~48KB URL.
  assert.equal(calls.length, 20);
  assert.ok(calls.every((c) => c.length <= IN_FILTER_CHUNK_SIZE));
  assert.deepEqual(out, input, "results concatenate in input order");
});

test("chunkedIn short-circuits on empty input without calling fn", async () => {
  let called = false;
  const out = await chunkedIn([], async (chunk) => {
    called = true;
    return chunk;
  });
  assert.equal(called, false);
  assert.deepEqual(out, []);
});

test("chunkedIn keeps a chunk's URL well under kong's 414 threshold", async () => {
  // A uuid costs 37 bytes in `id=in.(…)` (36 + comma). The guard in
  // supabase-repo.ts trips at 4096.
  const worstCaseChunkBytes = IN_FILTER_CHUNK_SIZE * 37;
  assert.ok(
    worstCaseChunkBytes < 4096,
    `chunk of ${IN_FILTER_CHUNK_SIZE} uuids is ${worstCaseChunkBytes} bytes`,
  );
});

test("chunkedIn propagates the first failing chunk", async () => {
  let seen = 0;
  await assert.rejects(
    chunkedIn(ids(300), async (chunk) => {
      seen += 1;
      if (seen === 2) throw new Error("upstream 500");
      return chunk;
    }),
    /upstream 500/,
  );
  assert.equal(seen, 2, "stops at the failing chunk rather than finishing the sweep");
});
