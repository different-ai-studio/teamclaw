import { createHash } from "node:crypto";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import STS20150401, * as $STS from "@alicloud/sts20150401";
import OpenApi, * as $OpenApi from "@alicloud/openapi-client";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const ACCESS_KEY_ID = () => process.env.ACCESS_KEY_ID;
const ACCESS_KEY_SECRET = () => process.env.ACCESS_KEY_SECRET;
const ROLE_ARN = () => process.env.ROLE_ARN;
const BUCKET = () => process.env.BUCKET || "teamclaw-sync";
const REGION = () => process.env.REGION || "cn-hangzhou";
const ENDPOINT = () =>
  process.env.ENDPOINT || "https://oss-cn-hangzhou.aliyuncs.com";

// ---------------------------------------------------------------------------
// Rate limiting — in-memory, per IP, 10 req/min
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
/** @type {Map<string, number[]>} */
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  let timestamps = rateLimitMap.get(ip);
  if (!timestamps) {
    timestamps = [];
    rateLimitMap.set(ip, timestamps);
  }
  // Prune old entries
  while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// Periodically clean up stale IPs to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length === 0) rateLimitMap.delete(ip);
  }
}, 60_000).unref?.();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function getS3Client() {
  return new S3Client({
    region: REGION(),
    endpoint: ENDPOINT(),
    credentials: {
      accessKeyId: ACCESS_KEY_ID(),
      secretAccessKey: ACCESS_KEY_SECRET(),
    },
    forcePathStyle: true,
  });
}

function getStsClient() {
  const config = new $OpenApi.Config({
    accessKeyId: ACCESS_KEY_ID(),
    accessKeySecret: ACCESS_KEY_SECRET(),
  });
  config.endpoint = "sts.aliyuncs.com";
  return new STS20150401.default(config);
}

async function ossGet(key) {
  const s3 = getS3Client();
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET(), Key: key })
    );
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (err) {
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

async function ossPut(key, data) {
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

// ---------------------------------------------------------------------------
// STS policies
// ---------------------------------------------------------------------------
function memberPolicy(teamId, nodeId) {
  return JSON.stringify({
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: ["oss:GetObject", "oss:ListObjects"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*`,
      },
      {
        Effect: "Deny",
        Action: ["oss:GetObject", "oss:ListObjects"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_registry/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:PutObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/updates/${nodeId}/*`,
      },
    ],
  });
}

function ownerPolicy(teamId, nodeId) {
  const base = JSON.parse(memberPolicy(teamId, nodeId));
  base.Statement.push(
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_meta/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshot/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*`,
    }
  );
  return JSON.stringify(base);
}

async function assumeRole(sessionName, policy) {
  const client = getStsClient();
  const request = new $STS.AssumeRoleRequest({
    roleArn: ROLE_ARN(),
    roleSessionName: sessionName,
    durationSeconds: 3600,
    policy,
  });
  const resp = await client.assumeRole(request);
  const creds = resp.body.credentials;
  return {
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    securityToken: creds.securityToken,
    expiration: creds.expiration,
  };
}

function ossInfo() {
  return { bucket: BUCKET(), region: REGION(), endpoint: ENDPOINT() };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleRegister(body) {
  const { teamSecret, ownerNodeId, teamName, ownerName, ownerEmail } = body;
  if (!teamSecret || !ownerNodeId || !teamName) {
    return json(400, { error: "Missing required fields" });
  }

  const teamId = nanoid();
  const createdAt = new Date().toISOString();
  const teamSecretHash = sha256(teamSecret);

  // Write auth.json
  await ossPut(`teams/${teamId}/_registry/auth.json`, {
    schemaVersion: 1,
    teamSecretHash,
    ownerNodeId,
    createdAt,
  });

  // Write team.json
  await ossPut(`teams/${teamId}/_meta/team.json`, {
    schemaVersion: 1,
    teamId,
    teamName,
    ownerName,
    ownerEmail,
    ownerNodeId,
    createdAt,
  });

  console.log(`[register] Created team teamId=${teamId} nodeId=${ownerNodeId}`);

  const policy = ownerPolicy(teamId, ownerNodeId);
  const credentials = await assumeRole(`owner-${ownerNodeId}`, policy);

  return json(200, {
    teamId,
    credentials,
    oss: ossInfo(),
    role: "owner",
  });
}

async function handleToken(body) {
  const { teamId, teamSecret, nodeId } = body;
  if (!teamId || !teamSecret || !nodeId) {
    return json(400, { error: "Missing required fields" });
  }

  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return json(404, { error: "Team not found" });
  }

  if (sha256(teamSecret) !== auth.teamSecretHash) {
    console.log(`[token] Secret mismatch for teamId=${teamId} nodeId=${nodeId}`);
    return json(403, { error: "Invalid team secret" });
  }

  const isOwner = nodeId === auth.ownerNodeId;
  const role = isOwner ? "owner" : "member";
  const policy = isOwner
    ? ownerPolicy(teamId, nodeId)
    : memberPolicy(teamId, nodeId);
  const sessionName = `${role}-${nodeId}`;
  const credentials = await assumeRole(sessionName, policy);

  console.log(`[token] Issued ${role} token for teamId=${teamId} nodeId=${nodeId}`);

  return json(200, { credentials, oss: ossInfo(), role });
}

async function handleResetSecret(body) {
  const { teamId, oldSecret, newSecret, ownerNodeId } = body;
  if (!teamId || !oldSecret || !newSecret || !ownerNodeId) {
    return json(400, { error: "Missing required fields" });
  }

  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return json(404, { error: "Team not found" });
  }

  if (sha256(oldSecret) !== auth.teamSecretHash) {
    console.log(`[reset-secret] Old secret mismatch for teamId=${teamId}`);
    return json(403, { error: "Invalid old secret" });
  }

  if (ownerNodeId !== auth.ownerNodeId) {
    console.log(`[reset-secret] Owner mismatch for teamId=${teamId}`);
    return json(403, { error: "Only the owner can reset the secret" });
  }

  auth.teamSecretHash = sha256(newSecret);
  await ossPut(`teams/${teamId}/_registry/auth.json`, auth);

  console.log(`[reset-secret] Secret updated for teamId=${teamId}`);
  return json(200, { success: true });
}

// ---------------------------------------------------------------------------
// FC HTTP handler
// ---------------------------------------------------------------------------
export async function handler(event, context) {
  const { path, httpMethod, body: rawBody, headers } = event;

  // Rate limiting
  const ip =
    headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    headers?.["x-real-ip"] ||
    "unknown";
  if (isRateLimited(ip)) {
    return json(429, { error: "Too many requests" });
  }

  if (httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody || {};
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  try {
    switch (path) {
      case "/register":
        return await handleRegister(body);
      case "/token":
        return await handleToken(body);
      case "/reset-secret":
        return await handleResetSecret(body);
      default:
        return json(404, { error: "Not found" });
    }
  } catch (err) {
    console.error(`[error] ${path}:`, err.message);
    return json(500, { error: "Internal server error" });
  }
}
