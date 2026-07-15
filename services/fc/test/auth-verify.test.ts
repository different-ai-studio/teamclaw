import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { verifyAccessToken } from "../src/auth/verify.js";

const BASE = "https://cloud.ucar.cc";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid"; jwk.alg = "ES256";
  const keyset = createLocalJWKSet({ keys: [jwk] });
  async function sign(claims: Record<string, unknown>, opts: { sub?: string; exp?: string } = {}) {
    const b = new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "test-kid" }).setIssuer(BASE).setAudience(BASE).setIssuedAt().setExpirationTime(opts.exp ?? "1h");
    if (opts.sub !== undefined) b.setSubject(opts.sub);
    return b.sign(privateKey);
  }
  return { keyset, sign };
}

test("valid token returns claims with sub", async () => {
  const { keyset, sign } = await setup();
  const token = await sign({ email: "u@e.com" }, { sub: "user-123" });
  const claims = await verifyAccessToken(token, { keyset, baseURL: BASE });
  assert.equal(claims.sub, "user-123");
  assert.equal(claims.email, "u@e.com");
});

test("token without sub throws", async () => {
  const { keyset, sign } = await setup();
  const token = await sign({ email: "x@e.com" }); // no sub
  await assert.rejects(() => verifyAccessToken(token, { keyset, baseURL: BASE }), /sub/i);
});

test("bad signature throws", async () => {
  const { keyset } = await setup();
  const { sign: signOther } = await setup(); // different keypair
  const token = await signOther({}, { sub: "u" });
  await assert.rejects(() => verifyAccessToken(token, { keyset, baseURL: BASE }));
});
