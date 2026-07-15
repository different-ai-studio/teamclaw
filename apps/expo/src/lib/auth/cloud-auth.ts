import { Buffer } from "buffer";

import {
  cloudApiBaseUrl,
  createCloudApiClient,
  type CloudApiClient,
} from "../cloud-api/client";
import { codeChallengeFromVerifier, generateCodeVerifier } from "./pkce";
import { createSessionStore, type SessionStore, type StoredSession } from "./session-store";

/**
 * Cloud-only auth client. Exposes a Supabase-`auth`-shaped facade so the app's
 * existing consumers (`supabase.auth.getSession()`, `onAuthStateChange`,
 * `setSession`, `signOut`, `getUser`, `updateUser`) and the
 * `supabaseAccessToken(client)` bearer bridge keep working unchanged, while all
 * I/O goes through the FC `/v1/auth/*` GoTrue proxy + the persisted
 * `SessionStore`. Mirrors iOS `CloudAPIAppOnboardingStore`.
 *
 * `api` is an authenticated Cloud API client (bearer sourced from the session
 * store) used by `onboarding-api` for `/v1/me/bootstrap` + `POST /v1/teams`.
 */

type GoTrueUser = {
  id?: string;
  email?: string | null;
  is_anonymous?: boolean;
};

type GoTrueSessionBody = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: GoTrueUser;
};

type SupabaseShapedSession = {
  access_token: string;
  refresh_token: string;
  user: { id: string | null; is_anonymous: boolean; email: string | null };
};

let storeSingleton: SessionStore | null = null;
let apiSingleton: CloudApiClient | null = null;
const pkceVerifiers = new Map<string, string>();

function store(): SessionStore {
  if (!storeSingleton) {
    storeSingleton = createSessionStore({ baseUrl: cloudApiBaseUrl() });
  }
  return storeSingleton;
}

function api(): CloudApiClient {
  if (!apiSingleton) {
    apiSingleton = createCloudApiClient({
      baseUrl: cloudApiBaseUrl(),
      getAccessToken: () => store().accessToken(),
    });
  }
  return apiSingleton;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Decode a JWT payload (best-effort) for sub/email/is_anonymous/exp. */
function decodeJwt(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function authRequest<T>(
  path: string,
  init: { method: "POST" | "PATCH"; body?: unknown; bearer?: string },
): Promise<T> {
  const baseUrl = cloudApiBaseUrl().replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Authentication request failed.");
  }
  return payload as T;
}

function errorResult(error: unknown): { data: null; error: { message: string } } {
  return {
    data: null,
    error: { message: error instanceof Error ? error.message : "Authentication request failed." },
  };
}

function expiryFrom(body: GoTrueSessionBody): number {
  if (typeof body.expires_at === "number") return body.expires_at;
  if (typeof body.expires_in === "number") return nowSeconds() + body.expires_in;
  return nowSeconds() + 3600;
}

async function storeGoTrue(body: GoTrueSessionBody): Promise<StoredSession> {
  if (!body.access_token || !body.refresh_token) {
    throw new Error("Authentication response did not include a session.");
  }
  const next: StoredSession = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: expiryFrom(body),
    isAnonymous: body.user?.is_anonymous ?? false,
    email: body.user?.email ?? null,
    userId: body.user?.id ?? null,
  };
  await store().setSession(next);
  return next;
}

function toSupabaseSession(s: StoredSession | null): SupabaseShapedSession | null {
  if (!s) return null;
  return {
    access_token: s.accessToken,
    refresh_token: s.refreshToken,
    user: { id: s.userId, is_anonymous: s.isAnonymous, email: s.email },
  };
}

