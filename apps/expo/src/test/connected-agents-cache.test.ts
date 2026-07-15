import { describe, expect, it } from "vitest";

import { createConnectedAgentsCache } from "../features/actors/connected-agents-cache";

function fakeDb() {
  const rows: any[] = [];
  return {
    rows,
    async runAsync(sql: string, ...params: unknown[]) {
      if (/^DELETE FROM connected_agents WHERE team_id = \?/i.test(sql)) {
        const [teamId] = params;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].team_id === teamId) rows.splice(i, 1);
        return;
      }
      if (/^INSERT INTO connected_agents/i.test(sql)) {
        const [
          team_id, agent_id, display_name, agent_types, default_agent_type, permission_level,
          visibility, is_owner, device_id, last_active_at, current_model,
          status, updated_at,
        ] = params;
        rows.push({ team_id, agent_id, display_name, agent_types, default_agent_type, permission_level,
          visibility, is_owner, device_id, last_active_at, current_model, status, updated_at });
        return;
      }
      throw new Error("unhandled: " + sql);
    },
    async getAllAsync(_sql: string, ...params: unknown[]) {
      return rows.filter((r) => r.team_id === params[0]);
    },
  };
}

describe("connected-agents cache", () => {
  it("saveCache replaces all rows for a team", async () => {
    const db = fakeDb();
    const cache = createConnectedAgentsCache(db as any);
    await cache.saveCache("t1", [
      { agentId: "a1", displayName: "Claude", agentTypes: ["claude"],
        defaultAgentType: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        lastActiveAt: "2026-05-20T10:00:00.000Z" },
    ]);
    expect(db.rows.length).toBe(1);
    await cache.saveCache("t1", []);
    expect(db.rows.length).toBe(0);
  });
});
