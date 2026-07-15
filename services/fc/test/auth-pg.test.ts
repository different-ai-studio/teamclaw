import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt, createLocalJWKSet, type JSONWebKeySet } from "jose";
import { buildAuth } from "../src/auth/better-auth.js";
import { createPgAuthRepository } from "../src/lib/pg-repo/auth.js";
import { mintSession } from "../src/auth/mint-session.js";
import { toGoTrueSession } from "../src/auth/reshape.js";
import { verifyAccessToken } from "../src/auth/verify.js";
import { makeTestDb } from "./db/pglite.js";

const BASE = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret-xx";

async function setup() {
  const { db } = await makeTestDb();
  const auth = buildAuth({ db, secret: SECRET, baseURL: BASE });
  // The jwt plugin exposes the JWKS via the api; build a local keyset so
  // verifyAccessToken can verify without a running HTTP server.
  const jwks = (await auth.api.getJwks()) as unknown as JSONWebKeySet;
  const keyset = createLocalJWKSet(jwks);
  // The repo's JWT-resolving methods (signOut/updateUser/idToken-link) verify
  // the access_token; inject the local keyset + baseURL so they work offline.
  const repo = createPgAuthRepository({ auth, verifyOpts: { keyset, baseURL: BASE } });
  return { auth, repo, keyset };
}

test("signInAnonymous returns a GoTrue envelope with is_anonymous:true", async () => {
  const { repo } = await setup();
  const env = await repo.signInAnonymous();
  assert.ok(env.access_token, "access_token present");
  assert.ok(env.refresh_token, "refresh_token present (session token)");
  assert.equal(env.token_type, "bearer");
  assert.ok(Number.isInteger(env.expires_at), "expires_at epoch seconds");
  assert.ok(env.user.id, "user.id present");
  assert.equal(env.user.is_anonymous, true);
});

test("signUp + signInWithPassword return GoTrue envelopes carrying the email", async () => {
  const { repo } = await setup();
  const email = "user@example.com";
  const password = "password12345";

  const signedUp = await repo.signUp({ email, password });
  assert.ok(signedUp.access_token);
  assert.equal(signedUp.user.email, email);
  assert.equal(signedUp.user.is_anonymous, false);

  const signedIn = await repo.signInWithPassword({ email, password });
  assert.ok(signedIn.access_token);
  assert.equal(signedIn.user.email, email);
  assert.ok(signedIn.refresh_token, "refresh_token present");
});

test("refreshAccessToken returns camelCase { accessToken, refreshToken, expiresAt:int }", async () => {
  const { repo } = await setup();
  const email = "refresh@example.com";
  const password = "password12345";
  await repo.signUp({ email, password });
  const session = await repo.signInWithPassword({ email, password });

  const refreshed = await repo.refreshAccessToken({ refreshToken: session.refresh_token! });
  assert.ok(refreshed.accessToken, "accessToken present");
  assert.equal(refreshed.refreshToken, session.refresh_token, "refresh token unchanged (no rotation)");
  assert.ok(Number.isInteger(refreshed.expiresAt), "expiresAt integer epoch seconds");
});

test("issued access_token JWT: sub == user id, iss/aud == baseURL, verifyAccessToken agrees", async () => {
  const { repo, keyset } = await setup();
  const env = await repo.signInAnonymous();

  const decoded = decodeJwt(env.access_token);
  assert.equal(decoded.sub, env.user.id, "JWT sub == user id");
  assert.equal(decoded.iss, BASE, "JWT iss == baseURL");
  assert.equal(decoded.aud, BASE, "JWT aud == baseURL");

  // This confirms verify.ts (Task 3) and Better-Auth's minted JWT agree on
  // issuer/audience. verify.ts uses { issuer: baseURL, audience: baseURL } and
  // Better-Auth mints iss=aud=baseURL — so no adjustment to verify.ts needed.
  const claims = await verifyAccessToken(env.access_token, { keyset, baseURL: BASE });
  assert.equal(claims.sub, env.user.id, "verifyAccessToken returns sub == user id");
});

