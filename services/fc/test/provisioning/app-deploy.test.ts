import { test } from "node:test";
import assert from "node:assert/strict";
import { startDeploy, finalizeDeploy } from "../../src/lib/provisioning/app-deploy.js";

test("startDeploy provisions schema + function and returns fc identity + oss key", async () => {
  const ensured: any[] = [];
  const deps = {
    adminExec: async () => {},
    fcOps: { ensureFunction: async (n: string, a: any) => { ensured.push([n, a]); },
             ensureHttpTrigger: async () => "unused-here",
             updateFunctionCode: async () => {} },
    bucket: "teamclaw-sync",
    appsBaseUrl: "postgres://host:5432/teamclaw_apps",
    genPassword: () => "pw-fixed",
    mintUploadUrl: async (k: string) => `https://oss.example/put/${k}?sig=x`,
  };
  const out = await startDeploy(deps as any, {
    appId: "3f1c9a2e-0000-4000-8000-000000000abc", slug: "Demo App", region: "cn-hangzhou",
  });
  assert.equal(out.fcFunctionName, "tc-app-3f1c9a2e-0000-4000-8000-000000000abc");
  assert.equal(out.fcRegion, "cn-hangzhou");
  assert.equal(out.ossObjectName, "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip");
  const [, args] = ensured[0];
  assert.equal(args.env.PORT, "9000");
  assert.match(args.env.DATABASE_URL, /app_3f1c9a2e/);
  assert.match(out.presignedPut, /code\.zip\?sig=x/);
});

test("finalizeDeploy code-only-updates then returns the http trigger URL", async () => {
  const calls: any[] = [];
  const fcOps = {
    updateFunctionCodeOnly: async (n: string, k: string) => { calls.push(["update", n, k]); },
    ensureHttpTrigger: async (n: string) => { calls.push(["trigger", n]); return "https://fn.example.fcapp.run"; },
  };
  const out = await finalizeDeploy({ fcOps }, { fcFunctionName: "tc-app-1", ossObjectName: "apps/1/code.zip" });
  assert.deepEqual(out, { fcEndpoint: "https://fn.example.fcapp.run" });
  assert.deepEqual(calls[0], ["update", "tc-app-1", "apps/1/code.zip"]);
  assert.deepEqual(calls[1], ["trigger", "tc-app-1"]);
});
