import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a caller-supplied shared secret against the configured
 * one, for the webhook/trigger endpoints that authenticate with a bearer-ish
 * header rather than a user JWT.
 *
 * Fails closed on an unset secret. That matters more than it looks: with a
 * plain `provided !== secret` comparison an unconfigured deployment holds
 * `secret === ""`, so omitting the header is rejected (`undefined !== ""`) but
 * sending an EMPTY header is accepted (`"" === ""`) — the endpoint reads as
 * guarded while being wide open. An endpoint with no secret configured has
 * nothing to authenticate against, so no request can be authorized.
 *
 * `provided` is compared length-first because timingSafeEqual throws on a
 * length mismatch; the length itself is not secret.
 */
export function sharedSecretMatches(
  provided: string | undefined | null,
  secret: string | undefined | null,
): boolean {
  if (!secret) return false;
  if (!provided) return false;
  if (provided.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}
