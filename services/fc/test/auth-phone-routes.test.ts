import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";

// Fake auth repo recording calls — tests the route layer (wiring + guards),
// not the phone-auth logic (covered by phone-auth.test.ts).
function deps(repo: any) {
  return {
    createRepository: () => { throw new Error("business repo not expected"); },
    createAuthRepository: () => repo,
  };
}

function req(path: string, body: any) {
  return { httpMethod: "POST", path, headers: {}, body: JSON.stringify(body) };
}

test("POST /v1/auth/phone/send-code calls phoneSendCode", async () => {
  const calls: any[] = [];
  const repo = { phoneSendCode: async (a: any) => { calls.push(a); return { success: true }; } };
  const res = await handleBusinessApiRequest(req("/v1/auth/phone/send-code", { phone: "13700000000", captchaVerify: "tok" }), deps(repo));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).success, true);
  assert.deepEqual(calls[0], { phone: "13700000000", captchaVerify: "tok" });
});

test("POST /v1/auth/phone/send-code requires phone", async () => {
  const res = await handleBusinessApiRequest(req("/v1/auth/phone/send-code", {}), deps({}));
  assert.equal(res.statusCode, 400);
});

test("POST /v1/auth/phone/login calls phoneLogin with user_id", async () => {
  const calls: any[] = [];
  const repo = { phoneLogin: async (a: any) => { calls.push(a); return { session: { access_token: "at" } }; } };
  const res = await handleBusinessApiRequest(req("/v1/auth/phone/login", { phone: "13700000000", code: "123456", user_id: "u1" }), deps(repo));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], { phone: "13700000000", code: "123456", userId: "u1" });
});

test("POST /v1/auth/phone/login accepts camelCase userId (account picker selection)", async () => {
  // The desktop client (auth-client loginWithPhoneUser) sends `userId`, not
  // `user_id`. Dropping it makes phoneLogin re-return multiUser (no session).
  const calls: any[] = [];
  const repo = { phoneLogin: async (a: any) => { calls.push(a); return { session: { access_token: "at" } }; } };
  const res = await handleBusinessApiRequest(req("/v1/auth/phone/login", { phone: "13700000000", code: "123456", userId: "u1" }), deps(repo));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], { phone: "13700000000", code: "123456", userId: "u1" });
});

test("POST /v1/auth/phone/login requires phone + code", async () => {
  const r1 = await handleBusinessApiRequest(req("/v1/auth/phone/login", { phone: "13700000000" }), deps({}));
  assert.equal(r1.statusCode, 400);
});

test("signin-otp rejects phone-only with a redirect-to-phone-endpoints message", async () => {
  let called = false;
  const repo = { signInOtp: async () => { called = true; return {}; } };
  const res = await handleBusinessApiRequest(req("/v1/auth/signin-otp", { phone: "13700000000" }), deps(repo));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error.message, /phone\/send-code/);
  assert.equal(called, false);
});

test("signin-otp still serves email OTP", async () => {
  const calls: any[] = [];
  const repo = { signInOtp: async (a: any) => { calls.push(a); return { ok: true }; } };
  const res = await handleBusinessApiRequest(req("/v1/auth/signin-otp", { email: "a@b.com" }), deps(repo));
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].email, "a@b.com");
});
