import {
  cloudApiBaseUrl,
  createCloudApiClient,
  supabaseAccessToken,
} from "../../lib/cloud-api/client";

export type InviteClaimResult = {
  actorId: string;
  teamId: string;
  actorType: string;
  displayName: string;
  refreshToken: string | null;
};

export type InviteApi = {
  claim: (token: string) => Promise<InviteClaimResult>;
};

/**
 * Cloud-only invite claimer. Redeems a token via `POST /v1/invites/claim`,
 * which proxies the Postgres `claim_team_invite` RPC server-side and returns
 * the camelCase ClaimResult `{ actorId, teamId, actorType, displayName,
 * refreshToken }`. Mirrors iOS `CloudAPIInviteClaimer`.
 */
export function createInviteApi(args: {
  getAccessToken: () => Promise<string | null>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): InviteApi {
  const client = createCloudApiClient({
    baseUrl: args.baseUrl ?? cloudApiBaseUrl(),
    getAccessToken: args.getAccessToken,
    fetchImpl: args.fetchImpl,
  });

  return {
    async claim(token) {
      const trimmed = token.trim();
      if (!trimmed) {
        throw new Error("Invite token is empty.");
      }
      const result = await client.post<InviteClaimResult>("/v1/invites/claim", {
        token: trimmed,
      });
      if (!result?.actorId || !result?.teamId) {
        throw new Error("Invite claim returned no actor/team — token may be expired.");
      }
      return {
        actorId: result.actorId,
        teamId: result.teamId,
        actorType: result.actorType ?? "member",
        displayName: result.displayName ?? "",
        refreshToken: result.refreshToken ?? null,
      };
    },
  };
}

/**
 * Production wiring helper. Bridges the transitional Supabase access token into
 * the cloud-only claimer until the auth layer itself moves off the SDK.
 */
export function createConfiguredInviteApi(
  client: Parameters<typeof supabaseAccessToken>[0],
): InviteApi {
  return createInviteApi({ getAccessToken: supabaseAccessToken(client) });
}

/**
 * Pulls the invite token out of a `teamclaw://invite/...` or
 * `teamclaw://invite?token=...` deep link. Returns null when the URL is for
 * something other than invites or has no parseable token.
 *
 * Tolerates the two shapes the iOS app emits (path token + query token) so
 * shared links continue to work across platforms.
 */
export function parseInviteToken(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // RN's URL parser puts the scheme in `protocol` with the trailing colon,
  // e.g. "teamclaw:". The host is what comes right after `//`.
  const isInvite =
    (parsed.protocol === "teamclaw:" && parsed.host === "invite") ||
    parsed.pathname.startsWith("/invite");
  if (!isInvite) return null;

  const queryToken = parsed.searchParams.get("token");
  if (queryToken && queryToken.length > 0) return queryToken;

  // Path forms: "teamclaw://invite/<token>" → host="invite", pathname="/<token>"
  // or "/invite/<token>" → pathname="/invite/<token>".
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "invite" && segments[1]) return segments[1];
  if (segments[0]) return segments[0];
  return null;
}
