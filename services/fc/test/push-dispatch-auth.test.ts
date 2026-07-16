import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { sharedSecretMatches } from "../src/lib/shared-secret.js";
import { handlePushDispatch } from "../src/lib/admin-handlers.js";

// A body that authenticates but stops before dispatchPush, so these tests never
// reach the push infrastructure: reaching `skipped` proves auth PASSED, and 401
// proves it did not. That is the whole signal we need here.
const NON_MESSAGE_BODY = { type: "PROBE" };

const ORIGINAL = process.env.PUSH_WEBHOOK_SECRET;
beforeEach(() => {
  delete process.env.PUSH_WEBHOOK_SECRET;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUSH_WEBHOOK_SECRET;
  else process.env.PUSH_WEBHOOK_SECRET = ORIGINAL;
});

async function dispatch(headers: Record<string, string> | undefined) {
  const res: any = await handlePushDispatch(headers, NON_MESSAGE_BODY);
  return res.status ?? res.statusCode;
}

// The regression this file exists for. With the old `provided !== secret`
// check and no secret configured, `secret` was "" and an empty header compared
// equal — so /push/dispatch authenticated anyone who sent `x-webhook-secret:`.
// Verified reproducible against the deployed self-host box before the fix.
test("unset secret rejects an EMPTY header (the bypass)", async () => {
  assert.equal(await dispatch({ "x-webhook-secret": "" }), 401);
});

test("unset secret rejects a missing header", async () => {
  assert.equal(await dispatch({}), 401);
  assert.equal(await dispatch(undefined), 401);
});

test("unset secret rejects any non-empty guess", async () => {
  assert.equal(await dispatch({ "x-webhook-secret": "anything" }), 401);
});

test("configured secret accepts the matching value", async () => {
  process.env.PUSH_WEBHOOK_SECRET = "s3cret";
  assert.equal(await dispatch({ "x-webhook-secret": "s3cret" }), 200);
});

test("configured secret rejects a wrong or empty value", async () => {
  process.env.PUSH_WEBHOOK_SECRET = "s3cret";
  assert.equal(await dispatch({ "x-webhook-secret": "wrong!" }), 401);
  assert.equal(await dispatch({ "x-webhook-secret": "" }), 401);
  assert.equal(await dispatch({}), 401);
});

// A same-length wrong guess is the case timingSafeEqual exists for; it must
// still be rejected, not throw.
test("configured secret rejects a same-length wrong value", async () => {
  process.env.PUSH_WEBHOOK_SECRET = "abcdef";
  assert.equal(await dispatch({ "x-webhook-secret": "abcdeg" }), 401);
});

test("sharedSecretMatches fails closed when the secret is unset", () => {
  for (const secret of [undefined, null, ""]) {
    for (const provided of [undefined, null, "", "guess"]) {
      assert.equal(
        sharedSecretMatches(provided, secret),
        false,
        `expected false for provided=${JSON.stringify(provided)} secret=${JSON.stringify(secret)}`,
      );
    }
  }
});

test("sharedSecretMatches compares by value, not by length alone", () => {
  assert.equal(sharedSecretMatches("abc", "abc"), true);
  assert.equal(sharedSecretMatches("abc", "abd"), false);
  assert.equal(sharedSecretMatches("ab", "abc"), false);
  assert.equal(sharedSecretMatches("abcd", "abc"), false);
});
