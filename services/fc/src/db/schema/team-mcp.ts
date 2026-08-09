import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

import { teams, actors } from "./teams.js";

// Mirrors services/supabase/migrations/20260806020000_team_mcp_and_env.sql.
// Design: docs/architecture/team-mcp-and-env-cloud.md

export const teamMcpServers = pgTable(
  "team_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // The key under Cursor's `mcpServers` map. Unique within a team.
    name: text("name").notNull(),
    transport: text("transport").notNull(),
    command: text("command"),
    args: jsonb("args"),
    url: text("url"),
    headers: jsonb("headers"),
    env: jsonb("env"),
    description: text("description"),
    // set null, not restrict: the author leaving must not block deleting them,
    // and the server definition still has to be readable afterwards.
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => actors.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    teamNameUniq: uniqueIndex("uniq_team_mcp_servers_team_name").on(t.teamId, t.name),
    teamIdx: index("idx_team_mcp_servers_team").on(t.teamId),
  }),
);

// Adding a server to the catalog does not make it run anywhere — installing
// does, and you can only install for yourself. That split is what makes it
// safe to let any member write to the catalog, given `command` is spawned on
// the installing member's machine.
export const teamMcpInstalls = pgTable(
  "team_mcp_installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => teamMcpServers.id, { onDelete: "cascade" }),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    installUniq: uniqueIndex("uniq_team_mcp_install").on(t.actorId, t.serverId),
    actorIdx: index("idx_team_mcp_installs_actor").on(t.actorId),
    serverIdx: index("idx_team_mcp_installs_server").on(t.serverId),
  }),
);
