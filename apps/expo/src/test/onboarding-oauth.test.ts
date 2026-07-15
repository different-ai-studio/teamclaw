import { describe, expect, it } from "vitest";

import {
  parseOAuthCallbackUrl,
  shouldCompleteOAuthResult,
} from "../features/onboarding/onboarding-oauth";

describe("onboarding oauth helpers", () => {
  it("extracts an auth code from the OAuth callback query", () => {
    expect(parseOAuthCallbackUrl("teamclaw://auth/callback?code=abc123")).toEqual({
      type: "code",
      code: "abc123",
    });
  });

  it("extracts implicit access and refresh tokens from the callback fragment", () => {
    expect(
      parseOAuthCallbackUrl(
        "teamclaw://auth/callback#access_token=access&refresh_token=refresh",
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
        "teamclaw://auth/callback?error=access_denied&error_description=Nope",
      ),
    ).toThrow("Nope");
  });

  it("only completes successful browser auth sessions with a callback url", () => {
    expect(
      shouldCompleteOAuthResult({
        type: "success",
        url: "teamclaw://auth/callback",
      }),
    ).toBe(true);
    expect(shouldCompleteOAuthResult({ type: "cancel" })).toBe(false);
    expect(shouldCompleteOAuthResult({ type: "success" })).toBe(false);
  });
});
