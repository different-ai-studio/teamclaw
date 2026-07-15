import { requireString } from "../routing-utils.js";

export function registerAccount(router) {
  // Graduate the caller out of the shared DEFAULT_ORG into their own org:
  // create the org (name + contact), reparent + rename their default-org team.
  // Authenticated (caller bearer forwarded to the SECURITY DEFINER RPC).
  // See docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md §8.
  router.post("/v1/account/upgrade", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.orgName, "orgName");
    const result = await ctx.repository.upgradeAccount({
      teamId: body.teamId,
      orgName: body.orgName,
      contact: typeof body.contact === "string" ? body.contact : null,
    });
    return { body: result };
  });

  // Phone identity upgrade (betly-aligned): bind a phone to the caller's account
  // using a code from /v1/auth/phone/send-code, writing a public.users row in
  // the default org. Authenticated (caller bearer forwarded to the RPC).
  router.post("/v1/account/bind-phone", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.phone, "phone");
    requireString(body.code, "code");
    const result = await ctx.repository.bindPhone({ phone: body.phone, code: body.code });
    return { body: result };
  });
}
