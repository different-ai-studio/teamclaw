import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { json } from "./responses.js";
import { sha256, ossGet, ossPut, ossInfo, verifyTeam } from "./oss-store.js";
import {
  assumeRole,
  memberPolicy,
  editorPolicy,
  managerPolicy,
  ownerPolicy,
} from "./sts.js";
import { litellmFetch, LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD } from "./litellm.js";
import {
  codeupFetch,
  CODEUP_ORG_ID,
  CODEUP_PAT,
  CODEUP_BOT_USERNAME,
} from "./codeup.js";

// Re-exported for pg-repo/apps.ts and supabase-repo.ts (managed-git provisioning).
export { managedGitCredential } from "./codeup.js";
import { dispatchPush } from "./push-dispatch.js";
import { pushDeps } from "./push-deps.js";

// Re-exported for index.ts (push webhook wiring) and any legacy importers.
export { json } from "./responses.js";
export { pushDeps, pgPushDeps } from "./push-deps.js";

const PUSH_WEBHOOK_SECRET = () => process.env.PUSH_WEBHOOK_SECRET || '';

// ---------------------------------------------------------------------------
// Route handlers
//
// These are intentionally thin: each parses/validates its request body, then
// orchestrates the OSS team registry (oss-store), STS credential minting (sts),
// the LiteLLM proxy (litellm), CodeUp managed git (codeup), or push dispatch
// (push-deps + push-dispatch). All infra lives in those modules.
// ---------------------------------------------------------------------------
export async function handleRegister(body: any) {
  // ownerActorId is the owner's actor_id (the value used to seed OSS/LiteLLM).
  // Accept legacy ownerNodeId as a fallback.
  const { teamSecret, teamName, ownerName, ownerEmail } = body;
  const ownerNodeId = body.ownerActorId ?? body.ownerNodeId;
  if (!teamSecret || !ownerNodeId || !teamName) {
    return json(400, { error: "Missing required fields" });
  }

  const teamId = nanoid();
  const createdAt = new Date().toISOString();
  const teamSecretHash = sha256(teamSecret);

  await ossPut(`teams/${teamId}/_registry/auth.json`, {
    schemaVersion: 1,
    teamSecretHash,
    ownerNodeId,
    createdAt,
  });

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

export async function handleToken(body: any) {
  // nodeId carries the caller's actor_id (legacy field name kept on the wire).
  const { teamId, teamSecret } = body;
  const nodeId = body.actorId ?? body.nodeId;
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

  if (!isOwner) {
    const manifest = await ossGet(`teams/${teamId}/_meta/members.json`);
    if (manifest) {
      const member = manifest.members?.find((m: any) => (m.nodeId ?? m.node_id) === nodeId);
      if (member?.role === "manager") {
        role = member.role;
        policy = managerPolicy(teamId, nodeId);
      } else if (member?.role === "editor") {
        role = member.role;
        policy = editorPolicy(teamId, nodeId);
      }
    }
  }

  const hashedId = createHash("sha256").update(nodeId).digest("hex").slice(0, 16);
  const sessionName = `${role}-${hashedId}`;
  const credentials = await assumeRole(sessionName, policy);

  console.log(`[token] Issued ${role} token for teamId=${teamId} nodeId=${nodeId}`);

  return json(200, { credentials, oss: ossInfo(), role });
}

export async function handleResetSecret(body: any) {
  const { teamId, oldSecret, newSecret } = body;
  const ownerNodeId = body.ownerActorId ?? body.ownerNodeId;
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

export async function handleApply(body: any) {
  const { teamId, teamSecret, name, email, note, platform, arch, hostname } = body;
  const nodeId = body.actorId ?? body.nodeId;
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

export async function handleManagedGitSetupLitellm(body: any) {
  // ownerActorId is the owner's actor_id; the owner LiteLLM key is seeded from
  // it (sk-tc-{actor_id[..40]}) to match the desktop runtime token.
  const { teamId, teamSecret, teamName, ownerName } = body;
  const ownerNodeId = body.ownerActorId ?? body.ownerNodeId;
  if (!teamId || !teamSecret || !ownerNodeId) {
    return json(400, { error: "Missing teamId, teamSecret, or ownerActorId" });
  }

  const teamSecretHash = sha256(teamSecret);
  const existing = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (existing) {
    if (existing.teamSecretHash !== teamSecretHash) {
      return json(403, { error: "Team already registered with different secret" });
    }
  } else {
    const createdAt = new Date().toISOString();
    await ossPut(`teams/${teamId}/_registry/auth.json`, {
      schemaVersion: 1,
      teamSecretHash,
      ownerNodeId,
      createdAt,
    });
    await ossPut(`teams/${teamId}/_meta/team.json`, {
      schemaVersion: 1,
      teamId,
      teamName: teamName || teamId,
      ownerName: ownerName || "",
      ownerNodeId,
      createdAt,
    });
    console.log(`[managed-git/setup-litellm] Registered teamId=${teamId} owner=${ownerNodeId.slice(0, 8)}`);
  }

  const litellmTeamId = `tc-${teamId}`;
  const maxBudget = LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD();
  const teamRes = await litellmFetch("/team/new", "POST", {
    team_id: litellmTeamId,
    team_alias: teamName || teamId,
    max_budget: maxBudget,
  });
  if (!teamRes.ok && teamRes.status !== 409) {
    console.error(`[managed-git/setup-litellm] team/new error:`, teamRes.data);
    return json(502, { error: "Failed to create LiteLLM team", detail: teamRes.data });
  }

  const keyAlias = `${ownerName || "owner"}-${ownerNodeId.slice(0, 8)}`;
  const keyValue = `sk-tc-${ownerNodeId.slice(0, 40)}`;
  const keyRes = await litellmFetch("/key/generate", "POST", {
    key: keyValue,
    team_id: litellmTeamId,
    key_alias: keyAlias,
  });
  if (!keyRes.ok) {
    console.error(`[managed-git/setup-litellm] key/generate error:`, keyRes.data);
    return json(502, { error: "Failed to create owner key", detail: keyRes.data });
  }

  console.log(
    `[managed-git/setup-litellm] team=${litellmTeamId} owner=${ownerNodeId.slice(0, 8)} max_budget_usd=${maxBudget}`
  );
  return json(200, {
    success: true,
    litellmTeamId,
    key: keyValue,
    keyAlias,
    maxBudgetUsd: maxBudget,
  });
}

export async function handleManagedGitCreateRepo(body: any) {
  // The desktop client only has the (globally unique) team id on hand, so the
  // repo name is derived from `teamId` — this also guarantees uniqueness and
  // avoids 409 name-collision races between teams that picked the same name.
  // `teamName` is optional and only used for the human-readable description.
  const { teamId, teamName, appId } = body;
  if (!teamId) {
    return json(400, { error: "Missing teamId" });
  }

  const orgId = CODEUP_ORG_ID();
  const pat = CODEUP_PAT();
  const botUsername = CODEUP_BOT_USERNAME();
  if (!orgId || !pat) {
    return json(500, { error: "Managed Git not configured (missing CODEUP_ORG_ID or CODEUP_PAT)" });
  }

  const sanitize = (s: string) =>
    String(s).toLowerCase().replace(/[^a-z0-9一-鿿-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  // When an `appId` is supplied, the repo is scoped to a single app
  // (`tc-app-{appId}`); otherwise it falls back to the per-team repo
  // (`tc-{teamId}`). Both names are globally unique, avoiding 409 races.
  const repoName = appId ? `tc-app-${sanitize(appId)}` : `tc-${sanitize(teamId)}`;

  const res = await codeupFetch(
    `/oapi/v1/codeup/organizations/${orgId}/repositories`,
    "POST",
    {
      name: repoName,
      path: repoName,
      visibility: "private",
      description: `TeamClaw managed team repo: ${teamName || teamId}`,
    }
  );

  if (!res.ok) {
    if (res.status === 409) {
      console.error(`[managed-git] Repo name conflict: ${repoName}`);
      return json(409, { error: "Managed git repo already exists for this team" });
    }
    console.error(`[managed-git] CodeUp error:`, res.data);
    return json(502, { error: "Failed to create repository", detail: res.data });
  }

  const repoHttpUrl = (res.data as any).httpUrlToRepo;
  console.log(`[managed-git] Created repo ${repoName} → ${repoHttpUrl}`);

  return json(200, {
    repoHttpUrl,
    pat,
    botUsername,
  });
}

export async function handlePushDispatch(headers: Record<string, string> | undefined, body: any) {
  if (headers?.['x-webhook-secret'] !== PUSH_WEBHOOK_SECRET()) {
    return json(401, { error: 'Unauthorized' });
  }
  if (body.type !== 'INSERT' || body.table !== 'messages') {
    return json(200, { skipped: 'not_a_message_insert' });
  }
  try {
    const result = await dispatchPush(body.record, pushDeps());
    return json(200, result);
  } catch (err: any) {
    console.error('[push] dispatch error', err);
    return json(500, { error: String(err.message || err) });
  }
}
