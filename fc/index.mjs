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

// LiteLLM proxy
const LITELLM_URL = () => process.env.LITELLM_URL || "https://ai.ucar.cc";
const LITELLM_MASTER_KEY = () => process.env.LITELLM_MASTER_KEY || "";

/** Default team max spend (USD) applied on POST /ai/setup-team → LiteLLM /team/new */
const LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD = () => {
  const raw = process.env.LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
};

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
    forcePathStyle: false,
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
        Action: ["oss:GetObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:ListObjects"],
        Resource: `acs:oss:*:*:${BUCKET()}`,
        Condition: { StringLike: { "oss:Prefix": [`teams/${teamId}/*`] } },
      },
      {
        Effect: "Deny",
        Action: ["oss:GetObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_registry/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:PutObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/updates/${nodeId}/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:PutObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/signal/${nodeId}/*`,
      },
    ],
  });
}

function editorPolicy(teamId, nodeId) {
  const base = JSON.parse(memberPolicy(teamId, nodeId));
  // Compaction: upload snapshots + generation signal
  base.Statement.push(
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/generation.json`,
    },
    // Compaction cleanup: old updates, snapshots, and legacy snapshot/
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/updates/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshot/*`,
    }
  );
  return JSON.stringify(base);
}

function managerPolicy(teamId, nodeId) {
  const base = JSON.parse(editorPolicy(teamId, nodeId));
  // Managers can update team metadata (members.json, etc.)
  base.Statement.push({
    Effect: "Allow",
    Action: ["oss:PutObject"],
    Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_meta/*`,
  });
  return JSON.stringify(base);
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
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshot/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/generation.json`,
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
  const hashedId = createHash("sha256").update(ownerNodeId).digest("hex").slice(0, 16);
  const credentials = await assumeRole(`owner-${hashedId}`, policy);

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
  let role = isOwner ? "owner" : "member";
  let policy = isOwner
    ? ownerPolicy(teamId, nodeId)
    : memberPolicy(teamId, nodeId);

  // Check members manifest so editors/managers get compaction permissions
  if (!isOwner) {
    const manifest = await ossGet(`teams/${teamId}/_meta/members.json`);
    if (manifest) {
      const member = manifest.members?.find((m) => (m.nodeId ?? m.node_id) === nodeId);
      if (member?.role === "manager") {
        role = member.role;
        policy = managerPolicy(teamId, nodeId);
      } else if (member?.role === "editor") {
        role = member.role;
        policy = editorPolicy(teamId, nodeId);
      }
    }
  }

  // RoleSessionName max 32 chars, alphanumeric + '-_.'
  const hashedId = createHash("sha256").update(nodeId).digest("hex").slice(0, 16);
  const sessionName = `${role}-${hashedId}`;
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

async function handleApply(body) {
  const { teamId, teamSecret, nodeId, name, email, note, platform, arch, hostname } = body;
  if (!teamId || !teamSecret || !nodeId || !name || !email) {
    return json(400, { error: "Missing required fields" });
  }

  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return json(404, { error: "Team not found" });
  }

  if (sha256(teamSecret) !== auth.teamSecretHash) {
    console.log(`[apply] Secret mismatch for teamId=${teamId} nodeId=${nodeId}`);
    return json(403, { error: "Invalid team secret" });
  }

  const application = {
    nodeId,
    name,
    email,
    note: note || "",
    platform: platform || "",
    arch: arch || "",
    hostname: hostname || "",
    appliedAt: new Date().toISOString(),
  };

  await ossPut(`teams/${teamId}/_meta/applications/${nodeId}.json`, application);

  console.log(`[apply] Application submitted for teamId=${teamId} nodeId=${nodeId}`);
  return json(200, { success: true });
}

// ---------------------------------------------------------------------------
// LiteLLM helpers
// ---------------------------------------------------------------------------
async function litellmFetch(path, method, body) {
  const url = `${LITELLM_URL()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER_KEY()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

/**
 * Verify teamSecret and optionally check owner identity.
 * Returns { auth, isOwner } or a json error response.
 */
async function verifyTeam(teamId, teamSecret, requireOwnerNodeId) {
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
  return { auth, isOwner: (nodeId) => nodeId === auth.ownerNodeId };
}

// ---------------------------------------------------------------------------
// LiteLLM route handlers
// ---------------------------------------------------------------------------

/** POST /ai/setup-team — create a LiteLLM team for this teamclaw team */
async function handleAiSetupTeam(body) {
  const { teamId, teamSecret, teamName } = body;
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const maxBudget = LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD();
  const res = await litellmFetch("/team/new", "POST", {
    team_id: litellmTeamId,
    team_alias: teamName || teamId,
    max_budget: maxBudget,
  });

  if (!res.ok && res.status !== 409) {
    console.error(`[ai/setup-team] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to create LiteLLM team", detail: res.data });
  }

  console.log(
    `[ai/setup-team] Created LiteLLM team ${litellmTeamId} max_budget_usd=${maxBudget}`
  );
  return json(200, {
    success: true,
    litellmTeamId,
    maxBudgetUsd: maxBudget,
  });
}

/** POST /ai/add-member — create a LiteLLM API key for a team member */
async function handleAiAddMember(body) {
  const { teamId, teamSecret, nodeId, memberName } = body;
  if (!nodeId) return json(400, { error: "Missing nodeId" });
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const keyAlias = `${memberName || "member"}-${nodeId.slice(0, 8)}`;
  const keyValue = `sk-tc-${nodeId.slice(0, 40)}`;

  const res = await litellmFetch("/key/generate", "POST", {
    key: keyValue,
    team_id: litellmTeamId,
    key_alias: keyAlias,
  });

  if (!res.ok) {
    console.error(`[ai/add-member] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to create LiteLLM key", detail: res.data });
  }

  console.log(`[ai/add-member] Created key for ${nodeId.slice(0, 8)} in team ${litellmTeamId}`);
  return json(200, { success: true, key: keyValue, keyAlias });
}

/** POST /ai/remove-member — delete a member's LiteLLM API key */
async function handleAiRemoveMember(body) {
  const { teamId, teamSecret, ownerNodeId, nodeId } = body;
  if (!nodeId) return json(400, { error: "Missing nodeId" });
  const v = await verifyTeam(teamId, teamSecret, ownerNodeId);
  if (v.error) return v.error;

  // Find the key by alias pattern
  const keyValue = `sk-tc-${nodeId.slice(0, 40)}`;
  const res = await litellmFetch("/key/delete", "POST", { keys: [keyValue] });

  if (!res.ok) {
    console.error(`[ai/remove-member] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to delete LiteLLM key", detail: res.data });
  }

  console.log(`[ai/remove-member] Deleted key for ${nodeId.slice(0, 8)}`);
  return json(200, { success: true });
}

/** POST /ai/keys — list all LiteLLM keys for this team */
async function handleAiKeys(body) {
  const { teamId, teamSecret } = body;
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const res = await litellmFetch(`/team/info?team_id=${litellmTeamId}`, "GET");

  if (!res.ok) {
    console.error(`[ai/keys] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to fetch team info", detail: res.data });
  }

  const keys = (res.data.keys || []).map((k) => ({
    key: k.token ? `${k.token.slice(0, 10)}...` : "",
    alias: k.key_alias || "",
    spend: k.spend || 0,
    created_at: k.created_at || "",
  }));

  return json(200, { teamId: litellmTeamId, keys });
}

/** POST /ai/usage — get team or individual spend and usage.
 *  - Any member can query their own usage by passing their nodeId.
 *  - Owner can query any member's usage or omit nodeId for team-wide view.
 */
async function handleAiUsage(body) {
  const { teamId, teamSecret, nodeId, startDate, endDate } = body;
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const end = endDate || new Date().toISOString().slice(0, 10);

  // If nodeId is provided, query individual key spend
  if (nodeId) {
    const keyValue = `sk-tc-${nodeId.slice(0, 40)}`;
    const keyRes = await litellmFetch(
      `/key/info`,
      "POST",
      { key: keyValue }
    );

    if (!keyRes.ok) {
      console.error(`[ai/usage] LiteLLM key/info error:`, keyRes.data);
      return json(502, { error: "Failed to fetch key info", detail: keyRes.data });
    }

    const info = keyRes.data.info || keyRes.data;
    return json(200, {
      teamId: litellmTeamId,
      nodeId,
      startDate: start,
      endDate: end,
      spend: info.spend || 0,
      maxBudget: info.max_budget || null,
      keyAlias: info.key_alias || "",
    });
  }

  // Team-wide usage (all members)
  // First get all keys for the team to show per-member breakdown
  const teamRes = await litellmFetch(`/team/info?team_id=${litellmTeamId}`, "GET");

  const members = [];
  let totalSpend = 0;
  if (teamRes.ok) {
    for (const k of teamRes.data.keys || []) {
      const spend = k.spend || 0;
      totalSpend += spend;
      members.push({
        alias: k.key_alias || "",
        spend,
      });
    }
  }

  return json(200, {
    teamId: litellmTeamId,
    startDate: start,
    endDate: end,
    totalSpend,
    members,
  });
}

/** POST /ai/budget — set team budget (owner only) */
async function handleAiBudget(body) {
  const { teamId, teamSecret, ownerNodeId, maxBudget } = body;
  const v = await verifyTeam(teamId, teamSecret, ownerNodeId);
  if (v.error) return v.error;

  if (maxBudget === undefined || maxBudget === null) {
    return json(400, { error: "Missing maxBudget" });
  }

  const litellmTeamId = `tc-${teamId}`;
  const res = await litellmFetch("/team/update", "POST", {
    team_id: litellmTeamId,
    max_budget: Number(maxBudget),
  });

  if (!res.ok) {
    console.error(`[ai/budget] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to update budget", detail: res.data });
  }

  console.log(`[ai/budget] Set budget $${maxBudget} for team ${litellmTeamId}`);
  return json(200, { success: true, maxBudget: Number(maxBudget) });
}

// ---------------------------------------------------------------------------
// FC HTTP handler
// ---------------------------------------------------------------------------
export async function handler(event, context) {
  // FC 3.0 HTTP trigger passes a Buffer, parse it first
  if (Buffer.isBuffer(event)) {
    event = JSON.parse(event.toString());
  } else if (typeof event === "string") {
    event = JSON.parse(event);
  }
  // Support both FC 2.0 and FC 3.0 event formats
  const path = event.rawPath || event.path;
  const httpMethod =
    event.requestContext?.http?.method || event.httpMethod;
  const rawBody = event.body;
  const headers = event.headers;

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
      case "/apply":
        return await handleApply(body);
      case "/ai/setup-team":
        return await handleAiSetupTeam(body);
      case "/ai/add-member":
        return await handleAiAddMember(body);
      case "/ai/remove-member":
        return await handleAiRemoveMember(body);
      case "/ai/keys":
        return await handleAiKeys(body);
      case "/ai/usage":
        return await handleAiUsage(body);
      case "/ai/budget":
        return await handleAiBudget(body);
      default:
        return json(404, { error: "Not found" });
    }
  } catch (err) {
    console.error(`[error] ${path}:`, err.message, err.name, err.Code, err.$metadata);
    return json(500, { error: "Internal server error" });
  }
}
