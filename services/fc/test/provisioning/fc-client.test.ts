import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFcOps, fcEndpoint, accountIdFromRoleArn } from "../../src/lib/provisioning/fc-client.js";

function fakeClient(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  const base = {
    async getFunction(name: string) { calls.push(["getFunction", name]); return { body: { functionName: name } }; },
    async createFunction(req: any) { calls.push(["createFunction", req]); return { body: {} }; },
    async updateFunction(name: string, req: any) { calls.push(["updateFunction", name, req]); return { body: {} }; },
    async createTrigger(name: string, req: any) { calls.push(["createTrigger", name, req]); return { body: {} }; },
    async getTrigger(name: string, trig: string) { calls.push(["getTrigger", name, trig]); return { body: { httpTrigger: { urlInternet: "https://fn.example.fcapp.run" } } }; },
  };
  return { client: { ...base, ...overrides }, calls };
}

test("ensureFunction creates when GetFunction 404s", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "createFunction"));
  assert.ok(!calls.some((c) => c[0] === "updateFunction"));
});

test("ensureFunction updates code when the function already exists", async () => {
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "updateFunction"));
  assert.ok(!calls.some((c) => c[0] === "createFunction"));
});

test("ensureFunction points the custom runtime at the artifact's own layout", async () => {
  // The daemon zips the CONTENTS of `.output`, so the entry is `server/index.mjs`.
  // A `.output/` prefix here names a path that never exists in the package and
  // the function silently fails to boot.
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  const create = calls.find((c) => c[0] === "createFunction");
  const runtimeCfg = create[1].body.customRuntimeConfig;
  assert.deepEqual(runtimeCfg.command, ["node"]);
  assert.deepEqual(runtimeCfg.args, ["server/index.mjs"]);
  assert.equal(runtimeCfg.port, 9000);
});

test("ensureFunction re-sends environmentVariables on the update path", async () => {
  // A redeploy rotates the app's DB password, so the env must be rewritten
  // alongside the code rather than assumed to survive.
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  await ops.ensureFunction("tc-app-1", {
    ossObjectName: "apps/1/code.zip",
    env: { PORT: "9000", DATABASE_URL: "postgres://app_x:new-pw@h/teamclaw_apps" },
  });
  const upd = calls.find((c) => c[0] === "updateFunction");
  assert.ok(upd, "updateFunction was called");
  assert.equal(upd[2].body.environmentVariables.DATABASE_URL, "postgres://app_x:new-pw@h/teamclaw_apps");
});

test("accountIdFromRoleArn reads the account out of a RAM role ARN", () => {
  assert.equal(accountIdFromRoleArn("acs:ram::1234567890123456:role/teamclaw-oss"), "1234567890123456");
  assert.equal(accountIdFromRoleArn("  acs:ram::123456789:role/x  "), "123456789");
  assert.equal(accountIdFromRoleArn("acs:ram::notanumber:role/x"), null);
  assert.equal(accountIdFromRoleArn("garbage"), null);
  assert.equal(accountIdFromRoleArn(undefined), null);
});

test("fcEndpoint resolves explicit host, then account id, then ROLE_ARN", () => {
  const prev = {
    endpoint: process.env.FC_ENDPOINT,
    account: process.env.ALIYUN_ACCOUNT_ID,
    role: process.env.ROLE_ARN,
  };
  delete process.env.FC_ENDPOINT;
  delete process.env.ALIYUN_ACCOUNT_ID;
  delete process.env.ROLE_ARN;
  try {
    // Previously composed the literal host "undefined.<region>.fc.aliyuncs.com".
    assert.throws(() => fcEndpoint(), /FC_ENDPOINT, ALIYUN_ACCOUNT_ID, or a ROLE_ARN/);

    // Any deployment that can reach OSS already has ROLE_ARN, so app deploys
    // need no new configuration.
    process.env.ROLE_ARN = "acs:ram::1234567890123456:role/teamclaw-oss";
    assert.match(fcEndpoint(), /^1234567890123456\..*\.fc\.aliyuncs\.com$/);

    process.env.ALIYUN_ACCOUNT_ID = "999";
    assert.match(fcEndpoint(), /^999\./, "explicit account id beats the ARN");

    process.env.FC_ENDPOINT = "https://explicit.example";
    assert.equal(fcEndpoint(), "https://explicit.example", "explicit host wins outright");
  } finally {
    for (const [k, v] of [["FC_ENDPOINT", prev.endpoint], ["ALIYUN_ACCOUNT_ID", prev.account], ["ROLE_ARN", prev.role]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("ensureHttpTrigger returns the public invoke URL", async () => {
  const { client } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.equal(url, "https://fn.example.fcapp.run");
});

test("ensureHttpTrigger swallows 'trigger already exists' then reads the URL", async () => {
  const conflict = Object.assign(new Error("exists"), { statusCode: 409, code: "TriggerAlreadyExists" });
  const { client } = fakeClient({ createTrigger: async () => { throw conflict; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.equal(url, "https://fn.example.fcapp.run");
});
