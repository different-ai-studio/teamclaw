// services/fc/lib/push-dispatch.mjs
import { inDnd, isForegroundDevice, truncate } from './push-filters.js';

export async function dispatchPush(msg, deps) {
  const { id: messageId, session_id, sender_actor_id, kind, content } = msg;
  const { sb, apns, mqtt, now = () => new Date() } = deps;

  if (kind === 'system') return { skipped: 'system_kind' };

  const claimRes = await sb.schema("amux").rpc('push_idempotency_claim', { p_message_id: messageId });
  const claimed = claimRes?.data?.[0]?.claimed ?? false;
  if (!claimed) return { skipped: 'duplicate' };

  const ctxRes = await sb.schema("amux").rpc('list_session_push_targets', {
    p_session_id: session_id, p_exclude_actor_id: sender_actor_id,
  });
  const ctx = ctxRes?.data ?? { recipients: [], sender_display_name: 'Someone' };

  const jobs = [];
  for (const r of ctx.recipients) {
    if (r.muted) continue;
    if (r.prefs && r.prefs.enabled === false) continue;
    if (inDnd(r.prefs, now())) continue;
    for (const t of r.tokens) {
      if (t.provider !== 'apns') continue;
      if (isForegroundDevice(r.presence, t.device_id)) continue;
      jobs.push({ userId: r.user_id, token: t });
    }
  }

  const payload = buildApnsPayload({
    title: ctx.sender_display_name || 'Someone',
    body: truncate(content, 80),
    sessionId: session_id,
    messageId,
  });

  // Inbox fan-out: every non-muted recipient gets a lightweight ping on their
  // own MQTT topic so connected clients can light up an unread red dot
  // without subscribing to per-session topics. has_unread is recomputed
  // server-side from session_read_markers, so the payload only needs
  // session_id — clients re-query list_current_actor_sessions on receipt.
  const inboxUserIds = mqtt
    ? [...new Set(ctx.recipients.filter((r) => !r.muted).map((r) => r.user_id))]
    : [];
  const inboxPayload = mqtt
    ? JSON.stringify({ session_id, ts: now().getTime() })
    : null;

  const [apnsResults, inboxResults] = await Promise.all([
    Promise.allSettled(jobs.map((j) => apns.send(j.token.token, payload))),
    mqtt
      ? Promise.allSettled(inboxUserIds.map((uid) => mqtt.publish(`inbox/${uid}`, inboxPayload)))
      : Promise.resolve([]),
  ]);

  let sent = 0, revoked = 0, failed = 0;
  for (let i = 0; i < apnsResults.length; i++) {
    const job = jobs[i];
    const r = apnsResults[i];
    if (r.status === 'fulfilled') {
      if (r.value.status === 200) { sent++; continue; }
      if (r.value.status === 410 || r.value.reason === 'BadDeviceToken' || r.value.reason === 'Unregistered') {
        await sb.revokeToken(job.token.token);
        revoked++;
        continue;
      }
    }
    failed++;
  }

  let inboxSent = 0, inboxFailed = 0;
  for (const r of inboxResults) {
    if (r.status === 'fulfilled') inboxSent++; else inboxFailed++;
  }

  return {
    sent, revoked, failed, recipients: ctx.recipients.length,
    inboxSent, inboxFailed, inboxTargets: inboxUserIds.length,
  };
}

export function buildApnsPayload({ title, body, sessionId, messageId }) {
  return {
    aps: {
      alert: { title, body },
      'thread-id': sessionId,
      sound: 'default',
      badge: 1,
    },
    data: { session_id: sessionId, message_id: messageId, kind: 'message' },
  };
}
