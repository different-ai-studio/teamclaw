// LiteLLM usage queries — reads the (migrated) LiteLLM Postgres directly to
// produce per-team token + spend aggregates that the open-source LiteLLM HTTP
// API cannot give (per-team token counts require the enterprise /spend/report).
//
// Data source: the `LiteLLM_SpendLogs` table (one row per request) keyed by
// `team_id = tc-{teamClawTeamId}`, with `total_tokens` / `spend` / `startTime`.
// See docs/specs/2026-06-15-litellm-token-usage-rds-design.md.
//
// FC reads via a SELECT-only role; connection string in env `LITELLM_DB_URL`.

import postgres from "postgres";
import { ApiError } from "./http-utils.js";

export type UsageRange = "day" | "week" | "month" | "year";

const VALID_RANGES = new Set<UsageRange>(["day", "week", "month", "year"]);

// LiteLLM stores startTime in UTC. The product reports usage in Asia/Shanghai
// (fixed UTC+8, no DST), so we compute the wall-clock period in CST then shift
// to UTC for filtering.
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

export type ComputedRange = {
  range: UsageRange;
  /** UTC ISO of the inclusive period start. */
  startUtc: string;
  /** UTC ISO of the exclusive period end. */
  endUtc: string;
  /** CST calendar date the period starts on (yyyy-mm-dd). */
  startDate: string;
  /** CST calendar date of the last day in the period (yyyy-mm-dd). */
  endDate: string;
};

export function isValidRange(value: unknown): value is UsageRange {
  return typeof value === "string" && VALID_RANGES.has(value as UsageRange);
}

/**
 * Compute the UTC [start, end) window for a CST-anchored period.
 *
 * @param range  day | week (Mon-start) | month | year
 * @param anchorIso  optional `yyyy-mm-dd` (or full ISO) selecting which period;
 *                   the period CONTAINING this date is returned. Defaults to now.
 */
export function computeRange(range: UsageRange, anchorIso?: string): ComputedRange {
  if (!isValidRange(range)) {
    throw new ApiError(400, "validation_failed", `range must be one of ${[...VALID_RANGES].join(", ")}`);
  }

  // Anchor instant. Shift into the CST frame so getUTC* reads CST wall-clock.
  const anchorMs = anchorIso ? Date.parse(anchorIso) : Date.now();
  if (Number.isNaN(anchorMs)) {
    throw new ApiError(400, "validation_failed", "date must be an ISO date (yyyy-mm-dd)");
  }
  const cst = new Date(anchorMs + CST_OFFSET_MS);
  const y = cst.getUTCFullYear();
  const m = cst.getUTCMonth();
  const d = cst.getUTCDate();

  // CST wall-clock period boundaries expressed as UTC-epoch of that CST midnight.
  let startCstMidnight: number;
  let endCstMidnight: number;
  switch (range) {
    case "day": {
      startCstMidnight = Date.UTC(y, m, d);
      endCstMidnight = Date.UTC(y, m, d + 1);
      break;
    }
    case "week": {
      // Monday as week start. getUTCDay: 0=Sun..6=Sat.
      const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
      const mondayDelta = (dow + 6) % 7; // days since Monday
      startCstMidnight = Date.UTC(y, m, d - mondayDelta);
      endCstMidnight = Date.UTC(y, m, d - mondayDelta + 7);
      break;
    }
    case "month": {
      startCstMidnight = Date.UTC(y, m, 1);
      endCstMidnight = Date.UTC(y, m + 1, 1);
      break;
    }
    case "year": {
      startCstMidnight = Date.UTC(y, 0, 1);
      endCstMidnight = Date.UTC(y + 1, 0, 1);
      break;
    }
  }

  // CST midnight (UTC-epoch above) minus the offset = the real UTC instant.
  const startUtcMs = startCstMidnight - CST_OFFSET_MS;
  const endUtcMs = endCstMidnight - CST_OFFSET_MS;
  const dateOf = (cstMidnight: number) => new Date(cstMidnight).toISOString().slice(0, 10);

  return {
    range,
    startUtc: new Date(startUtcMs).toISOString(),
    endUtc: new Date(endUtcMs).toISOString(),
    startDate: dateOf(startCstMidnight),
    endDate: dateOf(endCstMidnight - 86400000),
  };
}

export type TeamUsageSummary = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalSpend: number;
  requestCount: number;
};

export type MemberUsage = {
  apiKey: string;
  alias: string;
  /**
   * Owning actor uuid, from the key's `user_id` (LiteLLM_VerificationToken).
   * null for keys minted before attribution existed, or whose owner was wiped
   * by an actor-id rebaseline — those aggregate into an "unattributed" bucket
   * rather than being dropped, because the spend is real money either way.
   *
   * NOT parsed out of `alias`: that only carries an 8-char prefix, which is
   * lossy and collision-prone across teams.
   */
  actorId: string | null;
  tokens: number;
  spend: number;
  requests: number;
};

export type ModelUsage = {
  model: string;
  tokens: number;
  spend: number;
  requests: number;
};

export type TeamUsage = {
  litellmTeamId: string;
  range: UsageRange;
  startDate: string;
  endDate: string;
  startUtc: string;
  endUtc: string;
  summary: TeamUsageSummary;
  maxBudget: number | null;
  members: MemberUsage[];
  byModel: ModelUsage[];
};

// postgres.js client type is loose here to keep the dep import optional in tests.
export type LiteLlmSql = ReturnType<typeof postgres>;

let _sql: LiteLlmSql | null = null;

