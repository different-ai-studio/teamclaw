import type { CloudAuthClient } from "../auth/cloud-auth";
import type { BootstrapResult, TeamSummary } from "../../features/onboarding/onboarding-types";
import {
  parseOAuthCallbackUrl,
  type OAuthProvider,
} from "../../features/onboarding/onboarding-oauth";

/**
 * Cloud-only onboarding/auth API. Backed by the Cloud API auth facade
 * (`CloudAuthClient`): auth flows hit FC `/v1/auth/*`, business reads hit
 * `GET /v1/teams` and team activation. Mirrors iOS
 * `CloudAPIAppOnboardingStore`.
 *
 * The `client` parameter is the same `supabase` facade the rest of the app
 * imports — kept as an injected dependency so tests can substitute fakes.
 */

type CloudTeamPage = { items?: CloudTeam[] };
type CloudTeam = { id: string; name: string; slug?: string | null };
type MembershipTeam = CloudTeam & { role?: string | null; isMember?: boolean };
type TeamActivation = { actorId?: string | null; refreshToken: string };

export function createOnboardingApi(client: CloudAuthClient) {
  return {
    async getCurrentSession() {
      const { data } = await client.auth.getSession();
      return data.session ?? null;
    },

    async loadBootstrap(): Promise<BootstrapResult> {
      const session = await this.getCurrentSession();
      if (!session?.user?.id) {
        return { isAnonymous: false, team: null, memberActorId: null };
      }

      const dto = await client.api.get<CloudTeamPage>("/v1/teams");
      const isAnonymous = Boolean(session.user.is_anonymous);
      const firstTeam = (dto.items as MembershipTeam[] | undefined)?.find((team) => team.isMember !== false) ?? null;
      if (!firstTeam) {
        return { isAnonymous, team: null, memberActorId: null };
      }
      const activation = await client.api.post<TeamActivation>(
        `/v1/teams/${encodeURIComponent(firstTeam.id)}/activate`,
      );
      if (activation.refreshToken) {
        const result = await client.auth.setRefreshSession(activation.refreshToken);
        if (result.error) throw new Error(result.error.message);
      }
      return {
        isAnonymous,
        team: {
          id: firstTeam.id,
          name: firstTeam.name,
          slug: firstTeam.slug ?? "",
          role: firstTeam.role ?? "member",
        },
        memberActorId: activation.actorId ?? null,
      };
    },

    async signInAnonymously() {
      return client.auth.signInAnonymously();
    },

    async sendEmailOTP(email: string) {
      await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      return { pendingEmail: email };
    },

    async verifyOTP(email: string, token: string) {
      const { error } = await client.auth.verifyOtp({ email, token, type: "email" });
      if (error) throw new Error(error.message);
    },

    async createOAuthSignInUrl(provider: OAuthProvider, redirectTo: string) {
      return client.auth.oauthAuthorize(provider, redirectTo);
    },

    async createOAuthLinkUrl(provider: OAuthProvider, redirectTo: string) {
      // The FC OAuth authorize endpoint cannot link to the current user via a
      // browser redirect (no bearer forwarded), so linking behaves as
      // sign-in-with-provider through the same PKCE flow.
      return client.auth.oauthAuthorize(provider, redirectTo);
    },

    async completeOAuthCallback(callbackUrl: string) {
      const callback = parseOAuthCallbackUrl(callbackUrl);
      if (callback.type === "code") {
        return client.auth.exchangeOAuthCode(callback.code);
      }
      return client.auth.setSession({
        access_token: callback.accessToken,
        refresh_token: callback.refreshToken,
      });
    },

    async createTeam(name: string): Promise<TeamSummary> {
      const team = await client.api.post<CloudTeam>("/v1/teams", { name });
      if (!team?.id) {
        throw new Error("create team returned no team id");
      }
      // POST /v1/teams returns only the team row; membership is available from
      // the canonical team listing rather than a synthetic /me bootstrap.
      const dto = await client.api.get<CloudTeamPage>("/v1/teams");
      const role = (dto.items as MembershipTeam[] | undefined)?.find((t) => t.id === team.id)?.role ?? "owner";
      return {
        id: team.id,
        name: team.name,
        slug: team.slug ?? "",
        role,
      };
    },

    async signOut() {
      await client.auth.signOut();
    },
  };
}
