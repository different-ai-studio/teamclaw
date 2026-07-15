import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFcOps } from "../../src/lib/provisioning/fc-client.js";

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

test("updateFunctionCodeOnly updates code without environmentVariables", async () => {
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  await ops.updateFunctionCodeOnly("fn", "apps/1/code.zip");
  const upd = calls.find((c) => c[0] === "updateFunction");
  assert.ok(upd, "updateFunction was called");
  const body = upd[2].body;
  assert.equal(body.code.ossObjectName, "apps/1/code.zip");
  assert.ok(!("environmentVariables" in body) || body.environmentVariables === undefined,
    "no environmentVariables set");
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
