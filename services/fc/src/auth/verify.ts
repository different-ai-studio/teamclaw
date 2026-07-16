import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { resolveBackendKind } from "../lib/backend-kind.js";
import { authBaseURL } from "./base-url.js";

const defaultBaseURL = () => authBaseURL();
let _remote: ReturnType<typeof createRemoteJWKSet> | null = null;
function remoteJwks(baseURL: string) {
  if (!_remote) _remote = createRemoteJWKSet(new URL(`${baseURL}/api/auth/jwks`));
  return _remote;
}

let _postgresKeyset: JWTVerifyGetKey | null = null;
async function postgresJwks(): Promise<JWTVerifyGetKey> {
  if (!_postgresKeyset) {
    const { getAuth } = await import("./better-auth.js");
    const jwks = (await getAuth().api.getJwks()) as JSONWebKeySet;
    _postgresKeyset = createLocalJWKSet(jwks);
  }
  return _postgresKeyset;
}

async function resolveKeyset(
  opts: { keyset?: JWTVerifyGetKey; baseURL?: string },
): Promise<JWTVerifyGetKey> {
  if (opts.keyset) return opts.keyset;
  if (resolveBackendKind() === "postgres") return postgresJwks();
  return remoteJwks(opts.baseURL ?? defaultBaseURL());
}

export type VerifiedClaims = { sub: string; [k: string]: unknown };

// Verify a Better-Auth-issued JWT and return claims (sub = user id).
// `opts.keyset` lets tests inject a local JWKS; postgres uses in-process JWKS;
// supabase/production FC uses the remote JWKS at AUTH_BASE_URL.
export async function verifyAccessToken(
  token: string,
  opts: { keyset?: JWTVerifyGetKey; baseURL?: string } = {},
): Promise<VerifiedClaims> {
  const baseURL = opts.baseURL ?? defaultBaseURL();
  const keyset = await resolveKeyset(opts);
  const { payload } = await jwtVerify(token, keyset, { issuer: baseURL, audience: baseURL });
  if (!payload.sub) throw new Error("jwt_missing_sub");
  return payload as VerifiedClaims;
}