export type CloudAuthClient = {
  auth: {
    getSession: () => Promise<{ data: { session: SupabaseShapedSession | null } }>;
    getUser: () => Promise<{ data: { user: SupabaseShapedSession["user"] | null } }>;
    signOut: () => Promise<{ error: { message: string } | null }>;
    setSession: (input: {
      access_token: string;
      refresh_token: string;
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
    updateUser: (input: {
      email?: string;
      password?: string;
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
    onAuthStateChange: (
      callback: () => void,
    ) => { data: { subscription: { unsubscribe: () => void } } };
    signInAnonymously: () => Promise<{ data: unknown; error: { message: string } | null }>;
    signInWithOtp: (input: {
      email: string;
      options?: { shouldCreateUser?: boolean };
    }) => Promise<void>;
    verifyOtp: (input: {
      email: string;
      token: string;
      type: "email" | "email_change";
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
    oauthAuthorize: (provider: string, redirectTo: string) => Promise<string>;
    exchangeOAuthCode: (code: string) => Promise<unknown>;
  };
  api: CloudApiClient;
};

export const cloudAuth: CloudAuthClient = {
  auth: {
    async getSession() {
      await store().start();
      // Refresh proactively so the returned access token is always live (the
      // MQTT password + every bearer bridge read from here).
      await store().accessToken();
      return { data: { session: toSupabaseSession(store().current()) } };
    },

    async getUser() {
      await store().start();
      const s = toSupabaseSession(store().current());
      return { data: { user: s?.user ?? null } };
    },

    async signOut() {
      await store().start();
      const token = await store().accessToken();
      if (token) {
        try {
          await authRequest("/v1/auth/signout", { method: "POST", bearer: token });
        } catch {
          // Best-effort server logout; clear local state regardless.
        }
      }
      await store().clear();
      return { error: null };
    },

    async setSession({ access_token, refresh_token }) {
      await store().start();
      try {
        const claims = decodeJwt(access_token);
        await store().setSession({
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt: typeof claims.exp === "number" ? (claims.exp as number) : nowSeconds() + 3600,
          isAnonymous: claims.is_anonymous === true,
          email: typeof claims.email === "string" ? (claims.email as string) : null,
          userId: typeof claims.sub === "string" ? (claims.sub as string) : null,
        });
        return { data: {}, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : "setSession failed" } };
      }
    },

    async updateUser(input) {
      await store().start();
      try {
        const token = await store().accessToken();
        if (!token) throw new Error("Not authenticated.");
        const body = await authRequest<GoTrueSessionBody>("/v1/auth/user", {
          method: "PATCH",
          body: input,
          bearer: token,
        });
        // PATCH may return fresh tokens (rare) or just the updated user.
        if (body.access_token && body.refresh_token) {
          await storeGoTrue(body);
        }
        return { data: body, error: null };
      } catch (error) {
        return {
          data: null,
          error: { message: error instanceof Error ? error.message : "updateUser failed" },
        };
      }
    },

    onAuthStateChange(callback) {
      const unsubscribe = store().subscribe(callback);
      return { data: { subscription: { unsubscribe } } };
    },

    async signInAnonymously() {
      await store().start();
      const body = await authRequest<GoTrueSessionBody>("/v1/auth/signin-anonymous", {
        method: "POST",
        body: {},
      });
      await storeGoTrue(body);
      return { data: {}, error: null };
    },

    async signInWithOtp({ email, options }) {
      await store().start();
      await authRequest("/v1/auth/signin-otp", {
        method: "POST",
        body: { email, options: { shouldCreateUser: options?.shouldCreateUser ?? true } },
      });
    },

    async verifyOtp({ email, token, type }) {
      await store().start();
      // Store a session only when the response carries one (sign-in OTP does;
      // an `email_change` confirmation keeps the existing user/session).
      const consume = async (body: GoTrueSessionBody) => {
        if (body.access_token && body.refresh_token) await storeGoTrue(body);
        return { data: body, error: null as { message: string } | null };
      };
      try {
        const body = await authRequest<GoTrueSessionBody>("/v1/auth/verify-otp", {
          method: "POST",
          body: { email, token, type },
        });
        return await consume(body);
      } catch (error) {
        // Mirror the legacy store: for sign-in OTP, fall back to type "signup".
        if (type === "email") {
          try {
            const body = await authRequest<GoTrueSessionBody>("/v1/auth/verify-otp", {
              method: "POST",
              body: { email, token, type: "signup" },
            });
            return await consume(body);
          } catch (retryError) {
            return errorResult(retryError);
          }
        }
        return errorResult(error);
      }
    },

    async oauthAuthorize(provider, redirectTo) {
      await store().start();
      const verifier = generateCodeVerifier();
      const challenge = codeChallengeFromVerifier(verifier);
      pkceVerifiers.set(provider, verifier);
      const baseUrl = cloudApiBaseUrl().replace(/\/+$/, "");
      const params = new URLSearchParams({ redirect: redirectTo, code_challenge: challenge });
      return `${baseUrl}/v1/auth/oauth/${encodeURIComponent(provider)}/authorize?${params.toString()}`;
    },

    async exchangeOAuthCode(code) {
      await store().start();
      // The verifier is keyed by provider; we don't know which provider the
      // callback came from, so take the most recent (there is only one
      // in-flight OAuth attempt at a time).
      const verifier = [...pkceVerifiers.values()].pop();
      pkceVerifiers.clear();
      if (!verifier) throw new Error("No PKCE verifier for OAuth exchange.");
      const body = await authRequest<GoTrueSessionBody>("/v1/auth/oauth/exchange", {
        method: "POST",
        body: { code, codeVerifier: verifier },
      });
      await storeGoTrue(body);
      return body;
    },
  },

  get api() {
    return api();
  },
};
