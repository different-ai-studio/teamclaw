import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBackendKind, makeBusinessRepoFactory, makeAuthRepoFactory } from "../src/index.js";

test("resolveBackendKind defaults to supabase", () => {
  assert.equal(resolveBackendKind({} as any), "supabase");
  assert.equal(resolveBackendKind({ BACKEND_KIND: "postgres" } as any), "postgres");
  assert.equal(resolveBackendKind({ BACKEND_KIND: "weird" } as any), "supabase");
});

test("postgres factory does not touch DB at construction time", () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const factory = makeBusinessRepoFactory("postgres"); // must NOT throw (lazy getDb)
  assert.equal(typeof factory, "function");
  if (prev) process.env.DATABASE_URL = prev;
});

test("makeAuthRepoFactory returns a function for both kinds, no side effects without env", () => {
  const prevDb = process.env.DATABASE_URL;
  const prevSecret = process.env.AUTH_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.AUTH_SECRET;
  assert.equal(typeof makeAuthRepoFactory("supabase"), "function");
  assert.equal(typeof makeAuthRepoFactory("postgres"), "function"); // must NOT throw (lazy)
  if (prevDb) process.env.DATABASE_URL = prevDb;
  if (prevSecret) process.env.AUTH_SECRET = prevSecret;
});
