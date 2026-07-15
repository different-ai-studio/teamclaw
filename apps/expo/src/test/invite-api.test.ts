import { describe, expect, it, vi } from "vitest";

import { createInviteApi, parseInviteToken } from "../features/onboarding/invite-api";

describe("parseInviteToken", () => {
  it("returns null for nullish / empty inputs", () => {
    expect(parseInviteToken(null)).toBeNull();
    expect(parseInviteToken(undefined)).toBeNull();
    expect(parseInviteToken("   ")).toBeNull();
  });

  it("returns null for non-URL strings", () => {
    expect(parseInviteToken("not a url")).toBeNull();
  });

  it("returns null when the URL is for a different action", () => {
    expect(parseInviteToken("teamclaw://session/abc-123")).toBeNull();
  });

  it("extracts the token from the path form (teamclaw://invite/<token>)", () => {
    expect(parseInviteToken("teamclaw://invite/tok-abc")).toBe("tok-abc");
  });

  it("extracts the token from the query form (teamclaw://invite?token=<token>)", () => {
    expect(parseInviteToken("teamclaw://invite?token=tok-xyz")).toBe("tok-xyz");
  });

  it("prefers the query token when both are present", () => {
    expect(parseInviteToken("teamclaw://invite/path-tok?token=query-tok")).toBe(
      "query-tok",
    );
  });

  it("accepts /invite/<token> with no host (https universal link form)", () => {
    expect(parseInviteToken("https://app.teamclaw.tech/invite/tok-https")).toBe(
      "tok-https",
    );
  });
});

describe("createInviteApi.claim", () => {
  const baseUrl = "https://fc.example.com";
  const getAccessToken = async () => "access-token";

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as Response;
  }

  it("throws for an empty token without hitting the network", async () => {
    const fetchImpl = vi.fn();
    const api = createInviteApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });
    await expect(api.claim("  ")).rejects.toThrow(/empty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the token and returns the mapped ClaimResult on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        actorId: "actor-1",
        teamId: "team-1",
        actorType: "member",
        displayName: "Alice",
        refreshToken: "rt-1",
      }),
    );
    const api = createInviteApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });
    await expect(api.claim("tok")).resolves.toEqual({
      actorId: "actor-1",
      teamId: "team-1",
      actorType: "member",
      displayName: "Alice",
      refreshToken: "rt-1",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fc.example.com/v1/invites/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "tok" }),
      }),
    );
  });

  it("rejects when the endpoint surfaces an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: "token expired" } }, 404),
    );
    const api = createInviteApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });
    await expect(api.claim("tok")).rejects.toThrow(/token expired/);
  });

  it("rejects when the claim returns no actor/team", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ actorId: null, teamId: null }));
    const api = createInviteApi({ getAccessToken, baseUrl, fetchImpl: fetchImpl as never });
    await expect(api.claim("tok")).rejects.toThrow(/no actor/i);
  });
});
