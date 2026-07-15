import { requireString } from "../routing-utils.js";
import { optionalBearerToken } from "../http-utils.js";

export function registerInvites(router) {
  // The bearer is OPTIONAL on this route, and which path it serves depends on
  // the invite kind:
  //   - member invite: the joining user is already authenticated (anonymous or
  //     real). Their bearer MUST be forwarded so the SECURITY DEFINER RPC
  //     `claim_team_invite` resolves `auth.uid()` and attaches the new actor to
  //     that user. Without it the RPC raises 'member claim requires
  //     authentication' (42501) — the bug this route used to have, since it
  //     always claimed anonymously.
  //   - agent invite: the daemon's `amuxd init` flow has no token yet; the RPC
  //     mints its own in-DB user, so an anonymous claim is correct.
  router.post("/v1/invites/claim", { auth: "none" }, async (ctx) => {
    const body = ctx.json;
    requireString(body.token, "token");
    const accessToken = optionalBearerToken(ctx.headers) ?? undefined;
    const result = await ctx.repository.claimInvite(body.token, { accessToken });
    return { body: result };
  });
}
