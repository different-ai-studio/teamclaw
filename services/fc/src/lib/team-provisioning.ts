// services/fc/lib/team-provisioning.mjs
//
// Shared LiteLLM provisioning used by POST /v1/teams. Every team gets a
// LiteLLM team + default key + ai_gateway_endpoint. If LITELLM_MASTER_KEY is
// not configured (local dev, tests), provisioning is skipped and the team is
// created without AI credentials.

// LITELLM_URL is imported rather than redeclared: it used to be duplicated here
// with its own hosted fallback, so the two copies could disagree about where
// traffic goes. One definition, one behaviour (fail closed — see litellm.ts).
import { keyInfo, litellmFetch as sharedLitellmFetch, LITELLM_URL } from './litellm.js';
import { ApiError } from './http-utils.js';

const LITELLM_MASTER_KEY = () => process.env.LITELLM_MASTER_KEY || '';
const AI_GATEWAY_ENDPOINT = () => process.env.AI_GATEWAY_ENDPOINT || (LITELLM_URL() + '/v1');

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

async function litellmFetch(path, method, body) {
  const url = `${LITELLM_URL()}${path}`;
  const opts: any = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LITELLM_MASTER_KEY()}`,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw Object.assign(new Error(`LiteLLM ${path} → ${res.status}`), { status: res.status, data });
  }
  return data;
}

/**
 * Provision a LiteLLM team + default key for a new TeamClaw team.
 * Returns null when LITELLM_MASTER_KEY is not configured (skip provisioning).
 *
 * @param {string} teamName
 * @returns {Promise<null | { litellmTeamId: string, litellmKey: string, aiGatewayEndpoint: string }>}
 */
export async function provisionTeamLiteLLM(teamName) {
  if (!LITELLM_MASTER_KEY()) {
    console.warn('[team-provisioning] LITELLM_MASTER_KEY not set — skipping LiteLLM provisioning');
    return null;
  }
  const slug = slugify(teamName);
  const teamRes = await litellmFetch('/team/new', 'POST', {
    team_alias: slug,
    max_budget: 1,
    budget_duration: '30d',
  });
  const keyRes = await litellmFetch('/key/generate', 'POST', {
    team_id: teamRes.team_id,
    key_alias: `${slug}-default`,
    max_budget: 0.5,
    budget_duration: '30d',
  });
  return {
    litellmTeamId: teamRes.team_id,
    litellmKey: keyRes.key,
    aiGatewayEndpoint: AI_GATEWAY_ENDPOINT(),
  };
}

/**
 * List the models the LiteLLM gateway is configured to serve.
 *
 * Used by getWorkspaceConfig to surface `llm.models`. We query the gateway's
 * `GET /v1/models` (the OpenAI-compatible model list). Credentials: FC does
 * NOT persist a per-team LiteLLM key (only `litellm_team_id` +
 * `ai_gateway_endpoint` are stored), so this uses the FC-level
 * `LITELLM_MASTER_KEY` — the same credential `provisionTeamLiteLLM` uses. The
 * model catalogue is gateway-wide and identical for all teams, so the master
 * key is the correct (and only available) credential here.
 *
 * Always degrades gracefully: returns [] on any error or missing key/endpoint.
 * Never throws.
 *
 * @param {string} aiGatewayEndpoint  e.g. "https://ai.ucar.cc/v1"
 * @param {string} key                bearer token (FC master key)
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function fetchLiteLlmModels(aiGatewayEndpoint, key) {
  try {
    if (!aiGatewayEndpoint || !key) return [];
    // aiGatewayEndpoint already ends in /v1 (see AI_GATEWAY_ENDPOINT).
    const base = String(aiGatewayEndpoint).replace(/\/+$/, "");
    const url = `${base}/models`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
      .map((m) => {
        const id = typeof m?.id === "string" ? m.id : null;
        if (!id) return null;
        return { id, name: typeof m?.name === "string" && m.name ? m.name : id };
      })
      .filter((m) => m !== null);
  } catch {
    return [];
  }
}

/**
 * Best-effort registration of the LiteLLM internal user that owns a member key.
 *
 * `/key/generate` accepts a `user_id`, but LiteLLM's docs show both "generate a
 * key for an EXISTING user id" and an explicit `/user/new` → `/key/generate`
 * sequence, and never state what happens for an unknown user_id. Rather than
 * bet member-key provisioning on that ambiguity, we create the user first and
 * ignore the outcome: already-exists is the expected steady state, and any
 * other failure is handled by ensureMemberKeyFor's fallback.
 *
 * `auto_create_key: false` — the caller mints the deterministic `sk-tc-…` key
 * itself; letting LiteLLM mint an extra one would leave an orphan key on the
 * team that shows up in usage as a phantom row.
 *
 * @param {string} actorId
 */
async function ensureLiteLlmUser(actorId) {
  try {
    await sharedLitellmFetch('/user/new', 'POST', {
      user_id: String(actorId),
      auto_create_key: false,
    });
  } catch (e) {
    console.warn('[ensureLiteLlmUser] /user/new skipped:', (e as any)?.message);
  }
}

/**
 * Idempotently ensure a member's LiteLLM virtual key exists in the given
 * LiteLLM team. Key value is deterministic: `sk-tc-${actorId[..40]}`.
 * Returns the key + gateway endpoint. Throws ApiError(503) when master key
 * is not configured (caller decides to swallow or propagate).
 *
 * ATTRIBUTION: the key carries `user_id = actorId` — the FULL actor uuid. This
 * is what usage reporting groups by (LiteLLM_VerificationToken.user_id, joined
 * from LiteLLM_SpendLogs.api_key at read time). `key_alias` still embeds an
 * 8-char actor prefix, but it is a DISPLAY string only: it is lossy, unindexed,
 * and survives nothing — a prior actor-id rebaseline already orphaned every key
 * minted before it, which is why usage showed unresolvable `member-…` rows.
 *
 * Because user_id lives on the key (not on each spend row), backfilling it via
 * /key/update retroactively attributes that key's ENTIRE spend history.
 *
 * @param {string} litellmTeamId
 * @param {string} actorId
 * @returns {Promise<{ key: string, aiGatewayEndpoint: string }>}
 */
export async function ensureMemberKeyFor(litellmTeamId, actorId) {
  if (!LITELLM_MASTER_KEY()) {
    throw new ApiError(503, 'litellm_unavailable', 'LITELLM_MASTER_KEY not configured');
  }
  const keyValue = `sk-tc-${String(actorId).slice(0, 40)}`;
  const info = await keyInfo(keyValue);
  if (info.ok) {
    // Key predates attribution (or was minted by the fallback below): attach the
    // owner now. Best-effort — an un-backfilled key only costs an "unattributed"
    // row in usage, which must never escalate into a failed key handout.
    if (!(info.data as any)?.info?.user_id) {
      await ensureLiteLlmUser(actorId);
      try {
        await sharedLitellmFetch('/key/update', 'POST', {
          key: keyValue,
          user_id: String(actorId),
        });
      } catch (e) {
        console.warn('[ensureMemberKeyFor] user_id backfill skipped:', (e as any)?.message);
      }
    }
    return { key: keyValue, aiGatewayEndpoint: AI_GATEWAY_ENDPOINT() };
  }

  await ensureLiteLlmUser(actorId);
  const body = {
    key: keyValue,
    team_id: litellmTeamId,
    key_alias: `member-${String(actorId).slice(0, 8)}`,
  };
  const gen = await sharedLitellmFetch('/key/generate', 'POST', { ...body, user_id: String(actorId) });
  if (gen.ok || gen.status === 409) {
    return { key: keyValue, aiGatewayEndpoint: AI_GATEWAY_ENDPOINT() };
  }

  // user_id is an attribution nicety; a working key is not. If the gateway
  // rejects the owned form, hand out an unowned key rather than leave the
  // member (or a daemon mid-session) with no LLM credential at all. The row
  // reports as "unattributed" until the backfill path above catches it.
  console.warn('[ensureMemberKeyFor] owned key rejected, retrying unowned:', JSON.stringify(gen.data));
  const plain = await sharedLitellmFetch('/key/generate', 'POST', body);
  if (!plain.ok && plain.status !== 409) {
    throw new ApiError(502, 'litellm_key_generate_failed', JSON.stringify(plain.data));
  }
  return { key: keyValue, aiGatewayEndpoint: AI_GATEWAY_ENDPOINT() };
}

/**
 * Best-effort seed of a newly-created actor's LiteLLM member key.
 *
 * Called right after actor creation (createTeam owner actor, claimInvite
 * member/agent branches) — NEVER inside the DB transaction, so a
 * provisioning failure can't roll back or block signup/invite-claim. No-ops
 * when `litellmTeamId` is falsy (e.g. brand-new team that hasn't run
 * setupLiteLlm yet — the self-service `ensureMemberKey` endpoint covers that
 * case later). Swallows and logs (`console.warn`) any error, including the
 * ApiError(503) `ensureMemberKeyFor` throws when LITELLM_MASTER_KEY is unset.
 *
 * @param {string | null | undefined} litellmTeamId
 * @param {string} actorId
 * @param {(litellmTeamId: string, actorId: string) => Promise<any>} [provision]
 *   Injectable for tests; defaults to `ensureMemberKeyFor`.
 */
export async function seedMemberKey(
  litellmTeamId: string | null | undefined,
  actorId: string,
  provision: (litellmTeamId: string, actorId: string) => Promise<any> = ensureMemberKeyFor,
) {
  if (!litellmTeamId) return;
  try {
    await provision(litellmTeamId, actorId);
  } catch (e) {
    console.warn('[seedMemberKey] member-key provisioning skipped:', (e as any)?.message);
  }
}

/**
 * Best-effort deletion of a removed actor's LiteLLM virtual key. Folded into
 * removeTeamActor (replaces the legacy POST /ai/remove-member endpoint).
 *
 * The key value is deterministic (`sk-tc-${actorId[..40]}`) so no team_id is
 * needed — LiteLLM's /key/delete takes only `{ keys: [value] }`. Swallows and
 * logs (console.warn) any error; never throws, so a LiteLLM outage can never
 * block or fail actor removal.
 *
 * @param {string} actorId
 */
export async function deleteMemberKey(actorId) {
  try {
    const keyValue = `sk-tc-${String(actorId).slice(0, 40)}`;
    await sharedLitellmFetch('/key/delete', 'POST', { keys: [keyValue] });
  } catch (e) {
    console.warn('[deleteMemberKey] LiteLLM key deletion skipped:', (e as any)?.message);
  }
}
