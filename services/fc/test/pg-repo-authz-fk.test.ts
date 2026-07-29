/**
 * mapActorDeleteFkError — stable delete-blocker tokens (parity with amux.remove_team_actor RPC).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapActorDeleteFkError } from "../src/lib/pg-repo/authz.js";

test("mapActorDeleteFkError maps idea_activities FK to stable token", () => {
  const err = mapActorDeleteFkError('update or delete on table "agents" violates foreign key constraint "idea_activities_actor_id_fkey" on table "idea_activities"');
  assert.equal(err.message, "agent_delete_blocked_by_idea_activities");
  assert.equal(err.statusCode, 409);
});

test("mapActorDeleteFkError maps apps created_by_actor FK to stable token", () => {
  const err = mapActorDeleteFkError('violates foreign key constraint "apps_created_by_actor_id_fkey"');
  assert.equal(err.message, "agent_delete_blocked_by_apps");
});

test("mapActorDeleteFkError maps amuxc_files FK to stable token", () => {
  const err = mapActorDeleteFkError('violates foreign key constraint "amuxc_files_updated_by_fkey" on table "amuxc_files"');
  assert.equal(err.message, "agent_delete_blocked_by_files");
});

test("mapActorDeleteFkError falls back to generic reference token", () => {
  const err = mapActorDeleteFkError("some other foreign key violation");
  assert.equal(err.message, "actor_delete_blocked_by_references");
});
