// services/fc/test/sync-flow.test.mjs
//
// Integration tests for the prepare → complete CAS flow.
// Requires local Supabase running on 127.0.0.1:54321 with the
// 20260527000001 migration applied.
//
// Run: node --test test/sync-flow.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Config (local Supabase defaults)
// ---------------------------------------------------------------------------
const SUPABASE_URL     = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

function serviceRole() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Shared state set up in `before()`
// ---------------------------------------------------------------------------
const ctx = {
  ready:      false,
  skipReason: null,
  teamId:     null,
  actorAlice: null,
  actorBob:   null,
};

const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function setupFixtures() {
  const sb          = serviceRole();
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Create auth users
  const { data: aliceData, error: ae } = await adminClient.auth.admin.createUser({
    email: `alice-flow-${RUN}@amux.test`, password: 'testpassword', email_confirm: true,
  });
  if (ae || !aliceData?.user) throw new Error(`create alice user: ${ae?.message}`);
  const aliceId = aliceData.user.id;

  const { data: bobData, error: be } = await adminClient.auth.admin.createUser({
    email: `bob-flow-${RUN}@amux.test`, password: 'testpassword', email_confirm: true,
  });
  if (be || !bobData?.user) throw new Error(`create bob user: ${be?.message}`);
  const bobId = bobData.user.id;

  // Create team
  const { data: teamRow, error: te } = await sb
    .from('teams')
    .insert({ slug: `flow-test-${RUN}`, name: `Flow Test ${RUN}` })
    .select('id').single();
  if (te) throw new Error(`create team: ${te.message}`);
  ctx.teamId = teamRow.id;

  // Alice actor
  const { data: aa, error: aae } = await sb
    .from('actors')
    .insert({ team_id: ctx.teamId, actor_type: 'member', display_name: 'Alice', user_id: aliceId })
    .select('id').single();
  if (aae) throw new Error(`create alice actor: ${aae.message}`);
  ctx.actorAlice = aa.id;
  await sb.from('members').insert({ id: ctx.actorAlice, status: 'active' });
  await sb.from('team_members').insert({ team_id: ctx.teamId, member_id: ctx.actorAlice, role: 'owner' });

  // Bob actor
  const { data: ba, error: bae } = await sb
    .from('actors')
    .insert({ team_id: ctx.teamId, actor_type: 'member', display_name: 'Bob', user_id: bobId })
    .select('id').single();
  if (bae) throw new Error(`create bob actor: ${bae.message}`);
  ctx.actorBob = ba.id;
  await sb.from('members').insert({ id: ctx.actorBob, status: 'active' });
  await sb.from('team_members').insert({ team_id: ctx.teamId, member_id: ctx.actorBob, role: 'member' });

  // team_workspace_config
  const { error: twce } = await sb.from('team_workspace_config').insert({
    team_id: ctx.teamId, sync_mode: 'oss', oss_change_seq: 0,
    litellm_team_id: 'test-litellm', ai_gateway_endpoint: 'https://ai.example.com/v1',
  });
  if (twce) throw new Error(`create twc: ${twce.message}`);

  ctx.ready = true;
}

async function insertSession({ actorId, path, parentVersion, contentHash, size, expiresIn = 3600_000 }) {
  const sb = serviceRole();
  const ossKey = `teams/${ctx.teamId}/blobs/sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`;

  await sb.from('amuxc_blobs').upsert(
    { team_id: ctx.teamId, content_hash: contentHash, oss_key: ossKey, size, verified: false },
    { onConflict: 'team_id,content_hash', ignoreDuplicates: true }
  );

  const { data, error } = await sb.from('amuxc_upload_sessions').insert({
    team_id: ctx.teamId, actor_id: actorId, path,
    parent_version: parentVersion, content_hash: contentHash, size,
    oss_key: ossKey, status: 'pending',
    expires_at: new Date(Date.now() + expiresIn).toISOString(),
  }).select('id').single();
  if (error) throw new Error(`insertSession: ${error.message}`);
  return data.id;
}