/**
 * Build the LiteLLM connection string. LiteLLM lives in a separate DATABASE
 * (`litellm`, override via LITELLM_DB_NAME) on the SAME Postgres instance the
 * FC already connects to — so we reuse the existing primary connection
 * (DATABASE_URL, or the POSTGRES_* parts) and only swap the database name.
 * No separate LITELLM_DB_URL config is required; set one only as an escape
 * hatch if the LiteLLM db moves to a different instance.
 */
export function resolveLiteLlmConnString(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LITELLM_DB_URL) return env.LITELLM_DB_URL;
  const dbName = env.LITELLM_DB_NAME || "litellm";

  if (env.DATABASE_URL) {
    const u = new URL(env.DATABASE_URL);
    u.pathname = `/${dbName}`;
    return u.toString();
  }

  const host = env.POSTGRES_HOST;
  if (host) {
    const port = env.POSTGRES_PORT || "5432";
    const user = encodeURIComponent(env.POSTGRES_USERNAME || "");
    const pass = encodeURIComponent(env.POSTGRES_PASSWORD || "");
    const auth = user ? `${user}${pass ? `:${pass}` : ""}@` : "";
    return `postgresql://${auth}${host}:${port}/${dbName}`;
  }

  throw new ApiError(
    503,
    "litellm_usage_unavailable",
    "LiteLLM usage is not configured (no DATABASE_URL / POSTGRES_HOST on FC)",
  );
}

/** Lazily build the LiteLLM connection. Throws 503 if no Postgres is configured. */
export function getLiteLlmSql(): LiteLlmSql {
  if (_sql) return _sql;
  const url = resolveLiteLlmConnString();
  _sql = postgres(url, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    // FC is short-lived; keep the pool tiny and prepared statements off so
    // reused connections behave predictably behind RDS proxy.
    prepare: false,
  });
  return _sql;
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Aggregate one team's usage over a UTC window from LiteLLM_SpendLogs.
 *
 * @param sql  postgres.js client (injectable for tests)
 */
export async function queryTeamUsage(
  sql: LiteLlmSql,
  litellmTeamId: string,
  range: ComputedRange,
): Promise<TeamUsage> {
  const { startUtc, endUtc } = range;

  const [summaryRows, memberRows, modelRows, teamRows] = await Promise.all([
    sql`
      SELECT
        COALESCE(SUM(total_tokens), 0)      AS total_tokens,
        COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(spend), 0)             AS total_spend,
        COUNT(*)                            AS request_count
      FROM "LiteLLM_SpendLogs"
      WHERE team_id = ${litellmTeamId}
        AND "startTime" >= ${startUtc} AND "startTime" < ${endUtc}
    `,
    // Attribution comes from v.user_id (the key's owning actor), NOT from
    // s.user: the spend-log column is per-request and blank for everything
    // logged before the key carried an owner, whereas joining the key's own
    // user_id resolves at READ time — so backfilling a key's user_id also
    // re-attributes its whole history.
    sql`
      SELECT
        s.api_key                                            AS api_key,
        COALESCE(v.key_alias, LEFT(s.api_key, 10) || '…')    AS alias,
        NULLIF(v.user_id, '')                                AS actor_id,
        COALESCE(SUM(s.total_tokens), 0)                     AS tokens,
        COALESCE(SUM(s.spend), 0)                            AS spend,
        COUNT(*)                                             AS requests
      FROM "LiteLLM_SpendLogs" s
      LEFT JOIN "LiteLLM_VerificationToken" v ON v.token = s.api_key
      WHERE s.team_id = ${litellmTeamId}
        AND s."startTime" >= ${startUtc} AND s."startTime" < ${endUtc}
      GROUP BY s.api_key, v.key_alias, v.user_id
      ORDER BY spend DESC, tokens DESC
    `,
    sql`
      SELECT
        COALESCE(NULLIF(model_group, ''), model, 'unknown')  AS model,
        COALESCE(SUM(total_tokens), 0)                        AS tokens,
        COALESCE(SUM(spend), 0)                               AS spend,
        COUNT(*)                                              AS requests
      FROM "LiteLLM_SpendLogs"
      WHERE team_id = ${litellmTeamId}
        AND "startTime" >= ${startUtc} AND "startTime" < ${endUtc}
      GROUP BY 1
      ORDER BY spend DESC, tokens DESC
    `,
    sql`SELECT max_budget FROM "LiteLLM_TeamTable" WHERE team_id = ${litellmTeamId} LIMIT 1`,
  ]);

  const s = summaryRows[0] ?? {};
  return {
    litellmTeamId,
    range: range.range,
    startDate: range.startDate,
    endDate: range.endDate,
    startUtc,
    endUtc,
    summary: {
      totalTokens: n(s.total_tokens),
      promptTokens: n(s.prompt_tokens),
      completionTokens: n(s.completion_tokens),
      totalSpend: n(s.total_spend),
      requestCount: n(s.request_count),
    },
    maxBudget: teamRows[0]?.max_budget != null ? n(teamRows[0].max_budget) : null,
    members: memberRows.map((r: any) => ({
      apiKey: String(r.api_key ?? ""),
      alias: String(r.alias ?? ""),
      actorId: r.actor_id != null ? String(r.actor_id) : null,
      tokens: n(r.tokens),
      spend: n(r.spend),
      requests: n(r.requests),
    })),
    byModel: modelRows.map((r: any) => ({
      model: String(r.model ?? "unknown"),
      tokens: n(r.tokens),
      spend: n(r.spend),
      requests: n(r.requests),
    })),
  };
}
