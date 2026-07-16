import type { AuthBackend, AuthClaimResult, AuthSession, PendingInvite, Unsubscribe } from "../types";
import { BackendError } from "../errors";
import type { CloudApiClient } from "./http";
import {
  adoptRefreshToken,
  createAuthClient,
  getSession as getStoreSession,
  runDesktopOAuth,
  subscribe as subscribeStore,
  type AuthClient,
  type OAuthProvider,
  type PhoneLoginResult,
  type Session,
} from "@/lib/auth";

function mapSession(session: Session | null): AuthSession | null {
  if (!session) return null;
  const user = session.user;
  // Defensive: a partial session (no user, or user without id) is treated as
  // signed-out rather than crashing the caller. This can happen with stale
  // localStorage entries written by an earlier broken build.
  if (!user || typeof user.id !== "string" || !user.id) return null;
  return {
    user: {
      id: user.id,
      email: user.email ?? null,
      isAnonymous: Boolean((user as { is_anonymous?: boolean }).is_anonymous),
      providerData: user,
    },
    accessToken: session.access_token ?? null,
    refreshToken: session.refresh_token ?? null,
    expiresAt: session.expires_at ?? null,
    providerData: session,
  };
}

export function createAuthModule(
  client: CloudApiClient,
  authClient: AuthClient,
): AuthBackend {
  return {
    async getSession(): Promise<AuthSession | null> {
      return mapSession(getStoreSession());
    },
    onAuthStateChange(listener: (session: AuthSession | null) => void): Unsubscribe {
      return subscribeStore((_event, session) => listener(mapSession(session)));
    },
    async sendOtp(email: string): Promise<void> {
      await authClient.sendOtp(email, { shouldCreateUser: true });
    },
    async verifyOtp(email: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.verifyOtp(email, code, "email");
      return mapSession(next);
    },
    async sendPhoneOtp(phone: string): Promise<void> {
      await authClient.sendPhoneOtp(phone, { shouldCreateUser: true });
    },
    async verifyPhoneOtp(phone: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.verifyPhoneOtp(phone, code);
      return mapSession(next);
    },
    async verifyPhoneOtpResult(phone: string, code: string): Promise<PhoneLoginResult> {
      return authClient.verifyPhoneOtpResult(phone, code);
    },
    async loginWithPhoneUser(phone: string, code: string, userId: string): Promise<AuthSession | null> {
      const next = await authClient.loginWithPhoneUser(phone, code, userId);
      return mapSession(next);
    },
    async signInAnonymously(): Promise<AuthSession | null> {
      const next = await authClient.signInAnonymously();
      return mapSession(next);
    },
    async signInWithOAuth(provider: OAuthProvider): Promise<AuthSession | null> {
      const next = await runDesktopOAuth(authClient, provider);
      return mapSession(next);
    },
    async signOut(): Promise<void> {
      await authClient.signOut();
    },
    async sendUpgradeEmailOtp(email: string): Promise<void> {
      await authClient.updateUser({ email });
    },
    async verifyUpgradeEmailOtp(email: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.verifyOtp(email, code, "email_change");
      return mapSession(next);
    },
    // Phone identity upgrade (partner-aligned): reuse phone send-code, then bind
    // the phone to the current account (writes public.users in the default org).
    async sendUpgradePhoneOtp(phone: string): Promise<void> {
      await authClient.sendPhoneOtp(phone, { shouldCreateUser: false });
    },
    async verifyUpgradePhoneOtp(phone: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.bindPhone(phone, code);
      return mapSession(next);
    },
    async adoptSession(refreshToken: string): Promise<AuthSession | null> {
      const next = await adoptRefreshToken(refreshToken);
      return mapSession(next);
    },
    async claimInvite(token: string): Promise<AuthClaimResult> {
      const claim = await client.post<AuthClaimResult>("/v1/invites/claim", { token });
      if (!claim) {
        throw new BackendError({
          category: "Unknown",
          operation: "auth.claimInvite",
          message: "Invite claim returned no team.",
        });
      }
      // The team share mode is owned by the cloud (`GET /v1/teams/:id/share-mode`)
      // and surfaced via the team-share store; we no longer persist a local
      // `team_mode` into teamclaw.json after a join.
      return claim;
    },
    async listPendingInvites(): Promise<PendingInvite[]> {
      const page = await client.get<{ items: PendingInvite[] }>("/v1/invites/pending");
      return page?.items ?? [];
    },
    async acceptPendingInvite(inviteId: string): Promise<AuthClaimResult> {
      const claim = await client.post<AuthClaimResult>(
        `/v1/invites/${encodeURIComponent(inviteId)}/accept`,
        {},
      );
      if (!claim) {
        throw new BackendError({
          category: "Unknown",
          operation: "auth.acceptPendingInvite",
          message: "Invite accept returned no team.",
        });
      }
      return claim;
    },
    async declinePendingInvite(inviteId: string): Promise<void> {
      await client.post<void>(`/v1/invites/${encodeURIComponent(inviteId)}/decline`, {});
    },
  };
}

export { createAuthClient };