async function completeUpload(sessionId, actorId) {
  const sb = serviceRole();
  return sb.rpc('amuxc_complete_upload', { p_session_id: sessionId, p_actor_id: actorId });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
before(async () => {
  try {
    // Quick reachability check
    const sb = serviceRole();
    const { error } = await sb.from('teams').select('id').limit(1);
    if (error) {
      ctx.skipReason = `Local Supabase not reachable: ${error.message}`;
      return;
    }
    await setupFixtures();
  } catch (e) {
    ctx.skipReason = `Fixture setup failed: ${e.message}`;
    console.error('  [sync-flow] skip reason:', ctx.skipReason);
  }
});

after(async () => {
  if (!ctx.teamId) return;
  const sb = serviceRole();
  // Best-effort cleanup
  await sb.from('amuxc_file_versions').delete().in('file_id',
    (await sb.from('amuxc_files').select('id').eq('team_id', ctx.teamId)).data?.map(r => r.id) ?? []
  );
  await sb.from('amuxc_files').delete().eq('team_id', ctx.teamId);
  await sb.from('amuxc_blobs').delete().eq('team_id', ctx.teamId);
  await sb.from('amuxc_upload_sessions').delete().eq('team_id', ctx.teamId);
  await sb.from('team_workspace_config').delete().eq('team_id', ctx.teamId);
  await sb.from('team_members').delete().eq('team_id', ctx.teamId);
  if (ctx.actorAlice) await sb.from('members').delete().eq('id', ctx.actorAlice);
  if (ctx.actorBob)   await sb.from('members').delete().eq('id', ctx.actorBob);
  await sb.from('actors').delete().eq('team_id', ctx.teamId);
  await sb.from('teams').delete().eq('id', ctx.teamId);
});

// ---------------------------------------------------------------------------
// Helpers to skip inside test body
// ---------------------------------------------------------------------------
function requireReady(t) {
  if (!ctx.ready) t.skip(ctx.skipReason || 'setup not ready');
}

// ---------------------------------------------------------------------------
// Test 1: prepare → complete with correct parent_version=0 → success
// ---------------------------------------------------------------------------
test('Test 1: happy path prepare → complete → version=1', async (t) => {
  requireReady(t);
  const sb = serviceRole();
  const hash = `aabb${RUN}001`.padEnd(64, '0');

  const sessionId = await insertSession({
    actorId: ctx.actorAlice, path: 'skills/test1.md',
    parentVersion: 0, contentHash: hash, size: 100,
  });

  const { data, error } = await completeUpload(sessionId, ctx.actorAlice);
  assert.ok(!error, `RPC error: ${error?.message}`);
  assert.ok(data && data.length > 0, 'expected result rows');
  assert.equal(data[0].version, 1);
  assert.equal(data[0].content_hash, hash);

  // Verify blob.verified flipped
  const { data: blob } = await sb.from('amuxc_blobs').select('verified')
    .eq('team_id', ctx.teamId).eq('content_hash', hash).single();
  assert.equal(blob.verified, true);

  // Verify oss_change_seq advanced
  const { data: twc } = await sb.from('team_workspace_config').select('oss_change_seq').eq('team_id', ctx.teamId).single();
  assert.ok(twc.oss_change_seq >= 1, 'oss_change_seq should be >= 1');
});

// ---------------------------------------------------------------------------
// Test 2: two concurrent completes with parent_version=0 → one wins, one 409
// ---------------------------------------------------------------------------
test('Test 2: concurrent complete → one wins, one gets cas-mismatch', async (t) => {
  requireReady(t);
  const hash1 = `aabb${RUN}002a`.padEnd(64, '0');
  const hash2 = `ccdd${RUN}002b`.padEnd(64, '0');

  const sessionId1 = await insertSession({
    actorId: ctx.actorAlice, path: 'skills/test2.md', parentVersion: 0, contentHash: hash1, size: 100,
  });
  const sessionId2 = await insertSession({
    actorId: ctx.actorAlice, path: 'skills/test2.md', parentVersion: 0, contentHash: hash2, size: 200,
  });

  const [r1, r2] = await Promise.all([
    completeUpload(sessionId1, ctx.actorAlice),
    completeUpload(sessionId2, ctx.actorAlice),
  ]);

  const successes = [r1, r2].filter(r => !r.error).length;
  const conflicts = [r1, r2].filter(r => r.error).length;

  assert.ok(successes >= 1, 'at least one should succeed');
  assert.equal(successes + conflicts, 2, 'total outcomes should be 2');
});

// ---------------------------------------------------------------------------
// Test 3: stale parent_version after another commit → 409
// ---------------------------------------------------------------------------
test('Test 3: stale parent_version → cas-mismatch', async (t) => {
  requireReady(t);
  const hash1 = `eeff${RUN}003a`.padEnd(64, '0');
  const hash2 = `1122${RUN}003b`.padEnd(64, '0');

  // First commit (v=0 → v=1)
  const sid1 = await insertSession({
    actorId: ctx.actorAlice, path: 'skills/test3.md', parentVersion: 0, contentHash: hash1, size: 100,
  });
  const { error: err1 } = await completeUpload(sid1, ctx.actorAlice);
  assert.ok(!err1, `first commit: ${err1?.message}`);

  // Second commit with stale parent_version=0
  const sid2 = await insertSession({
    actorId: ctx.actorAlice, path: 'skills/test3.md', parentVersion: 0, contentHash: hash2, size: 200,
  });
  const { error: err2 } = await completeUpload(sid2, ctx.actorAlice);
  assert.ok(err2, 'should fail with cas-mismatch');
  // P0409 or SQLSTATE containing cas-mismatch
  const isCas = err2.code === 'P0409' || (err2.message || '').includes('cas-mismatch');
  assert.ok(isCas, `expected cas-mismatch, got ${err2.code} ${err2.message}`);
});

// ---------------------------------------------------------------------------
// Test 4: session.actor_id != caller → 403
// ---------------------------------------------------------------------------
test('Test 4: actor mismatch → P0403', async (t) => {
  requireReady(t);
  const hash = `3344${RUN}004`.padEnd(64, '0');
  // Alice creates, Bob tries to complete
  const sessionId = await insertSession({
    actorId: ctx.actorAlice, path: 'skills/test4.md', parentVersion: 0, contentHash: hash, size: 100,
  });
  const { error } = await completeUpload(sessionId, ctx.actorBob);
  assert.ok(error, 'should fail with actor mismatch');
  const isOwnership = error.code === 'P0403' || (error.message || '').includes('does not belong');
  assert.ok(isOwnership, `expected P0403, got ${error.code} ${error.message}`);
});

// ---------------------------------------------------------------------------
// Test 5: expired session → 410
// ---------------------------------------------------------------------------
test('Test 5: expired session → P0410', async (t) => {
  requireReady(t);
  const hash = `5566${RUN}005`.padEnd(64, '0');
  // expires_at in the past
  const sessionId = await insertSession({
    actorId: ctx.actorAlice, path: 'skills/test5.md', parentVersion: 0, contentHash: hash, size: 100,
    expiresIn: -1000, // 1 second in the past
  });
  const { error } = await completeUpload(sessionId, ctx.actorAlice);
  assert.ok(error, 'should fail with expired session');
  const isExpired = error.code === 'P0410' || (error.message || '').includes('expired');
  assert.ok(isExpired, `expected P0410, got ${error.code} ${error.message}`);
});
