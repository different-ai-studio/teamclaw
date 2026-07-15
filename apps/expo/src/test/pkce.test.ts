import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { codeChallengeFromVerifier, generateCodeVerifier } from "../lib/auth/pkce";

function nodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("pkce", () => {
  it("matches Node's SHA-256 base64url for the FIPS 'abc' vector", () => {
    expect(codeChallengeFromVerifier("abc")).toBe(nodeChallenge("abc"));
  });

  it("matches Node's SHA-256 for the empty string and a long input", () => {
    expect(codeChallengeFromVerifier("")).toBe(nodeChallenge(""));
    const long = "a".repeat(1000);
    expect(codeChallengeFromVerifier(long)).toBe(nodeChallenge(long));
  });

  it("produces a valid-length, url-safe challenge for generated verifiers", () => {
    for (let i = 0; i < 20; i += 1) {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[a-f0-9]+$/);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      const challenge = codeChallengeFromVerifier(verifier);
      expect(challenge).toBe(nodeChallenge(verifier));
      expect(challenge).not.toMatch(/[+/=]/);
    }
  });
});
