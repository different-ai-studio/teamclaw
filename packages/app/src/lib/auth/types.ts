// Strict subset of the GoTrue / Supabase session shape that TeamClaw needs.
// Only the fields the app actually reads are typed. Extra fields returned by
// GoTrue (provider, identities, etc.) are tolerated but not surfaced.

export interface AuthUser {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
  /** Epoch seconds. */
  expires_at?: number | null;
  user: AuthUser;
  [key: string]: unknown;
}

export type OtpType = "email" | "email_change" | "sms" | "phone_change";

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = "auth_error") {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export type Unsubscribe = () => void;
export type AuthChangeEvent =
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED";
export type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;
