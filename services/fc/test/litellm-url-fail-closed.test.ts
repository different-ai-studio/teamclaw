import { test } from "node:test";
import assert from "node:assert/strict";
import { LITELLM_URL } from "../src/lib/litellm.js";

// Regression guard. LITELLM_URL used to default to a hosted third-party gateway
// (https://ai.ucar.cc), so a deployment that forgot to set it would silently
// send its AI traffic off-box instead of failing. The whole point of removing
// that default is that a missing value must be loud, so pin the behaviour:
// reintroducing ANY fallback URL turns these red.

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.LITELLM_URL;
  if (value === undefined) delete process.env.LITELLM_URL;
  else process.env.LITELLM_URL = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.LITELLM_URL;
    else process.env.LITELLM_URL = prev;
  }
}

test("LITELLM_URL: unset throws instead of returning a hosted default", () => {
  withEnv(undefined, () => {
    assert.throws(() => LITELLM_URL(), /LITELLM_URL is not set/);
  });
});

test("LITELLM_URL: blank and whitespace-only are treated as unset", () => {
  // A blank line in .env reaches the process as "", and compose's :- default
  // does not cover an explicitly-empty value in every runner — so "" must fail
  // exactly like unset rather than concatenating into "/team/new".
  for (const blank of ["", "   "]) {
    withEnv(blank, () => {
      assert.throws(() => LITELLM_URL(), /LITELLM_URL is not set/);
    });
  }
});

test("LITELLM_URL: an explicit value is returned trimmed", () => {
  withEnv("  http://litellm:4000  ", () => {
    assert.equal(LITELLM_URL(), "http://litellm:4000");
  });
});
