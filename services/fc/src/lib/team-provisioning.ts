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
 * Idempotently ensure a member's LiteLLM virtual key exists in the given
 * LiteLLM team. Key value is deterministic: `sk-tc-${actorId[..40]}`.
 * Returns the key + gateway endpoint. Throws ApiError(503) when master key
 * is not configured (caller decides to swallow or propagate).
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
    return { key: keyValue, aiGatewayEndpoint: AI_GATEWAY_ENDPOINT() };
  }
  const gen = await sharedLitellmFetch('/key/generate', 'POST', {
    key: keyValue,
    team_id: litellmTeamId,
    key_alias: `member-${String(actorId).slice(0, 8)}`,
  });
  if (!gen.ok && gen.status !== 409) {
    throw new ApiError(502, 'litellm_key_generate_failed', JSON.stringify(gen.data));
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
