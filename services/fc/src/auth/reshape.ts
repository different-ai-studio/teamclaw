// Pure mappers: Better-Auth session/token results -> the GoTrue-compatible
// envelopes that TeamClaw clients (iOS / Expo / Web / daemon) consume verbatim.
// Do NOT change these shapes — they are the fixed client contract.

export type ReshapeUser = {
  id?: string;
  email?: string | null;
  isAnonymous?: boolean;
  is_anonymous?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};

export type ReshapeSession = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null; // epoch seconds
  user: ReshapeUser;
};

// GoTrue-compatible session envelope.
export function toGoTrueSession(s: ReshapeSession) {
  const nowS = Math.floor(Date.now() / 1000);
  const expiresAt = s.expiresAt ?? null;
  return {
    access_token: s.accessToken,
    refresh_token: s.refreshToken ?? null,
    token_type: "bearer" as const,
    expires_at: expiresAt,
    expires_in: expiresAt ? Math.max(0, expiresAt - nowS) : null,
    user: {
      id: s.user?.id,
      email: s.user?.email ?? null,
      is_anonymous: !!(s.user?.isAnonymous ?? s.user?.is_anonymous),
    },
  };
}

// camelCase refresh shape (NOT GoTrue) — what refreshAccessToken returns.
export function toRefreshShape(s: { accessToken: string; refreshToken: string; expiresAt: number }) {
  return { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt };
}

// Better-Auth timestamps are Date | ISO string. Normalize to epoch seconds.
export function toEpochSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}
