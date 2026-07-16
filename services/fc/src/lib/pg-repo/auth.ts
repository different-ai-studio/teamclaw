import { eq } from "drizzle-orm";
import type { JWTVerifyGetKey } from "jose";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getAuth, type Auth } from "../../auth/better-auth.js";
import { mintSession } from "../../auth/mint-session.js";
import { toGoTrueSession, toRefreshShape, toEpochSeconds, type ReshapeUser } from "../../auth/reshape.js";
import { verifyAccessToken } from "../../auth/verify.js";
import { teamInvites, actors, members, teamMembers, agents, agentMemberAccess, teamWorkspaceConfig } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { randomUUID } from "node:crypto";

// Best-effort: look up the team's persisted litellmTeamId (if any) and seed
// the given actor's LiteLLM member key. Always called AFTER the enclosing
// transaction has committed — never inside it — so a provisioning failure
// can't roll back invite claiming. No-ops when the team has no
// litellmTeamId yet. Never throws (delegates to seedMemberKey's try/catch).
async function seedMemberKeyForTeam(db: PgDatabase<any, any>, teamId: string, actorId: string) {
  try {
    const [wc] = await db
      .select({ litellmTeamId: teamWorkspaceConfig.litellmTeamId })
      .from(teamWorkspaceConfig)
      .where(eq(teamWorkspaceConfig.teamId, teamId))
      .limit(1);
    const { seedMemberKey } = await import("../team-provisioning.js");
    await seedMemberKey(wc?.litellmTeamId ?? null, actorId);
  } catch (e) {
    console.warn("[claimInvite] member-key provisioning skipped:", (e as any)?.message);
  }
}

