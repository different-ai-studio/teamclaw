// ---------------------------------------------------------------------------
// LiteLLM proxy client.
//
// Extracted from admin-handlers.ts. Thin fetch wrapper around the LiteLLM
// admin API (/team/*, /key/*) plus the env-derived endpoint, master key, and
// default per-team budget used when provisioning teams.
// ---------------------------------------------------------------------------

export const LITELLM_URL = () => process.env.LITELLM_URL || "https://ai.ucar.cc";
export const LITELLM_MASTER_KEY = () => process.env.LITELLM_MASTER_KEY || "";

/** Default team max spend (USD) applied on /team/new during provisioning. */
export const LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD = () => {
  const raw = process.env.LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
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
