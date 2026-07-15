import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// CDN-fronted blob downloads (OSS egress cost reduction, phase 2).
//
// Blobs are immutable + content-addressed (key = .../sha256/<cipher_hash>) +
// encrypted, so they cache extremely well at a CDN edge. Fronting OSS with a CDN
// for GETs turns the (N-1)x fan-out egress into ~1x origin pull + cheaper CDN
// egress. Only GET is fronted; uploads (PUT) stay on OSS presigned URLs.
//
// When CDN_DOMAIN + CDN_AUTH_KEY are unset, callers fall back to OSS presigned
// GET (current behaviour) — so this is safe to deploy before the CDN exists.
// ---------------------------------------------------------------------------

export const CDN_DOMAIN = (): string | undefined => process.env.CDN_DOMAIN;
export const CDN_AUTH_KEY = (): string | undefined => process.env.CDN_AUTH_KEY;
export const CDN_SCHEME = (): string => process.env.CDN_SCHEME || "https";

/** CDN-fronted downloads are enabled only when both domain + auth key are set. */
export function cdnEnabled(): boolean {
  return Boolean(CDN_DOMAIN() && CDN_AUTH_KEY());
}

/**
 * Alibaba Cloud CDN "type A" signed URL for an OSS object key.
 *
 *   uri      = "/" + ossKey
 *   sstring  = "<uri>-<ts>-<rand>-<uid>-<privateKey>"
 *   auth_key = "<ts>-<rand>-<uid>-md5(sstring)"
 *   url      = "<scheme>://<domain><uri>?auth_key=<auth_key>"
 *
 * `ts` is the expiry (unix seconds). The signed URL only gates access /
 * anti-hotlink — the bytes are ciphertext, so a leaked URL is useless. The CDN
 * must be configured to exclude `auth_key` from the cache key so all members
 * share one cached object.
 */
export function signCdnUrl(
  ossKey: string,
  ttlSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const domain = CDN_DOMAIN();
  const key = CDN_AUTH_KEY();
  if (!domain || !key) {
    throw new Error("CDN not configured (CDN_DOMAIN / CDN_AUTH_KEY)");
  }
  // ossKey is URL-safe (hex, '/', uuid hyphens), so the same string is used for
  // both the md5 input and the URL path (no percent-encoding needed).
  const uri = "/" + ossKey.replace(/^\/+/, "");
  const ts = nowSec + ttlSec;
  const rand = "0";
  const uid = "0";
  const md5 = createHash("md5")
    .update(`${uri}-${ts}-${rand}-${uid}-${key}`)
    .digest("hex");
  const authKey = `${ts}-${rand}-${uid}-${md5}`;
  return `${CDN_SCHEME()}://${domain}${uri}?auth_key=${authKey}`;
}
