import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRange, isValidRange, resolveLiteLlmConnString } from "../src/lib/litellm-usage.js";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";

// All boundaries are CST (UTC+8) wall-clock midnights expressed back in UTC.
// CST midnight = previous day 16:00 UTC.

test("computeRange day: anchor's CST day, [16:00Z prev, 16:00Z]", () => {
  const r = computeRange("day", "2026-06-10T03:00:00Z"); // 11:00 CST Jun 10
  assert.equal(r.range, "day");
  assert.equal(r.startDate, "2026-06-10");
  assert.equal(r.endDate, "2026-06-10");
  assert.equal(r.startUtc, "2026-06-09T16:00:00.000Z");
  assert.equal(r.endUtc, "2026-06-10T16:00:00.000Z");
});

test("computeRange day rolls to next CST day for late-UTC anchor", () => {
  // 2026-06-09T17:00Z = 2026-06-10 01:00 CST → CST day is Jun 10.
  const r = computeRange("day", "2026-06-09T17:00:00Z");
  assert.equal(r.startDate, "2026-06-10");
});

test("computeRange week: Monday-start", () => {
  // 2026-06-10 is a Wednesday → week is Mon Jun 8 .. Sun Jun 14.
  const r = computeRange("week", "2026-06-10T03:00:00Z");
  assert.equal(r.startDate, "2026-06-08");
  assert.equal(r.endDate, "2026-06-14");
  assert.equal(r.startUtc, "2026-06-07T16:00:00.000Z");
  assert.equal(r.endUtc, "2026-06-14T16:00:00.000Z");
});

test("computeRange week: anchor on Monday stays same week", () => {
  const r = computeRange("week", "2026-06-08T12:00:00Z");
  assert.equal(r.startDate, "2026-06-08");
});

test("computeRange week: anchor on Sunday belongs to that week", () => {
  // 2026-06-14 is Sunday → week Mon Jun 8 .. Sun Jun 14.
  const r = computeRange("week", "2026-06-14T03:00:00Z");
  assert.equal(r.startDate, "2026-06-08");
  assert.equal(r.endDate, "2026-06-14");
});

test("computeRange month: full CST month", () => {
  const r = computeRange("month", "2026-06-10T03:00:00Z");
  assert.equal(r.startDate, "2026-06-01");
  assert.equal(r.endDate, "2026-06-30");
  assert.equal(r.startUtc, "2026-05-31T16:00:00.000Z");
  assert.equal(r.endUtc, "2026-06-30T16:00:00.000Z");
});

test("computeRange year: full CST year", () => {
  const r = computeRange("year", "2026-06-10T03:00:00Z");
  assert.equal(r.startDate, "2026-01-01");
  assert.equal(r.endDate, "2026-12-31");
  assert.equal(r.startUtc, "2025-12-31T16:00:00.000Z");
  assert.equal(r.endUtc, "2026-12-31T16:00:00.000Z");
});

test("computeRange rejects invalid range", () => {
  assert.throws(() => computeRange("decade" as any), /range must be one of/);
});

test("computeRange rejects bad date", () => {
  assert.throws(() => computeRange("month", "not-a-date"), /ISO date/);
});

test("resolveLiteLlmConnString swaps DATABASE_URL db name to litellm", () => {
  const s = resolveLiteLlmConnString({
    DATABASE_URL: "postgresql://supabase_admin:pw@host.rds:5432/postgres",
  } as NodeJS.ProcessEnv);
  assert.equal(s, "postgresql://supabase_admin:pw@host.rds:5432/litellm");
});

test("resolveLiteLlmConnString honors LITELLM_DB_NAME override", () => {
  const s = resolveLiteLlmConnString({
    DATABASE_URL: "postgresql://u:p@host:5432/postgres",
    LITELLM_DB_NAME: "litellm_prod",
  } as NodeJS.ProcessEnv);
  assert.match(s, /\/litellm_prod$/);
});

test("resolveLiteLlmConnString builds from POSTGRES_* parts", () => {
  const s = resolveLiteLlmConnString({
    POSTGRES_HOST: "host.rds",
    POSTGRES_PORT: "5432",
    POSTGRES_USERNAME: "supabase_admin",
    POSTGRES_PASSWORD: "pw",
  } as NodeJS.ProcessEnv);
  assert.equal(s, "postgresql://supabase_admin:pw@host.rds:5432/litellm");
});

