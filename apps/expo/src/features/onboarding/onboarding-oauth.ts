export type OAuthProvider = "apple" | "google";

/**
 * Where GoTrue sends the browser back after an external provider signs the user
 * in. Must appear **verbatim** in `GOTRUE_URI_ALLOW_LIST`; anything else is
 * rejected and the browser falls back to `SITE_URL`, so the app never sees a
 * callback and the sign-in silently dies.
 *
 * Deliberately a literal rather than `Linking.createURL("auth-callback")`:
 * `createURL` varies by runtime (`exp://…/--/…` under Expo Go) and has shipped
 * both `scheme://path` and `scheme:///path` forms, neither of which the allow
 * list would match. The app bundles a custom native module
 * (`plugins/withTeamClawMqtt`) so it never runs under Expo Go anyway — the
 * scheme is always `teamclaw`.
 *
 * Keep in sync with iOS `CloudAPIAppOnboardingStore.oauthAuthorizeURL`, which
 * uses this same string.
 */
export const OAUTH_REDIRECT_URL = "teamclaw://auth-callback";

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
