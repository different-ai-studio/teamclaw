import {
  getEffectiveServerConfig,
  getSavedServerConfig,
  saveServerConfig,
  type ServerConfig,
} from "@/lib/server-config";

interface BootstrapMqttPayload {
  url?: string;
  /**
   * Raw-TCP broker address (mqtt://host:port), for clients whose MQTT stack
   * cannot do WebSocket — iOS (CocoaMQTT) and Expo prefer it over `url`.
   *
   * The desktop does NOT: its rumqttc client is built with the `websocket`
   * feature (see `apps/desktop/Cargo.toml` and the `is_websocket()` branch in
   * `apps/desktop/src/mqtt/client.rs`), so the canonical public `url` wins here
   * and `tcpUrl` is only a fallback. The daemon resolves it the same way. Keep
   * the two families' preferences deliberate rather than accidentally aligned.
   */
  tcpUrl?: string | null;
  username?: string | null;
  password?: string | null;
  useTls?: boolean | null;
}

interface BootstrapWebSsoPayload {
  loginUrl?: string;
  storageKey?: string | null;
}

interface BootstrapPayload {
  mqtt?: BootstrapMqttPayload;
  webSso?: BootstrapWebSsoPayload;
}

function parseBrokerUrl(raw: string): { host: string; port?: number; useTls?: boolean } | null {
  try {
    const url = new URL(raw);
    const scheme = url.protocol.replace(/:$/, "");
    const useTls = scheme === "mqtts" || scheme === "wss";
    const port = url.port ? Number(url.port) : undefined;
    if (!url.hostname) return null;
    return { host: url.hostname, port: Number.isFinite(port) ? port : undefined, useTls };
  } catch {
    return null;
  }
}

function patchFromPayload(mqtt: BootstrapMqttPayload | undefined): Partial<ServerConfig> | null {
  const raw = mqtt?.url || mqtt?.tcpUrl;
  if (!raw) return null;
  const parsed = parseBrokerUrl(raw);
  if (!parsed) return null;
  return {
    mqttUrl: raw,
    mqttHost: parsed.host,
    mqttPort: parsed.port,
    mqttUseTls: mqtt.useTls ?? parsed.useTls,
    mqttUsername: mqtt.username ?? undefined,
    mqttPassword: mqtt.password ?? undefined,
    mqttSource: "bootstrap",
  };
}

function webSsoPatchFrom(webSso: BootstrapWebSsoPayload | undefined): Partial<ServerConfig> | null {
  if (!webSso?.loginUrl) return null;
  return {
    webSsoLoginUrl: webSso.loginUrl,
    webSsoStorageKey: webSso.storageKey ?? undefined,
  };
}

// Drop the per-account MQTT broker credentials so a different user doesn't
// inherit the previous user's session against the broker. Called from
// auth-store.signOut.
//
// The broker ADDRESS is deliberately kept: it is deployment topology, not
// account data, and it is the only copy the desktop has. Clearing it turned a
// sign-out into an outage whenever the Cloud API had stopped delivering an
// `mqtt` block — the next sign-in asks bootstrap once, gets nothing, and the
// app has no address left to fall back on (issue #634). What survives is
// re-labelled `cache` so the UI can say it is remembered rather than fresh.
//
// cloudApiUrl is not persisted (build config only). The Web SSO target is NOT
// cleared: it is non-sensitive public config and is needed on the login screen
// (pre-session), so wiping it on sign-out would hide 快捷登录 until the next fetch.
export async function clearBootstrapAppliedFields(): Promise<void> {
  const saved = await getSavedServerConfig();
  await saveServerConfig({
    ...saved,
    mqttUsername: undefined,
    mqttPassword: undefined,
    mqttSource: saved.mqttUrl || saved.mqttHost ? "cache" : undefined,
  });
}

// Fetch the PUBLIC (unauthenticated) config — currently the Web SSO 快捷登录
// target — and cache it. Unlike fetchAndApplyBootstrap this needs no session,
// so it can run before/at the login screen. Best-effort; never throws.
export async function fetchPublicConfig(args?: { fetchImpl?: typeof fetch }): Promise<void> {
  const effective = await getEffectiveServerConfig();
  const baseUrl = effective.cloudApiUrl?.replace(/\/+$/, "");
  if (!baseUrl) return;
  const fetchImpl = args?.fetchImpl ?? fetch;
  let body: BootstrapPayload;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/config/public`);
    if (!res.ok) return;
    body = (await res.json()) as BootstrapPayload;
  } catch {
    return;
  }
  const patch = webSsoPatchFrom(body.webSso);
  if (!patch) return;
  const saved = await getSavedServerConfig();
  await saveServerConfig({ ...saved, ...patch });
}

/**
 * What the last bootstrap attempt did to the MQTT broker config.
 *
 * `cloud-empty` is the one worth surfacing: the Cloud API answered 200 with no
 * `mqtt` block. It is not an error at the HTTP layer, which is exactly why it
 * went unnoticed for a day in issue #634 — callers must not treat it as success.
 */
export type BootstrapMqttOutcome =
  | "applied" // cloud delivered a broker
  | "cloud-empty" // cloud answered, but without an mqtt block
  | "unreachable" // network/HTTP failure
  | "skipped"; // no token or no cloudApiUrl — nothing was attempted

// Bootstrap is best-effort: any failure leaves the existing client config in
// place. The function never throws so callers can fire-and-forget after sign-in.
export async function fetchAndApplyBootstrap(args: {
  accessToken: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<BootstrapMqttOutcome> {
  const token = args.accessToken?.trim();
  if (!token) return "skipped";
  const effective = await getEffectiveServerConfig();
  const baseUrl = effective.cloudApiUrl?.replace(/\/+$/, "");
  if (!baseUrl) return "skipped";
  const fetchImpl = args.fetchImpl ?? fetch;
  let body: BootstrapPayload;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/config/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return "unreachable";
    body = (await res.json()) as BootstrapPayload;
  } catch {
    return "unreachable";
  }
  const mqttPatch = patchFromPayload(body.mqtt);
  const webSsoPatch = webSsoPatchFrom(body.webSso);
  const saved = await getSavedServerConfig();

  // No mqtt block: keep whatever address we already have and demote it to
  // `cache`, so the settings UI can flag "running on a remembered address"
  // instead of silently looking healthy.
  if (!mqttPatch) {
    const hasCached = Boolean(saved.mqttUrl || saved.mqttHost);
    if (webSsoPatch || hasCached) {
      await saveServerConfig({
        ...saved,
        ...webSsoPatch,
        ...(hasCached ? { mqttSource: "cache" as const } : {}),
      });
    }
    return "cloud-empty";
  }

  await saveServerConfig({ ...saved, ...mqttPatch, ...webSsoPatch });
  return "applied";
}
