import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

import { teams, actors } from "./teams.js";

// Mirrors services/supabase/migrations/20260806020000_team_mcp_and_env.sql.
// Design: docs/architecture/team-mcp-and-env-cloud.md

export const teamEnvSecrets = pgTable(
  "team_env_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Same rule as the desktop `validate_key_id`: 1-64 lowercase/digit/underscore.
    keyId: text("key_id").notNull(),
    // Client-side AES-256-GCM envelope `{v, nonce, ciphertext}`. The server —
    // including whoever operates a self-host box — never sees plaintext.
    //
    // Note the metadata (description/category/createdBy/...) lives *inside* the
    // ciphertext (see crates/teamclu-runtime-env/src/team_crypto.rs), so
    // anything the server must authorise on needs its own plaintext column.
    // That is what createdBy below is for; it cannot be read from the envelope.
    envelope: jsonb("envelope").notNull(),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => actors.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    teamKeyUniq: uniqueIndex("uniq_team_env_secrets_team_key").on(t.teamId, t.keyId),
    teamIdx: index("idx_team_env_secrets_team").on(t.teamId),
  }),
);
