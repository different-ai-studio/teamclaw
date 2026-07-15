import { test } from "node:test";
import assert from "node:assert/strict";
import { handleManagedGitCreateRepo } from "../src/lib/admin-handlers.js";

/** Run `fn` with patched env + a stubbed global fetch, restoring both after. */
async function withCtx(
  env: Record<string, string | undefined>,
  fetchStub: typeof fetch | undefined,
  fn: () => Promise<void>,
) {
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    savedEnv[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const savedFetch = globalThis.fetch;
  if (fetchStub) globalThis.fetch = fetchStub;
  try {
    await fn();
  } finally {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    globalThis.fetch = savedFetch;
  }
}

const CONFIGURED = { CODEUP_ORG_ID: "org-1", CODEUP_PAT: "pt-secret", CODEUP_BOT_USERNAME: "teamclaw" };

test("rejects when teamId is missing (regression: was 'Missing teamName')", async () => {
  await withCtx(CONFIGURED, undefined, async () => {
    const res = await handleManagedGitCreateRepo({ teamName: "Acme" });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "Missing teamId");
  });
});

test("returns 500 when CodeUp is not configured", async () => {
  await withCtx(
    { CODEUP_ORG_ID: undefined, CODEUP_PAT: undefined, CODEUP_BOT_USERNAME: undefined },
    undefined,
    async () => {
      const res = await handleManagedGitCreateRepo({ teamId: "team-abc" });
      assert.equal(res.statusCode, 500);
    },
  );
});

test("creates repo named from teamId and returns repoHttpUrl/pat/botUsername", async () => {
  let captured: { url: string; body: any } | null = null;
  const fetchStub = (async (url: any, init: any) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ httpUrlToRepo: "https://codeup.aliyun.com/org-1/tc-team-abc.git" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  await withCtx(CONFIGURED, fetchStub, async () => {
    const res = await handleManagedGitCreateRepo({ teamId: "Team-ABC" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.repoHttpUrl, "https://codeup.aliyun.com/org-1/tc-team-abc.git");
    assert.equal(body.pat, "pt-secret");
    assert.equal(body.botUsername, "teamclaw");
    // Repo name is slugged from teamId (lowercased), NOT teamName.
    assert.equal(captured!.body.name, "tc-team-abc");
    assert.equal(captured!.body.path, "tc-team-abc");
    assert.equal(captured!.body.visibility, "private");
  });
});

test("creates a per-app repo named tc-app-{appId} when appId is present", async () => {
  let captured: { url: string; body: any } | null = null;
  const fetchStub = (async (url: any, init: any) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        httpUrlToRepo:
          "https://codeup.aliyun.com/org-1/tc-app-11111111-2222-3333-4444-555555555555.git",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  await withCtx(CONFIGURED, fetchStub, async () => {
    const res = await handleManagedGitCreateRepo({
      teamId: "team-1",
      appId: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(res.statusCode, 200);
    // Repo name is derived from appId (tc-app-{appId}), NOT teamId.
    assert.equal(captured!.body.name, "tc-app-11111111-2222-3333-4444-555555555555");
    assert.equal(captured!.body.path, "tc-app-11111111-2222-3333-4444-555555555555");
    assert.equal(captured!.body.visibility, "private");
  });
});

test("maps CodeUp 409 to a 409 conflict", async () => {
  const fetchStub = (async () =>
    new Response(JSON.stringify({ message: "exists" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

  await withCtx(CONFIGURED, fetchStub, async () => {
    const res = await handleManagedGitCreateRepo({ teamId: "team-abc" });
    assert.equal(res.statusCode, 409);
  });
});
