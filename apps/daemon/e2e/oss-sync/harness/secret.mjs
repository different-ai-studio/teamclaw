import { randomBytes } from "node:crypto";

/** 32-byte team secret as 64 lowercase hex chars (matches team_shared_env::derive_key). */
export function genTeamSecret() {
  return randomBytes(32).toString("hex");
}
