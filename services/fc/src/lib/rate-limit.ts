// ---------------------------------------------------------------------------
// Rate limiting — in-memory, per IP, 10 req/min
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimitMap = new Map<string, number[]>();

// Resolve the client IP for rate-limit keying. On Alibaba FC custom-runtime
// web functions the gateway does NOT inject X-Forwarded-For (verified on the
// live function 2026-07-14): a plain client arrives with no IP header at all,
// which used to collapse every caller into one shared "unknown" bucket.
// Preference order: x-fc-client-ip (FC system header) > first X-Forwarded-For
// hop > x-real-ip. All are client-forgeable in this topology, so this is
// best-effort abuse damping, not a security boundary.
export function resolveClientIp(
  get: (name: string) => string | undefined,
): { ip: string | null; source: string } {
  const fcIp = get("x-fc-client-ip")?.trim();
  if (fcIp) return { ip: fcIp, source: "x-fc-client-ip" };
  const fwd = get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return { ip: fwd, source: "x-forwarded-for" };
  const real = get("x-real-ip")?.trim();
  if (real) return { ip: real, source: "x-real-ip" };
  return { ip: null, source: "none" };
}

export function isRateLimited(ip: string, max: number = RATE_LIMIT_MAX): boolean {
  const now = Date.now();
  let timestamps = rateLimitMap.get(ip);
  if (!timestamps) {
    timestamps = [];
    rateLimitMap.set(ip, timestamps);
  }
  // Prune old entries
  while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= max) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// Periodically clean up stale IPs to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length === 0) rateLimitMap.delete(ip);
  }
}, 60_000).unref?.();