test("email OTP full round trip through the repository -> GoTrue envelope", async () => {
  // Build a dedicated instance whose emailOTP hook captures the code, so we can
  // exercise the real send -> verify flow end to end (no external provider).
  const { db } = await makeTestDb();
  let captured: { otp: string } | null = null;
  // Reuse buildAuth's plugin set but with a capturing OTP delivery: construct
  // via the repository pointed at an instance built with the capturing hook.
  // buildAuth wires sendOtpEmail (a no-op in tests), so instead we drive the
  // api directly to capture, then verify through the repo.
  const { betterAuth } = await import("better-auth");
  const { jwt, bearer, anonymous, emailOTP, genericOAuth } = await import("better-auth/plugins");
  const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
  const schema = await import("../src/db/schema/index.js");
  const auth = betterAuth({
    baseURL: BASE,
    secret: SECRET,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    database: drizzleAdapter(db as any, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt(),
      bearer(),
      anonymous(),
      emailOTP({ sendVerificationOTP: async ({ otp }) => { captured = { otp }; } }),
      genericOAuth({ config: [] }),
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = createPgAuthRepository({ auth: auth as any });

  const email = "otp@example.com";
  const ack = await repo.signInOtp({ email });
  assert.deepEqual(ack, {}, "signInOtp acks with {} after sending");
  assert.ok(captured, "OTP captured by delivery hook");

  const env = await repo.verifyOtp({ email, token: captured!.otp, type: "email" });
  assert.ok(env.access_token, "OTP verify yields access_token");
  assert.equal(env.user.email, email);
  assert.equal(env.token_type, "bearer");
});

test("phone-only OTP fails loudly with 501 (no SMS provider under postgres)", async () => {
  const { repo } = await setup();

  // signInOtp: phone-only must reject rather than silently send to undefined email.
  await assert.rejects(
    () => repo.signInOtp({ phone: "+15555550123" }),
    (err: any) => err?.statusCode === 501 && err?.code === "phone_otp_unsupported",
    "signInOtp with phone-only rejects 501 phone_otp_unsupported",
  );

  // verifyOtp: same guard.
  await assert.rejects(
    () => repo.verifyOtp({ phone: "+15555550123", token: "000000", type: "sms" }),
    (err: any) => err?.statusCode === 501 && err?.code === "phone_otp_unsupported",
    "verifyOtp with phone-only rejects 501 phone_otp_unsupported",
  );
});

test("mintSession creates a session + JWT for an existing user id", async () => {
  const { auth, repo, keyset } = await setup();
  // Create a user via the repo, capture its id.
  const signed = await repo.signUp({ email: "mint@example.com", password: "password12345" });
  const userId = signed.user.id!;

  const minted = await mintSession(userId, auth);
  assert.ok(minted.accessToken, "minted accessToken");
  assert.ok(minted.refreshToken, "minted refreshToken (session token)");
  assert.ok(Number.isInteger(minted.expiresAt), "minted expiresAt integer");

  const decoded = decodeJwt(minted.accessToken);
  assert.equal(decoded.sub, userId, "minted JWT sub == user id");
  const claims = await verifyAccessToken(minted.accessToken, { keyset, baseURL: BASE });
  assert.equal(claims.sub, userId);
});

test("signOut(accessToken=JWT) actually invalidates the session (NOT a silent no-op)", async () => {
  const { repo } = await setup();
  // Establish a real user + session; access_token is the JWT, refresh_token is
  // the Better-Auth session token.
  const signedUp = await repo.signUp({ email: "signout@example.com", password: "password12345" });
  const jwt = signedUp.access_token;
  const sessionToken = signedUp.refresh_token!;

  // Sanity: the session token currently refreshes fine.
  const before = await repo.refreshAccessToken({ refreshToken: sessionToken });
  assert.ok(before.accessToken, "refresh works before signOut");

  // Sign out by forwarding the JWT (exactly what clients send as the bearer).
  const out = await repo.signOut({ accessToken: jwt });
  assert.deepEqual(out, { success: true }, "signOut returns success shape");

  // The session must now be invalidated: refreshing with the same session
  // (refresh) token must fail. If signOut were a silent no-op this would still
  // succeed (the bug).
  await assert.rejects(
    () => repo.refreshAccessToken({ refreshToken: sessionToken }),
    /invalid_refresh_token/,
    "session is actually revoked after signOut (not a no-op)",
  );
});

test("signOut with an invalid token is a no-op success (consistent best-effort semantics)", async () => {
  const { repo } = await setup();
  const out = await repo.signOut({ accessToken: "not.a.jwt" });
  assert.deepEqual(out, { success: true });
});

test("updateUser(accessToken=JWT) actually updates the user row server-side", async () => {
  const { auth, repo } = await setup();
  const signedUp = await repo.signUp({ email: "update@example.com", password: "password12345" });
  const jwt = signedUp.access_token;
  const userId = signedUp.user.id!;

  const updated = await repo.updateUser({ accessToken: jwt, body: { name: "Renamed Human" } });
  assert.equal(updated.id, userId, "updateUser returns the same user id");

  // Re-read the row directly via the internal adapter to prove persistence.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await (auth as any).$context;
  const row = await ctx.internalAdapter.findUserById(userId);
  assert.equal(row.name, "Renamed Human", "user row name updated server-side");
});

test("signInWithIdToken link path: resolves existing user from JWT and forwards a HMAC-valid SESSION token (not the JWT)", async () => {
  const { auth, repo, keyset } = await setup();
  // Create the existing (would-be anonymous) user; its access_token is a JWT.
  const existing = await repo.signInAnonymous();
  const jwt = existing.access_token;
  const existingUserId = existing.user.id!;

  // Wrap the real auth so signInSocial is intercepted: capture the bearer the
  // repo forwards, then assert it's a valid Better-Auth session token for the
  // SAME user (proving link-by-user-id, not JWT-as-bearer). We must verify the
  // bearer against the SAME auth instance (shared secret/keys).
  let capturedBearer: string | null = null;
  const linkRepo = createPgAuthRepository({
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(auth as any),
      get $context() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (auth as any).$context;
      },
      api: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(auth as any).api,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signInSocial: async ({ headers }: any) => {
          capturedBearer = headers?.get("authorization") ?? null;
          // Return a plausible Better-Auth sign-in result so envelopeFromSignIn
          // can reshape; reuse the existing user to mimic an in-place link.
          // We mint a fresh session for it via the real internal adapter.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = await (auth as any).$context;
          const sess = await ctx.internalAdapter.createSession(existingUserId);
          const user = await ctx.internalAdapter.findUserById(existingUserId);
          return { token: sess.token, user };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    verifyOpts: { keyset, baseURL: BASE },
  });

  const env = await linkRepo.signInWithIdToken({
    provider: "apple",
    idToken: "fake-id-token",
    accessToken: jwt,
  });

  assert.ok(capturedBearer, "a bearer was forwarded to signInSocial");
  const forwarded = capturedBearer!.replace(/^Bearer /i, "");
  assert.notEqual(forwarded, jwt, "the JWT is NOT forwarded as the bearer (bug #6 fix)");

  // The forwarded credential must be a real Better-Auth session token: it
  // resolves a session for the SAME existing user via getSession.
  const session = await auth.api.getSession({
    headers: (() => {
      const h = new Headers();
      h.set("authorization", `Bearer ${forwarded}`);
      return h;
    })(),
  });
  assert.ok(session?.session, "forwarded bearer is a HMAC-valid session token");
  assert.equal(session!.user.id, existingUserId, "session resolves the SAME (existing) user — link, not duplicate");

  // And the resulting envelope is for the same user id (no new/duplicate user).
  assert.equal(env.user.id, existingUserId, "envelope user id == existing user (no duplicate)");
});

test("toGoTrueSession reshape (unit) — covers id_token / PKCE paths deferred to deploy verification", () => {
  // id_token (Apple/Google) and PKCE exchange require real external providers,
  // so the FULL round trip is deferred to manual/deploy verification. We assert
  // the reshape contract here against a synthetic Better-Auth-shaped result.
  const env = toGoTrueSession({
    accessToken: "jwt.access.token",
    refreshToken: "session-token",
    expiresAt: 1893456000,
    user: { id: "u-1", email: "oauth@example.com", isAnonymous: false },
  });
  assert.equal(env.access_token, "jwt.access.token");
  assert.equal(env.refresh_token, "session-token");
  assert.equal(env.token_type, "bearer");
  assert.equal(env.expires_at, 1893456000);
  assert.equal(env.user.email, "oauth@example.com");
  assert.equal(env.user.is_anonymous, false);
});
