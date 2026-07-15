/**
 * pg-push-targets — pglite tests for pushIdempotencyClaim + listSessionPushTargets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import {
  pushIdempotencyClaim,
  listSessionPushTargets,
  revokeDeviceToken,
} from "../src/lib/pg-repo/push-targets.js";
import {
  teams,
  actors,
  members,
  teamMembers,
  sessions,
  sessionParticipants,
  devicePushTokens,
  notificationPrefs,
  clientPresence,
  sessionMutes,
} from "../src/db/schema/index.js";

// ── seed helpers ──────────────────────────────────────────────────────────────

async function seedTeam(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "PushTestTeam", slug: `push-${Date.now()}-${Math.random()}` })
    .returning();
  return t;
}

async function seedActor(
  db: any,
  teamId: string,
  userId: string,
  displayName = "Test Actor",
) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName, userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedSession(db: any, teamId: string) {
  const [s] = await db
    .insert(sessions)
    .values({ teamId, mode: "solo", title: "Push Test Session" })
    .returning();
  return s;
}

async function addParticipant(db: any, sessionId: string, actorId: string) {
  await db.insert(sessionParticipants).values({ sessionId, actorId });
}

// ── pushIdempotencyClaim ──────────────────────────────────────────────────────

const MSG_ID_1 = "11111111-1111-1111-1111-111111111111";
const MSG_ID_2 = "22222222-2222-2222-2222-222222222222";

test("pushIdempotencyClaim returns true on first call", async () => {
  const { db } = await makeTestDb();
  const claimed = await pushIdempotencyClaim(db, MSG_ID_1);
  assert.equal(claimed, true);
});

test("pushIdempotencyClaim returns false on duplicate", async () => {
  const { db } = await makeTestDb();
  await pushIdempotencyClaim(db, MSG_ID_2);
  const second = await pushIdempotencyClaim(db, MSG_ID_2);
  assert.equal(second, false);
});

// ── listSessionPushTargets ────────────────────────────────────────────────────

test("listSessionPushTargets excludes sender and returns recipients", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);

  const sender = await seedActor(db, team.id, "user-sender", "Alice");
  const recipient = await seedActor(db, team.id, "user-recipient", "Bob");

  const session = await seedSession(db, team.id);
  await addParticipant(db, session.id, sender.id);
  await addParticipant(db, session.id, recipient.id);

  // Add a device token for the recipient
  await db.insert(devicePushTokens).values({
    userId: "user-recipient",
    deviceId: "device-bob",
    platform: "ios",
    provider: "apns",
    token: "token-bob-1",
  });

  const result = await listSessionPushTargets(db, session.id, sender.id);

  assert.equal(result.sender_display_name, "Alice");
  assert.equal(result.recipients.length, 1);
  const r = result.recipients[0];
  assert.equal(r.user_id, "user-recipient");
  assert.equal(r.tokens.length, 1);
  assert.equal(r.tokens[0].token, "token-bob-1");
  assert.equal(r.tokens[0].provider, "apns");
  assert.equal(r.tokens[0].device_id, "device-bob");
  assert.equal(r.prefs.enabled, true); // default
  assert.equal(r.presence.length, 0);
  assert.equal(r.muted, false);
});

test("listSessionPushTargets excludes revoked tokens", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);

  const sender = await seedActor(db, team.id, "user-sender2", "Alice2");
  const recipient = await seedActor(db, team.id, "user-recipient2", "Bob2");

  const session = await seedSession(db, team.id);
  await addParticipant(db, session.id, sender.id);
  await addParticipant(db, session.id, recipient.id);

  // Add a revoked token
  await db.insert(devicePushTokens).values({
    userId: "user-recipient2",
    deviceId: "device-bob2",
    platform: "ios",
    provider: "apns",
    token: "revoked-token",
    revokedAt: new Date(),
  });

  const result = await listSessionPushTargets(db, session.id, sender.id);
  assert.equal(result.recipients[0].tokens.length, 0);
});

test("listSessionPushTargets respects notification prefs", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);

  const sender = await seedActor(db, team.id, "user-sender3", "Alice3");
  const recipient = await seedActor(db, team.id, "user-recipient3", "Bob3");

  const session = await seedSession(db, team.id);
  await addParticipant(db, session.id, sender.id);
  await addParticipant(db, session.id, recipient.id);

  await db.insert(notificationPrefs).values({
    userId: "user-recipient3",
    enabled: false,
  });

  const result = await listSessionPushTargets(db, session.id, sender.id);
  assert.equal(result.recipients[0].prefs.enabled, false);
});

test("listSessionPushTargets reflects presence entries", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);

  const sender = await seedActor(db, team.id, "user-sender4", "Alice4");
  const recipient = await seedActor(db, team.id, "user-recipient4", "Bob4");

  const session = await seedSession(db, team.id);
  await addParticipant(db, session.id, sender.id);
  await addParticipant(db, session.id, recipient.id);

  await db.insert(clientPresence).values({
    userId: "user-recipient4",
    deviceId: "device-fg",
    foregroundUntil: new Date(Date.now() + 60_000),
  });

  const result = await listSessionPushTargets(db, session.id, sender.id);
  assert.equal(result.recipients[0].presence.length, 1);
  assert.equal(result.recipients[0].presence[0].device_id, "device-fg");
});

test("listSessionPushTargets reflects muted sessions", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);

  const sender = await seedActor(db, team.id, "user-sender5", "Alice5");
  const recipient = await seedActor(db, team.id, "user-recipient5", "Bob5");

  const session = await seedSession(db, team.id);
  await addParticipant(db, session.id, sender.id);
  await addParticipant(db, session.id, recipient.id);

  await db.insert(sessionMutes).values({
    userId: "user-recipient5",
    sessionId: session.id,
  });

  const result = await listSessionPushTargets(db, session.id, sender.id);
  assert.equal(result.recipients[0].muted, true);
});

test("listSessionPushTargets: sender_display_name falls back to 'Someone' for unknown actor", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const session = await seedSession(db, team.id);

  const result = await listSessionPushTargets(
    db,
    session.id,
    "00000000-0000-0000-0000-000000000000",
  );
  assert.equal(result.sender_display_name, "Someone");
  assert.equal(result.recipients.length, 0);
});

// ── revokeDeviceToken ─────────────────────────────────────────────────────────

test("revokeDeviceToken sets revoked_at on matching token", async () => {
  const { db } = await makeTestDb();

  await db.insert(devicePushTokens).values({
    userId: "user-revoke",
    deviceId: "device-r",
    platform: "ios",
    provider: "apns",
    token: "token-to-revoke",
  });

  await revokeDeviceToken(db, "token-to-revoke");

  const rows = await db
    .select({ revokedAt: devicePushTokens.revokedAt })
    .from(devicePushTokens)
    .where((t: any) => t.token === "token-to-revoke");

  // Verify via listSessionPushTargets that the token no longer appears
  const team = await seedTeam(db);
  const sender = await seedActor(db, team.id, "user-sender-r", "SenderR");
  const recipient = await seedActor(db, team.id, "user-revoke", "RecipientR");
  const session = await seedSession(db, team.id);
  await addParticipant(db, session.id, sender.id);
  await addParticipant(db, session.id, recipient.id);

  const result = await listSessionPushTargets(db, session.id, sender.id);
  assert.equal(result.recipients[0].tokens.length, 0);
});
