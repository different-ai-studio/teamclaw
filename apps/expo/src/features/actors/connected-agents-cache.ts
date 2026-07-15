import type { ConnectedAgent } from "./connected-agent-types";

export type ConnectedAgentsCacheDb = {
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
};

export type ConnectedAgentsCache = {
  loadCache: (teamId: string) => Promise<ConnectedAgent[]>;
  saveCache: (teamId: string, agents: ConnectedAgent[]) => Promise<void>;
};

export function createConnectedAgentsCache(db: ConnectedAgentsCacheDb): ConnectedAgentsCache {
  return {
    async loadCache(teamId) {
      const rows = await db.getAllAsync(`SELECT * FROM connected_agents WHERE team_id = ?`, teamId);
      return rows.map((r) => ({
        agentId: String(r.agent_id),
        displayName: String(r.display_name),
        agentTypes: typeof r.agent_types === "string" ? JSON.parse(r.agent_types) : [],
        defaultAgentType: r.default_agent_type != null ? String(r.default_agent_type) : null,
        permissionLevel: String(r.permission_level),
        visibility: r.visibility === "personal" ? "personal" : "team",
        isOwner: r.is_owner === 1 || r.is_owner === true,
        lastActiveAt: r.last_active_at != null ? new Date(Number(r.last_active_at)).toISOString() : null,
      }));
    },
    async saveCache(teamId, agents) {
      await db.runAsync(`DELETE FROM connected_agents WHERE team_id = ?`, teamId);
      const now = Date.now();
      for (const a of agents) {
        await db.runAsync(
          `INSERT INTO connected_agents (
             team_id, agent_id, display_name, agent_types, default_agent_type, permission_level,
             visibility, is_owner, device_id, last_active_at, current_model, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          teamId, a.agentId, a.displayName, JSON.stringify(a.agentTypes), a.defaultAgentType, a.permissionLevel,
          a.visibility, a.isOwner ? 1 : 0,
          // legacy device_id column retained in the local cache schema; routing
          // now uses agentId (== actor id), so this is no longer populated.
          null,
          a.lastActiveAt ? Date.parse(a.lastActiveAt) : null,
          null, null, now,
        );
      }
    },
  };
}
