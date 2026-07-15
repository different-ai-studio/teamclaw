import { betterAuth } from "better-auth";
import { jwt, bearer, anonymous, emailOTP, genericOAuth } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema/index.js";
import { sendOtpEmail } from "./otp-delivery.js";

let _auth: ReturnType<typeof buildAuth> | null = null;

export type BuildAuthOpts = {
  // The drizzle db handle to back the auth adapter. Defaults to the prod
  // singleton (getDb()). Tests inject a pglite-backed handle here so prod
  // getAuth() and the test share one construction path.
  db?: unknown;
  secret?: string;
  baseURL?: string;
};

// Single construction path shared by prod getAuth() and tests. Build a
// Better-Auth instance with the project's fixed plugin set + social providers.
export function buildAuth(opts: BuildAuthOpts = {}) {
  const baseURL = opts.baseURL ?? process.env.AUTH_BASE_URL ?? "https://cloud.ucar.cc";
  const secret = opts.secret ?? process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const db = opts.db ?? getDb();
  return betterAuth({
    baseURL,
    secret,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    database: drizzleAdapter(db as any, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    socialProviders: {
      apple: { clientId: process.env.APPLE_CLIENT_ID ?? "", clientSecret: process.env.APPLE_CLIENT_SECRET ?? "" },
      google: { clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "" },
    },
    plugins: [
      jwt(),
      bearer(),
      anonymous(),
      emailOTP({ sendVerificationOTP: sendOtpEmail }),
      genericOAuth({ config: [] }),
    ],
  });
}

// Lazy singleton: importing this module needs no env until getAuth() is called.
export function getAuth() {
  if (!_auth) _auth = buildAuth();
  return _auth;
}
export type Auth = ReturnType<typeof buildAuth>;
