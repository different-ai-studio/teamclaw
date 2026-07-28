import { test } from "node:test";
import assert from "node:assert/strict";
import { startDeploy, finalizeDeploy, needsDatabase } from "../../src/lib/provisioning/app-deploy.js";

test("startDeploy mints the upload handle and names the function + object", async () => {
  const out = await startDeploy(
    { mintUploadUrl: async (k: string) => `https://oss.example/put/${k}?sig=x` },
    { appId: "3f1c9a2e-0000-4000-8000-000000000abc", region: "cn-hangzhou" },
  );
  assert.equal(out.fcFunctionName, "tc-app-3f1c9a2e-0000-4000-8000-000000000abc");
  assert.equal(out.fcRegion, "cn-hangzhou");
  assert.equal(out.ossObjectName, "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip");
  assert.match(out.presignedPut, /code\.zip\?sig=x/);
});

test("startDeploy does NOT touch FC — the code object does not exist yet", async () => {
  // Regression: creating the function here made CreateFunction reference an OSS
  // object the daemon had not uploaded. Function creation belongs in finalize.
  let mintCalls = 0;
  await startDeploy(
    { mintUploadUrl: async () => { mintCalls += 1; return "https://oss.example/put"; } },
    { appId: "app-1", region: "cn-hangzhou" },
  );
  assert.equal(mintCalls, 1);
});

test("finalizeDeploy provisions the schema, then sets code + env together", async () => {
  const calls: any[] = [];
  const out = await finalizeDeploy(
    {
      adminExec: async (sql: string) => { calls.push(["sql", sql]); },
      fcOps: {
        ensureFunction: async (n: string, a: any) => { calls.push(["ensureFunction", n, a]); },
        ensureHttpTrigger: async (n: string) => { calls.push(["trigger", n]); return "https://fn.example.fcapp.run"; },
      },
      appsBaseUrl: "postgres://host:5432/teamclaw_apps",
      genPassword: () => "pw-fixed",
    },
    {
      appId: "3f1c9a2e-0000-4000-8000-000000000abc",
      slug: "Demo App",
      appType: "data_app",
      fcFunctionName: "tc-app-3f1c9a2e-0000-4000-8000-000000000abc",
      ossObjectName: "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip",
    },
  );
  assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });

  // Schema DDL runs before the function is pointed at the new code.
  assert.equal(calls[0][0], "sql");
  const ensure = calls.find((c) => c[0] === "ensureFunction");
  assert.ok(ensure, "ensureFunction was called");
  const [, name, args] = ensure;
  assert.equal(name, "tc-app-3f1c9a2e-0000-4000-8000-000000000abc");
  assert.equal(args.ossObjectName, "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip");
  assert.equal(args.env.PORT, "9000");
  // The env carries the password that was just applied to the role — the two
  // must be written in the same step or a redeploy locks the app out of its DB.
  assert.match(args.env.DATABASE_URL, /app_3f1c9a2e/);
  assert.match(args.env.DATABASE_URL, /pw-fixed/);
  assert.equal(calls.at(-1)[0], "trigger");
});

test("a static app deploys with no database at all", async () => {
  // Static types have no Postgres schema and no DATABASE_URL — and must deploy
  // even when the apps database is entirely unconfigured.
  const calls: any[] = [];
  for (const appType of ["static_web", "slides"]) {
    const out = await finalizeDeploy(
      {
        fcOps: {
          ensureFunction: async (n: string, a: any) => { calls.push([appType, n, a]); },
          ensureHttpTrigger: async () => "https://fn.example.fcapp.run",
        },
      } as any,
      { appId: "app-1", slug: "demo", appType, fcFunctionName: "tc-app-1", ossObjectName: "apps/app-1/code.zip" },
    );
    assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });
  }
  assert.equal(calls.length, 2);
  for (const [type, , args] of calls) {
    assert.ok(!("DATABASE_URL" in args.env), `${type}: no DATABASE_URL`);
    assert.equal(args.env.PORT, "9000");
  }
});

test("a data app without a configured database fails loudly", async () => {
  await assert.rejects(
    () => finalizeDeploy(
      {
        fcOps: {
          ensureFunction: async () => { throw new Error("must not be called"); },
          ensureHttpTrigger: async () => "unused",
        },
      } as any,
      { appId: "app-1", slug: "demo", appType: "data_app", fcFunctionName: "tc-app-1", ossObjectName: "k" },
    ),
    /APPS_DB_ADMIN_URL/,
  );
});

test("an unknown or legacy type is treated as a data app", async () => {
  assert.equal(needsDatabase("fullstack_tanstack_postgres"), true);
  assert.equal(needsDatabase(""), true);
  assert.equal(needsDatabase("data_app"), true);
  assert.equal(needsDatabase("static_web"), false);
  assert.equal(needsDatabase(" slides "), false);
});