// createPgAuthRepository — the BACKEND_KIND=postgres AuthRepository, backed by
// Better-Auth. Every method calls the VERIFIED getAuth().api.* and reshapes the
// result into the fixed client contract (GoTrue-compatible envelopes).
//
// VERIFIED Better-Auth (1.6.12) facts driving the reshaping:
//   - signInAnonymous / signInEmail / signUpEmail / signInEmailOTP return
//     `{ token: <sessionToken>, user }`. That `token` is the SESSION token, NOT
//     a JWT. We treat it as the refresh_token.
//   - The client-facing access_token must be a JWT. We obtain it via the jwt
//     plugin: auth.api.getToken({ headers: Authorization: Bearer <sessionToken> })
//     -> `{ token: <JWT> }`. The JWT has sub=userId, iss=aud=baseURL (matches
//     verify.ts), exp ~15m.
//   - Session (refresh) expiry comes from auth.api.getSession(...).session.expiresAt.
export function createPgAuthRepository(
  opts: {
    auth?: Auth;
    db?: PgDatabase<any, any>;
    // verifyOpts lets tests inject a local JWKS + issuer/audience baseURL so
    // the JWT-resolving methods (signOut/updateUser/idToken-link) verify the
    // access_token without a running HTTP JWKS endpoint. Production omits it
    // and uses the remote JWKS (verify.ts default), matching index.ts.
    verifyOpts?: { keyset?: JWTVerifyGetKey; baseURL?: string };
  } = {},
) {
  // Keep getAuth() lazy — resolve inside each method so importing the module
  // needs no env. `opts.auth` lets tests inject a pglite-backed instance.
  const resolveAuth = () => opts.auth ?? getAuth();
  const verifyJwt = (token: string) => verifyAccessToken(token, opts.verifyOpts ?? {});

  function bearer(sessionToken: string): Headers {
    const h = new Headers();
    h.set("authorization", `Bearer ${sessionToken}`);
    return h;
  }

  // Mint a JWT access_token from a Better-Auth session token via the jwt plugin.
  async function jwtFor(auth: Auth, sessionToken: string): Promise<string> {
    const out = await auth.api.getToken({ headers: bearer(sessionToken) });
    if (!out?.token) throw new Error("auth_jwt_unavailable");
    return out.token;
  }

  // Read the session row (for refresh expiry) using the session token.
  async function sessionExpiry(auth: Auth, sessionToken: string): Promise<number | null> {
    const s = await auth.api.getSession({ headers: bearer(sessionToken) });
    return toEpochSeconds(s?.session?.expiresAt);
  }

  // Turn a Better-Auth sign-in result ({ token, user }) into the GoTrue envelope:
  // access_token = freshly minted JWT, refresh_token = the session token.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function envelopeFromSignIn(auth: Auth, result: any) {
    const sessionToken: string | undefined = result?.token;
    const user = result?.user;
    if (!sessionToken || !user) throw new Error("auth_signin_no_session");
    const accessToken = await jwtFor(auth, sessionToken);
    const expiresAt = await sessionExpiry(auth, sessionToken);
    return toGoTrueSession({ accessToken, refreshToken: sessionToken, expiresAt, user });
  }

  return {
    // --- Phone login (partner-aligned, supabase backend only) ---
    async phoneSendCode() {
      throw new ApiError(501, "phone_login_unsupported", "phone login is only available under BACKEND_KIND=supabase");
    },
    async phoneLogin() {
      throw new ApiError(501, "phone_login_unsupported", "phone login is only available under BACKEND_KIND=supabase");
    },

    // --- Anonymous ---
    async signInAnonymous() {
      const auth = resolveAuth();
      const result = await auth.api.signInAnonymous();
      return envelopeFromSignIn(auth, result);
    },

    // --- Email + password ---
    async signUp({ email, password }: { email: string; password: string }) {
      const auth = resolveAuth();
      const result = await auth.api.signUpEmail({ body: { email, password, name: email } });
      return envelopeFromSignIn(auth, result);
    },

    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const auth = resolveAuth();
      const result = await auth.api.signInEmail({ body: { email, password } });
      return envelopeFromSignIn(auth, result);
    },

    // --- Email OTP (phone OTP — see note) ---
    async signInOtp({ email, phone, options }: { email?: string; phone?: string; options?: unknown }) {
      void options; // GoTrue accepts options (e.g. shouldCreateUser); Better-Auth always creates.
      // Phone (SMS) OTP under BACKEND_KIND=postgres is NOT yet wired: Better-Auth's
      // emailOTP plugin is email-only; phone needs the phoneNumber plugin + an SMS
      // provider (deploy follow-up). Fail loudly rather than silently drop the SMS.
      if (phone && (!email || email.length === 0)) {
        throw new ApiError(501, "phone_otp_unsupported", "phone OTP requires the Better-Auth phoneNumber plugin + SMS provider (not yet configured under BACKEND_KIND=postgres)");
      }
      const auth = resolveAuth();
      // Better-Auth: send a sign-in OTP. Returns { success: true }; clients
      // expect a GoTrue-ish empty-ish ack after sending.
      await auth.api.sendVerificationOTP({ body: { email: email!, type: "sign-in" } });
      return {};
    },

    async verifyOtp({ email, phone, token }: { email?: string; phone?: string; token: string; type?: string }) {
      // See signInOtp: phone OTP is not yet supported under BACKEND_KIND=postgres.
      if (phone && (!email || email.length === 0)) {
        throw new ApiError(501, "phone_otp_unsupported", "phone OTP requires the Better-Auth phoneNumber plugin + SMS provider (not yet configured under BACKEND_KIND=postgres)");
      }
      const auth = resolveAuth();
      const result = await auth.api.signInEmailOTP({ body: { email: email!, otp: token } });
      return envelopeFromSignIn(auth, result);
    },

    // --- Refresh ---
    // The incoming refreshToken is the Better-Auth session token. Validate it
    // (getSession) and re-mint a JWT. Better-Auth does not rotate the session
    // token on JWT fetch, so refreshToken is returned unchanged.
    async refreshAccessToken({ refreshToken }: { refreshToken: string }) {
      const auth = resolveAuth();
      const session = await auth.api.getSession({ headers: bearer(refreshToken) });
      if (!session?.session) throw new Error("invalid_refresh_token");
      const accessToken = await jwtFor(auth, refreshToken);
      const expiresAt = toEpochSeconds(session.session.expiresAt);
      if (expiresAt == null) throw new Error("invalid_refresh_token");
      return toRefreshShape({ accessToken, refreshToken, expiresAt });
    },

    // --- Native OIDC (Apple / Google id_token grant) ---
    // Better-Auth signInSocial with an idToken body performs the native grant.
    //
    // anonymous-link path (accessToken present): the caller is upgrading its
    // current (anonymous) user. The client's `accessToken` is a JWT, NOT a
    // Better-Auth session token. Forwarding it as the bearer is the bug (#6):
    // Better-Auth's bearer plugin HMAC-verifies the bearer as a SESSION token
    // (split(".") -> value.hmac, two parts); a JWT has THREE parts, so the
    // HMAC fails, the bearer hook exits without injecting a session cookie, the
    // anonymous after-hook sees no anonymous session, onLinkAccount never runs,
    // and signInSocial creates a DUPLICATE user instead of linking.
    //
    // Fix: verify the JWT -> userId (the anonymous user), then mint a REAL
    // Better-Auth session token for that userId via internalAdapter
    // .createSession (the same surface mintSession uses). That session token
    // passes the bearer HMAC, so the anonymous plugin resolves the anonymous
    // session and runs its onLinkAccount + cleanup exactly as a live client
    // session would have.
    async signInWithIdToken({
      provider,
      idToken,
      nonce,
      accessToken,
    }: {
      provider: string;
      idToken: string;
      nonce?: string | null;
      accessToken?: string | null;
    }) {
      const auth = resolveAuth();
      const headers = new Headers();
      if (accessToken) {
        const { sub } = await verifyJwt(accessToken);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const authCtx = await (auth as any).$context;
        const sess = await authCtx.internalAdapter.createSession(sub);
        if (!sess?.token) throw new Error("idtoken_link_no_session_token");
        headers.set("authorization", `Bearer ${sess.token}`);
      }
      const result = await auth.api.signInSocial({
        body: {
          provider,
          idToken: { token: idToken, ...(nonce ? { nonce } : {}) },
        },
        headers,
      });
      return envelopeFromSignIn(auth, result);
    },

    // --- OAuth PKCE (web redirect flow) ---
    // Synchronous: returns the upstream authorize URL the caller 302-redirects to.
    oauthAuthorizeUrl({
      provider,
      redirect,
      codeChallenge,
    }: {
      provider: string;
      redirect: string;
      codeChallenge: string;
    }): string {
      const auth = resolveAuth();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const baseURL = ((auth as any).options?.baseURL ?? process.env.AUTH_BASE_URL ?? "https://cloud.ucar.cc") as string;
      const u = new URL(`${baseURL}/api/auth/sign-in/social`);
      u.searchParams.set("provider", provider);
      u.searchParams.set("callbackURL", redirect);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },

    async exchangePkceCode({ code, codeVerifier }: { code: string; codeVerifier: string }) {
      const auth = resolveAuth();
      // Better-Auth completes the OAuth2 callback; the JS API surface for the
      // PKCE exchange is the oAuth2Callback endpoint. Reshape into the envelope.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (auth.api as any).callbackOAuth({
        body: { code, codeVerifier },
      });
      return envelopeFromSignIn(auth, result);
    },

    // --- signOut / updateUser ---
    // The client's `accessToken` is a JWT, NOT a Better-Auth session token, so
    // it must NOT be forwarded as the bearer to auth.api.* (bug #6 — the bearer
    // plugin HMAC-verifies the bearer as a 2-part session token; a 3-part JWT
    // fails, the bearer hook exits, no session resolves, and signOut/updateUser
    // silently no-op). Instead resolve the user from the verified JWT and act
    // server-side by user id via internalAdapter.
    async signOut({ accessToken }: { accessToken: string }) {
      const auth = resolveAuth();
      let sub: string;
      try {
        ({ sub } = await verifyJwt(accessToken));
      } catch {
        // A signOut with an invalid/expired token is a no-op success: the
        // caller is already not authenticated, matching prior best-effort
        // semantics (the old bearer path also silently did nothing here).
        return { success: true };
      }
      // Revoke ALL of this user's sessions server-side. deleteSessions(userId)
      // deletes every session row for the user, so any outstanding refresh
      // token (session token) stops validating on the next refresh/getSession.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const authCtx = await (auth as any).$context;
      await authCtx.internalAdapter.deleteSessions(sub);
      return { success: true };
    },

    async updateUser({ accessToken, body }: { accessToken: string; body: Record<string, unknown> }) {
      const auth = resolveAuth();
      const { sub } = await verifyJwt(accessToken);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const authCtx = await (auth as any).$context;
      // internalAdapter.updateUser(userId, data) -> the updated user row.
      const user: ReshapeUser = await authCtx.internalAdapter.updateUser(sub, body);
      // Reshape to the GoTrue-ish user the client expects (same user shape
      // toGoTrueSession emits).
      return {
        id: user?.id,
        email: user?.email ?? null,
        is_anonymous: !!(user?.isAnonymous ?? user?.is_anonymous),
      };
    },

    // --- Plan 5 ---
    // switchActiveTeam: cross-org active-team switching depends on the org model
    // (public.orgs + public.users.org_id + the GoTrue access-token hook), which
    // only exists on the supabase backend.
    async switchActiveTeam() {
      throw new ApiError(501, "not_implemented", "switch active team requires the supabase backend");
    },

    // claimInvite(token, { userId? }):
    //   member branch: requires a userId (existing Better-Auth user); inserts
    //     actor(member) + member(active) + team_member; refreshToken = null.
    //   agent branch: creates a daemon Better-Auth user (daemon.{uuid}@amuxd.run),
    //     inserts actor(agent) + agents + agent_member_access(admin); mints a
    //     session and returns the refreshToken.
    //   Both branches mark the invite consumed atomically in a transaction.
    async claimInvite(token: string, ctx: { userId?: string; accessToken?: string } = {}) {
      const db = opts.db;
      if (!db) throw new Error("claimInvite requires db to be passed in opts");
      const auth = resolveAuth();

      // The route forwards the caller's bearer (member invites) as accessToken;
      // resolve it to a userId so the member branch can attach the actor. An
      // explicit ctx.userId still wins (tests / internal callers). Agent invites
      // arrive with neither and self-provision a userId below.
      let callerUserId = ctx.userId;
      if (!callerUserId && ctx.accessToken) {
        const claims = await verifyJwt(ctx.accessToken);
        callerUserId = claims.sub;
      }

      // Load + validate invite
      const [invite] = await db
        .select()
        .from(teamInvites)
        .where(eq(teamInvites.token, token))
        .limit(1);
      if (!invite) throw new ApiError(404, "not_found", "invite not found");
      if (invite.consumedAt) throw new ApiError(409, "conflict", "invite_already_claimed");
      if (new Date(invite.expiresAt) < new Date()) throw new ApiError(404, "not_found", "invite_expired");

      const kind = invite.kind; // "member" | "agent"

      if (kind === "member") {
        const userId = callerUserId;
        if (!userId) throw new ApiError(400, "bad_request", "userId required for member invite claim");

        const claimed = await (db as any).transaction(async (tx: any) => {
          // Insert actor
          const [actor] = await tx.insert(actors).values({
            teamId: invite.teamId,
            actorType: "member",
            displayName: invite.displayName,
            userId,
            invitedByActorId: invite.invitedByActorId,
          }).returning();

          // Insert member (active)
          await tx.insert(members).values({ id: actor.id, status: "active" });

          // Insert team_member
          await tx.insert(teamMembers).values({
            teamId: invite.teamId,
            memberId: actor.id,
            role: invite.teamRole ?? "member",
          });

          // Mark invite consumed
          await (tx.update(teamInvites) as any)
            .set({ consumedAt: new Date(), consumedByActorId: actor.id })
            .where(eq(teamInvites.token, token));

          return {
            actorId: actor.id,
            teamId: invite.teamId,
            actorType: "member" as const,
            displayName: invite.displayName,
            refreshToken: null,
          };
        });

        // Best-effort: seed the new member's LiteLLM key. Runs AFTER the
        // transaction commits — never blocks/rolls back invite claiming.
        await seedMemberKeyForTeam(db, claimed.teamId, claimed.actorId);

        return claimed;
      }

      if (kind === "agent") {
        // Create a daemon Better-Auth user via internalAdapter.createUser
        // (same surface used by mintSession for createSession)
        const ctx2 = await (auth as any).$context;
        const daemonEmail = `daemon.${randomUUID()}@amuxd.run`;
        const daemonUser = await ctx2.internalAdapter.createUser({
          email: daemonEmail,
          name: invite.displayName,
          emailVerified: false,
        });
        if (!daemonUser?.id) throw new Error("failed to create daemon Better-Auth user");

        const minted = await mintSession(daemonUser.id, auth);

        // Compensation helper: if the DB transaction fails, clean up the orphaned
        // Better-Auth user + session so no zombie credentials are left behind.
        async function compensate() {
          try {
            await ctx2.internalAdapter.deleteSessions(daemonUser.id);
          } catch { /* best-effort */ }
          try {
            if (typeof ctx2.internalAdapter.deleteUser === "function") {
              await ctx2.internalAdapter.deleteUser(daemonUser.id);
            }
          } catch { /* best-effort */ }
        }

        let oldDaemonUserId: string | null = null;
        let result!: { actorId: string; teamId: string; actorType: "agent"; displayName: string; refreshToken: string | null };
        try {
          result = await (db as any).transaction(async (tx: any) => {
          let actorId: string;

          if (invite.targetActorId) {
            // Rebind path: reuse the existing actor + agent rows, just update them.
            const [old] = await tx.select({ userId: actors.userId }).from(actors).where(eq(actors.id, invite.targetActorId)).limit(1);
            oldDaemonUserId = old?.userId ?? null;

            await (tx.update(actors) as any)
              .set({ userId: daemonUser.id, invitedByActorId: invite.invitedByActorId, lastActiveAt: null, updatedAt: new Date() })
              .where(eq(actors.id, invite.targetActorId));

            await (tx.update(agents) as any)
              .set({ ownerMemberId: invite.invitedByActorId, visibility: "team", updatedAt: new Date() })
              .where(eq(agents.id, invite.targetActorId));

            await (tx.insert(agentMemberAccess) as any)
              .values({ agentId: invite.targetActorId, memberId: invite.invitedByActorId, permissionLevel: "admin", grantedByMemberId: invite.invitedByActorId })
              .onConflictDoUpdate({ target: [agentMemberAccess.agentId, agentMemberAccess.memberId], set: { permissionLevel: "admin" } });

            actorId = invite.targetActorId;
          } else {
            // New agent path: insert actor + agents row
            const [actor] = await tx.insert(actors).values({
              teamId: invite.teamId,
              actorType: "agent",
              displayName: invite.displayName,
              userId: daemonUser.id,
              invitedByActorId: invite.invitedByActorId,
            }).returning();

            await tx.insert(agents).values({
              id: actor.id,
              agentKind: invite.agentKind ?? "daemon",
              status: "active",
              visibility: "team",
            });

            await tx.insert(agentMemberAccess).values({
              agentId: actor.id,
              memberId: invite.invitedByActorId,
              permissionLevel: "admin",
              grantedByMemberId: invite.invitedByActorId,
            });

            actorId = actor.id;
          }

          // Mark invite consumed
          await (tx.update(teamInvites) as any)
            .set({ consumedAt: new Date(), consumedByActorId: actorId })
            .where(eq(teamInvites.token, token));

          return {
            actorId,
            teamId: invite.teamId,
            actorType: "agent" as const,
            displayName: invite.displayName,
            refreshToken: minted.refreshToken,
          };
        });
        } catch (txErr) {
          // Transaction failed — compensate by removing the orphaned BA user+session
          await compensate();
          throw txErr;
        }

        // Best-effort cleanup of the previous daemon user the agent was bound to.
        // Done AFTER commit and OUTSIDE the drizzle tx: pglite is single-connection, so a
        // Better-Auth adapter query issued inside the open tx would deadlock. Idempotent.
        if (oldDaemonUserId && oldDaemonUserId !== daemonUser.id) {
          try { await ctx2.internalAdapter.deleteSessions(oldDaemonUserId); } catch { /* ignore */ }
          try {
            if (typeof ctx2.internalAdapter.deleteUser === "function") {
              await ctx2.internalAdapter.deleteUser(oldDaemonUserId);
            }
          } catch { /* ignore */ }
        }

        // Best-effort: seed the new agent actor's LiteLLM key. Runs AFTER the
        // transaction commits — never blocks/rolls back invite claiming.
        await seedMemberKeyForTeam(db, result.teamId, result.actorId);

        return result;
      }

      throw new ApiError(400, "bad_request", `unsupported invite kind: ${kind}`);
    },

    // Re-exported primitive for Plan 5 wiring.
    mintSession: (userId: string) => mintSession(userId, resolveAuth()),
  };
}