test("resolveLiteLlmConnString prefers explicit LITELLM_DB_URL override", () => {
  const s = resolveLiteLlmConnString({
    LITELLM_DB_URL: "postgresql://ro:x@other:5432/litellm",
    DATABASE_URL: "postgresql://u:p@host:5432/postgres",
  } as NodeJS.ProcessEnv);
  assert.equal(s, "postgresql://ro:x@other:5432/litellm");
});

test("resolveLiteLlmConnString throws 503 when no pg configured", () => {
  assert.throws(() => resolveLiteLlmConnString({} as NodeJS.ProcessEnv), /litellm_usage_unavailable|not configured/);
});

test("isValidRange", () => {
  for (const r of ["day", "week", "month", "year"]) assert.ok(isValidRange(r));
  assert.equal(isValidRange("hour"), false);
  assert.equal(isValidRange(5), false);
});

// ── getLiteLlmUsage reads persisted litellm_team_id (not tc-{teamId}) ───────

// Minimal fake Supabase client covering only what getLiteLlmUsage's call
// chain needs: auth.getUser() (requireCallerTeamMember), a select against
// "actors" (membership check), and a select against "team_workspace_config"
// (the persisted litellm_team_id lookup mirrored from ensureMemberKey).
function fakeSupabaseForUsage({ actorRow, cfgRow }: { actorRow: any; cfgRow: any }) {
  return {
    auth: {
      async getUser() {
        return { data: { user: { id: "user-1" } }, error: null };
      },
    },
    from(table: string) {
      if (table === "actors") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return { maybeSingle: async () => ({ data: actorRow, error: null }) };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "team_workspace_config") {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: cfgRow, error: null }) };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function makeUsageRepo({ cfgRow, queryLiteLlmUsageImpl }: { cfgRow: any; queryLiteLlmUsageImpl: (...args: any[]) => any }) {
  const supabase = fakeSupabaseForUsage({ actorRow: { id: "actor-1" }, cfgRow });
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    queryLiteLlmUsage: queryLiteLlmUsageImpl,
  });
}

test("getLiteLlmUsage queries the persisted litellm_team_id, not tc-{teamId}", async () => {
  const calls: Array<{ litellmTeamId: string }> = [];
  const repo = makeUsageRepo({
    cfgRow: { litellm_team_id: "litellm-generated-x" },
    queryLiteLlmUsageImpl: async (litellmTeamId: string, range: any) => {
      calls.push({ litellmTeamId });
      return { litellmTeamId, range: range.range, summary: {}, members: [], byModel: [] };
    },
  });

  const result = await repo.getLiteLlmUsage("team-abc");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].litellmTeamId, "litellm-generated-x");
  assert.notEqual(calls[0].litellmTeamId, "tc-team-abc");
  assert.equal(result.litellmTeamId, "litellm-generated-x");
});

test("getLiteLlmUsage returns empty usage and skips the LiteLLM query when litellm_team_id is unset", async () => {
  let queryCalled = false;
  const repo = makeUsageRepo({
    cfgRow: null,
    queryLiteLlmUsageImpl: async () => {
      queryCalled = true;
      throw new Error("queryLiteLlmUsage must not be called when litellm_team_id is unset");
    },
  });

  const result = await repo.getLiteLlmUsage("team-never-provisioned");

  assert.equal(queryCalled, false, "queryLiteLlmUsage must not be invoked");
  assert.equal(result.litellmTeamId, null);
  assert.deepEqual(result.members, []);
  assert.deepEqual(result.byModel, []);
  assert.equal(result.summary.totalSpend, 0);
  assert.equal(result.summary.totalTokens, 0);
  assert.equal(result.summary.promptTokens, 0);
  assert.equal(result.summary.completionTokens, 0);
  assert.equal(result.summary.requestCount, 0);
  assert.equal(result.maxBudget, null);
  assert.equal(typeof result.range, "string");
  assert.equal(typeof result.startDate, "string");
  assert.equal(typeof result.endDate, "string");
});
