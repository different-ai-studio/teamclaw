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
 * (`plugins/withTeamCluMqtt`) so it never runs under Expo Go anyway — the
 * scheme is always `teamclu`.
 *
 * Keep in sync with iOS `CloudAPIAppOnboardingStore.oauthAuthorizeURL`, which
 * uses this same string.
 */
export const OAUTH_REDIRECT_URL = "teamclu://auth-callback";

/**
 * True for the URL GoTrue redirects to once a provider has signed the user in.
 *
 * That redirect is a real Android deep link, so the OS delivers it to the app
 * as an intent — `Linking` sees it whether or not `openAuthSessionAsync`
 * resolves with it. Completing the sign-in therefore has to be driven from the
 * URL itself; see `completeOAuthFromUrl`.
 *
 * Tolerates the double- and triple-slash spellings because `Linking.createURL`
 * has emitted both, and a trailing slash because some browsers add one.
 */
export function isOAuthCallbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const withoutParams = url.split(/[?#]/)[0] ?? "";
  return /^teamclu:\/{2,3}auth-callback\/?$/i.test(withoutParams);
}

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
