import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createApnsJwtCache } from './apns-jwt.js';
import { createApnsClient, createHttp2Transport } from './apns.js';
import { createMqttPublisher } from './mqtt-client.js';
import { getDb } from '../db/client.js';
import {
  pushIdempotencyClaim,
  listSessionPushTargets,
  revokeDeviceToken,
} from './pg-repo/push-targets.js';

// ---------------------------------------------------------------------------
// Push-notification dependency wiring (APNS + MQTT + token store).
//
// Extracted from admin-handlers.ts. `dispatchPush` (push-dispatch.ts) consumes
// one of these dep bundles. Two flavors exist: a Supabase service-role backed
// one (`pushDeps`) and a Postgres-backed one (`pgPushDeps`) that avoids the
// service-role key. Both are lazily built and cached so the cold path stays
// cheap.
// ---------------------------------------------------------------------------

const SUPABASE_URL_FN       = () => process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APNS_PRIVATE_KEY_P8   = () => process.env.APNS_PRIVATE_KEY_P8 || '';
const APNS_KEY_ID           = () => process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID          = () => process.env.APNS_TEAM_ID || '';
const APNS_TOPIC            = () => process.env.APNS_TOPIC || '';
const APNS_ENV              = () => (process.env.APNS_ENV || 'production').toLowerCase();

const MQTT_BROKER_URL       = () => process.env.MQTT_BROKER_URL || '';
const MQTT_USERNAME         = () => process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD         = () => process.env.MQTT_PASSWORD || '';

function buildApns() {
  const apnsHost = APNS_ENV() === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const jwt = createApnsJwtCache({
    privateKeyP8: APNS_PRIVATE_KEY_P8(),
    keyId: APNS_KEY_ID(),
    teamId: APNS_TEAM_ID(),
  });
  return createApnsClient({
    jwt, topic: APNS_TOPIC(),
    transport: createHttp2Transport(apnsHost),
  });
}

function buildMqtt() {
  return MQTT_BROKER_URL()
    ? createMqttPublisher({
        url: MQTT_BROKER_URL(),
        username: MQTT_USERNAME(),
        password: MQTT_PASSWORD(),
      })
    : null;
}

// ---------------------------------------------------------------------------
// Supabase service-role backed push deps
// ---------------------------------------------------------------------------
let _pushDeps: ReturnType<typeof buildPushDeps> | null = null;
function buildPushDeps() {
  const sbClient = createSupabaseClient(SUPABASE_URL_FN(), SUPABASE_SERVICE_ROLE(), {
    auth: { persistSession: false },
  });
  const sb = {
    rpc: (name: string, args: unknown) => sbClient.schema("amux").rpc(name, args as Record<string, unknown>),
    revokeToken: async (token: string) => {
      await sbClient.from('device_push_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token', token);
    },
  };
  return { sb, apns: buildApns(), mqtt: buildMqtt() };
}
export function pushDeps() {
  if (_pushDeps) return _pushDeps;
  _pushDeps = buildPushDeps();
  return _pushDeps;
}

// ---------------------------------------------------------------------------
// Pg-backed push deps (no Supabase service-role)
// ---------------------------------------------------------------------------
let _pgPushDeps: ReturnType<typeof buildPgPushDeps> | null = null;
function buildPgPushDeps() {
  const sb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'push_idempotency_claim') {
        const messageId = args['p_message_id'] as string;
        const claimed = await pushIdempotencyClaim(getDb(), messageId);
        return { data: [{ claimed }] };
      }
      if (name === 'list_session_push_targets') {
        const sessionId = args['p_session_id'] as string;
        const excludeActorId = args['p_exclude_actor_id'] as string;
        const targets = await listSessionPushTargets(getDb(), sessionId, excludeActorId);
        return { data: targets };
      }
      throw new Error(`[pg-push] unknown rpc: ${name}`);
    },
    revokeToken: async (token: string) => {
      await revokeDeviceToken(getDb(), token);
    },
  };
  return { sb, apns: buildApns(), mqtt: buildMqtt() };
}
export function pgPushDeps() {
  if (_pgPushDeps) return _pgPushDeps;
  _pgPushDeps = buildPgPushDeps();
  return _pgPushDeps;
}
