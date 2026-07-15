import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  getS3Client,
  OSS_BUCKET as BUCKET,
  OSS_REGION as REGION,
  OSS_ENDPOINT as ENDPOINT,
} from "./oss.js";
import { json } from "./responses.js";

// ---------------------------------------------------------------------------
// OSS-backed JSON object store + team-registry auth helpers.
//
// Extracted from admin-handlers.ts. These wrap the team metadata / registry
// objects that live under `teams/<id>/_registry` and `teams/<id>/_meta` in the
// OSS bucket, plus the team-secret verification used by the AI/managed-git
// handlers.
// ---------------------------------------------------------------------------

export function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export async function ossGet(key: string) {
  const s3 = getS3Client();
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET(), Key: key })
    );
    const text = await (res.Body as { transformToString(): Promise<string> }).transformToString();
    return JSON.parse(text);
  } catch (err: any) {
    if (
      err.name === "NoSuchKey" ||
      err.$metadata?.httpStatusCode === 404 ||
      err.Code === "NoSuchKey"
    ) {
      return null;
    }
    throw err;
  }
}

export async function ossPut(key: string, data: unknown) {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    })
  );
}

export function ossInfo() {
  return { bucket: BUCKET(), region: REGION(), endpoint: ENDPOINT() };
}

export async function verifyTeam(teamId: string, teamSecret: string, requireOwnerNodeId?: string) {
  if (!teamId || !teamSecret) {
    return { error: json(400, { error: "Missing teamId or teamSecret" }) };
  }
  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return { error: json(404, { error: "Team not found" }) };
  }
  if (sha256(teamSecret) !== auth.teamSecretHash) {
    return { error: json(403, { error: "Invalid team secret" }) };
  }
  if (requireOwnerNodeId && requireOwnerNodeId !== auth.ownerNodeId) {
    return { error: json(403, { error: "Only the owner can perform this action" }) };
  }
  return { auth, isOwner: (nodeId: string) => nodeId === auth.ownerNodeId };
}
