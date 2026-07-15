import { getAuth, type Auth } from "./better-auth.js";
import { toEpochSeconds } from "./reshape.js";

// Mint a session + access(JWT)/refresh for an EXISTING user id. This is the
// primitive Plan 5's claimInvite (and daemon-agent provisioning) needs: it
// creates a Better-Auth session for `userId` without going through a
// credential flow.
//
// VERIFIED Better-Auth path (1.6.12):
//   1. ctx.internalAdapter.createSession(userId) -> { token (sessionToken), expiresAt, ... }
//   2. auth.api.getToken({ headers: { authorization: "Bearer <sessionToken>" } })
//      -> { token: <JWT> }  (the jwt plugin signs a short-lived JWT; sub = userId)
//
// The session token is the long-lived refresh credential; the JWT is the
// short-lived (15m default) access_token. expiresAt below is the SESSION
// (refresh) expiry in epoch seconds.
export async function mintSession(
  userId: string,
  auth: Auth = getAuth(),
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await (auth as any).$context;
  const sess = await ctx.internalAdapter.createSession(userId);
  if (!sess?.token) throw new Error("mint_session_failed:no_session_token");

  const headers = new Headers();
  headers.set("authorization", `Bearer ${sess.token}`);
  const jwt = await auth.api.getToken({ headers });
  if (!jwt?.token) throw new Error("mint_session_failed:no_jwt");

  const expiresAt = toEpochSeconds(sess.expiresAt);
  if (expiresAt == null) throw new Error("mint_session_failed:no_expiry");

  return { accessToken: jwt.token, refreshToken: sess.token, expiresAt };
}
