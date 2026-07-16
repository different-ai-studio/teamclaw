// ---------------------------------------------------------------------------
// LiteLLM proxy client.
//
// Extracted from admin-handlers.ts. Thin fetch wrapper around the LiteLLM
// admin API (/team/*, /key/*) plus the env-derived endpoint, master key, and
// default per-team budget used when provisioning teams.
// ---------------------------------------------------------------------------

// Fail closed. This used to fall back to a hosted gateway, which meant a blank
// LITELLM_URL silently routed a deployment's AI traffic to a third-party host
// it never opted into. There is no default worth guessing here: self-host
// supplies http://litellm:4000 via docker-compose, and anything else is an
// explicit operator choice. Only reached once LITELLM_MASTER_KEY is set, so
// throwing cannot break deployments that run without LiteLLM at all.
export const LITELLM_URL = () => {
  const url = process.env.LITELLM_URL?.trim();
  if (!url) {
    throw new Error(
      "LITELLM_URL is not set. Refusing to guess an AI gateway endpoint — set it explicitly (self-host: http://litellm:4000).",
    );
  }
  return url;
};
export const LITELLM_MASTER_KEY = () => process.env.LITELLM_MASTER_KEY || "";

/**
 * Default team max spend (USD) applied on /team/new during provisioning.
 * `null` means no cap — LiteLLM treats a null max_budget as unlimited.
 *
 * Unset means unlimited, deliberately. This used to default to 1, which capped
 * every team at a dollar of spend; self-host could not even override it, since
 * the compose fc environment map never passed the var through. Spend control
 * belongs at the upstream provider key, not in a default nobody chose.
 */
export const LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD = (): number | null => {
  const raw = process.env.LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    // Don't silently apply a cap the operator did not write. Warn and treat it
    // as unset, matching what an absent var does.
    console.warn(
      `[litellm] LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD=${JSON.stringify(raw)} is not a non-negative number; provisioning teams with no budget cap.`,
    );
    return null;
  }
  return n;
};

export async function litellmFetch(path: string, method: string, body?: unknown) {
  const url = `${LITELLM_URL()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER_KEY()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

/** GET /key/info for a specific virtual key. 404 => key absent. */
export async function keyInfo(key: string) {
  return litellmFetch(`/key/info?key=${encodeURIComponent(key)}`, "GET");
}
