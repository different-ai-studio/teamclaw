import { describe, expect, it } from "vitest";

import {
  OAUTH_REDIRECT_URL,
  parseOAuthCallbackUrl,
  shouldCompleteOAuthResult,
} from "../features/onboarding/onboarding-oauth";

describe("onboarding oauth helpers", () => {
  it("pins the redirect to the URL GoTrue actually allows", () => {
    // Server-side `GOTRUE_URI_ALLOW_LIST` contains exactly
    // `teamclaw://auth-callback`, and iOS sends the same string. This app used
    // to send `teamclaw://auth/callback` (a slash, from
    // `Linking.createURL("auth/callback")`), which GoTrue rejected — it then
    // redirected to SITE_URL instead, so the browser never returned to the app
    // and every Google/Apple sign-in died silently with no error anywhere.
    //
    // Changing this string requires changing the server allow list too.
    expect(OAUTH_REDIRECT_URL).toBe("teamclaw://auth-callback");
  });

  it("parses a callback landing on the pinned redirect", () => {
    expect(parseOAuthCallbackUrl(`${OAUTH_REDIRECT_URL}?code=abc123`)).toEqual({
      type: "code",
      code: "abc123",
    });
  });

  it("extracts an auth code from the OAuth callback query", () => {
    expect(parseOAuthCallbackUrl("teamclaw://auth-callback?code=abc123")).toEqual({
      type: "code",
      code: "abc123",
    });
  });

  it("extracts implicit access and refresh tokens from the callback fragment", () => {
    expect(
      parseOAuthCallbackUrl(
        "teamclaw://auth-callback#access_token=access&refresh_token=refresh",
      ),
    ).toEqual({
      type: "tokens",
      accessToken: "access",
      refreshToken: "refresh",
    });
  });

  it("turns OAuth error callbacks into readable errors", () => {
    expect(() =>
      parseOAuthCallbackUrl(
        "teamclaw://auth-callback?error=access_denied&error_description=Nope",
      ),
    ).toThrow("Nope");
  });

  it("only completes successful browser auth sessions with a callback url", () => {
    expect(
      shouldCompleteOAuthResult({
        type: "success",
        url: "teamclaw://auth-callback",
      }),
    ).toBe(true);
    expect(shouldCompleteOAuthResult({ type: "cancel" })).toBe(false);
    expect(shouldCompleteOAuthResult({ type: "success" })).toBe(false);
  });
});
