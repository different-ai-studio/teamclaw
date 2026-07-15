// ---------------------------------------------------------------------------
// Alibaba CodeUp (Managed Git) client.
//
// Extracted from admin-handlers.ts. Thin fetch wrapper around the CodeUp
// OpenAPI used to create managed team repositories, plus the env-derived org
// id, personal access token, and bot username.
// ---------------------------------------------------------------------------

export const CODEUP_ORG_ID = () => process.env.CODEUP_ORG_ID || "";
export const CODEUP_PAT = () => process.env.CODEUP_PAT || "";
export const CODEUP_BOT_USERNAME = () => process.env.CODEUP_BOT_USERNAME || "teamclaw";
export const CODEUP_API_BASE = "https://openapi-rdc.aliyuncs.com";

/**
 * The shared managed-git credential (the org bot PAT). Returns null when
 * managed-git is not configured. NOT per-repo — one credential for all of an
 * org's managed repos (team repo + every app repo).
 */
export function managedGitCredential(): { username: string; token: string } | null {
  const token = CODEUP_PAT();
  if (!token) return null;
  return { username: CODEUP_BOT_USERNAME(), token };
}

export async function codeupFetch(path: string, method: string, body?: unknown) {
  const url = `${CODEUP_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "x-yunxiao-token": CODEUP_PAT(),
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
