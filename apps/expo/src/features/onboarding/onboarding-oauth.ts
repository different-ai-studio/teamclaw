export type OAuthProvider = "apple" | "google";

export type OAuthCallback =
  | { type: "code"; code: string }
  | { type: "tokens"; accessToken: string; refreshToken: string };

export type OAuthBrowserResult = {
  type: string;
  url?: string;
};

export function parseOAuthCallbackUrl(url: string): OAuthCallback {
  const parsed = new URL(url);
  const query = new URLSearchParams(parsed.search);
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const params = mergeParams(query, fragment);

  const errorDescription = params.get("error_description");
  const error = params.get("error");
  if (errorDescription || error) {
    throw new Error(errorDescription || error || "OAuth sign-in failed");
  }

  const code = params.get("code")?.trim();
  if (code) return { type: "code", code };

  const accessToken = params.get("access_token")?.trim();
  const refreshToken = params.get("refresh_token")?.trim();
  if (accessToken && refreshToken) {
    return { type: "tokens", accessToken, refreshToken };
  }

  throw new Error("OAuth callback did not include a session");
}

export function shouldCompleteOAuthResult(result: OAuthBrowserResult): boolean {
  return result.type === "success" && typeof result.url === "string" && result.url.length > 0;
}

function mergeParams(...sources: URLSearchParams[]): URLSearchParams {
  const merged = new URLSearchParams();
  for (const source of sources) {
    for (const [key, value] of source.entries()) {
      merged.set(key, value);
    }
  }
  return merged;
}
