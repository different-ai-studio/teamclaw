// Runtime configuration delivered to authenticated clients on startup.
// Auth is enforced (bearer required) so we never leak broker credentials,
// but the response is built from FC env vars rather than the data backend.

function parseBool(raw) {
  if (raw == null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

// Read an env var, treating blank as absent.
//
// Deployments declare optional vars with an empty default — `${env('X', '')}` in
// s.yaml, `"${X:-}"` in docker-compose — so "not configured" reaches the process
// as `""`, never as undefined. Any `??` chain over these therefore treats a
// blank as a real value; this helper is what makes "leave it empty" mean absent.
function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function buildMqttConfig() {
  // MQTT_BROKER_URL is the ONE broker address, and it is what clients receive.
  //
  // There is deliberately no public/internal split any more. The override that
  // used to sit in front of this (MQTT_PUBLIC_BROKER_URL) is gone: it defaulted
  // to `""` on both deploy targets, `""` is not nullish, so the documented
  // fallback never fired and bootstrap answered 200 with no `mqtt` block at all
  // — clients reported "the server did not deliver an MQTT address" while the
  // daemon, which never reads this endpoint, stayed connected and hid it.
  //
  // The cost of collapsing to one var: every deployment must set
  // MQTT_BROKER_URL to an address that is reachable BY CLIENTS, not just by FC.
  // A container-internal value (`mqtt://emqx:1883`, `mqtt://127.0.0.1:1883`)
  // is now a misconfiguration, because it is handed straight out.
  const url = envValue("MQTT_BROKER_URL");
  if (!url) return null;
  const mqtt: any = { url };
  // Optional raw-TCP address for clients whose MQTT stack can't do WebSocket
  // (rumqttc on desktop/daemon, CocoaMQTT on iOS). The all-in-one self-host
  // image multiplexes raw MQTT onto its single public port via Caddy layer4
  // and sets MQTT_PUBLIC_TCP_BROKER_URL accordingly.
  const tcpUrl = envValue("MQTT_PUBLIC_TCP_BROKER_URL");
  if (tcpUrl) mqtt.tcpUrl = tcpUrl;
  const useTls = parseBool(process.env.MQTT_USE_TLS);
  if (useTls !== undefined) mqtt.useTls = useTls;
  // Intentionally NOT forwarding MQTT_USERNAME/MQTT_PASSWORD to clients:
  // each client authenticates to EMQX with username=actor_id and
  // password=<Supabase access_token> (EMQX JWT auth, HS256). The static
  // MQTT_USERNAME/MQTT_PASSWORD env vars remain reserved for FC's own inbox
  // publisher (push-deps.ts), which connects to EMQX directly.
  return mqtt;
}

// Web SSO 快捷登录 target, delivered to clients so the admin console sign-in URL
// and supabase-js storage key are not hardcoded in the app. Env-driven like the
// MQTT block. storageKey is `sb-<supabase-ref>-auth-token` and can't be derived
// from the admin host, so it is its own variable.
function buildWebSsoConfig() {
  const loginUrl = envValue("WEBSSO_LOGIN_URL");
  if (!loginUrl) return null;
  const webSso: any = { loginUrl };
  const storageKey = envValue("WEBSSO_STORAGE_KEY");
  if (storageKey) webSso.storageKey = storageKey;
  return webSso;
}

export function buildBootstrapConfig() {
  const config: any = {};
  const mqtt = buildMqttConfig();
  if (mqtt) config.mqtt = mqtt;
  const webSso = buildWebSsoConfig();
  if (webSso) config.webSso = webSso;
  return config;
}

// Non-sensitive config that clients need BEFORE they have a session — currently
// just the Web SSO 快捷登录 target, which is a login method (the authed bootstrap
// above runs only post-sign-in, too late for the login screen). No bearer; never
// includes the MQTT broker credentials.
export function buildPublicConfig() {
  const config: any = {};
  const webSso = buildWebSsoConfig();
  if (webSso) config.webSso = webSso;
  return config;
}

export function registerConfig(router) {
  router.get("/v1/config/bootstrap", async () => {
    return { body: buildBootstrapConfig() };
  });
  router.get("/v1/config/public", { auth: "none" }, async () => {
    return { body: buildPublicConfig() };
  });
}
