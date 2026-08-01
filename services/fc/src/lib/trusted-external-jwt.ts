import { jwtVerify } from "jose";

type TrustedUser = {
  id: string;
  app_metadata: Record<string, unknown>;
};

/**
 * Validates a JWT issued by a separately hosted, explicitly trusted Supabase
 * Auth instance. GoTrue's /user endpoint additionally requires its local
 * auth.sessions row, which is not shared between the two projects.
 */
export async function verifyTrustedExternalJwt(token: string, secret: string): Promise<TrustedUser> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    audience: "authenticated",
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("jwt_missing_sub");
  }
  const appMetadata = payload.app_metadata;
  return {
    id: payload.sub,
    app_metadata: appMetadata && typeof appMetadata === "object" && !Array.isArray(appMetadata)
      ? appMetadata as Record<string, unknown>
      : {},
  };
}
