import {
  getEffectiveServerConfig,
  getSavedServerConfig,
  saveServerConfig,
  type ServerConfig,
} from "@/lib/server-config";

interface BootstrapMqttPayload {
  url?: string;
  /** Raw-TCP broker address (mqtt://host:port); preferred by the desktop,
   * whose Rust MQTT client only speaks raw TCP. `url` may be ws(s)://. */
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
// inherit the previous user's broker. Called from auth-store.signOut.
// cloudApiUrl is not persisted (build config only). The Web SSO target is NOT
// cleared: it is non-sensitive public config and is needed on the login screen
// (pre-session), so wiping it on sign-out would hide 快捷登录 until the next fetch.
export async function clearBootstrapAppliedFields(): Promise<void> {
  const saved = await getSavedServerConfig();
  await saveServerConfig({
    ...saved,
    mqttUrl: undefined,
    mqttHost: undefined,
    mqttPort: undefined,
    mqttUseTls: undefined,
    mqttUsername: undefined,
    mqttPassword: undefined,
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

// Bootstrap is best-effort: any failure leaves the existing client config in
// place. The function never throws so callers can fire-and-forget after sign-in.
export async function fetchAndApplyBootstrap(args: {
  accessToken: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const token = args.accessToken?.trim();
  if (!token) return;
  const effective = await getEffectiveServerConfig();
  const baseUrl = effective.cloudApiUrl?.replace(/\/+$/, "");
  if (!baseUrl) return;
  const fetchImpl = args.fetchImpl ?? fetch;
  let body: BootstrapPayload;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/config/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    body = (await res.json()) as BootstrapPayload;
  } catch {
    return;
  }
  const mqttPatch = patchFromPayload(body.mqtt);
  const webSsoPatch = webSsoPatchFrom(body.webSso);
  if (!mqttPatch && !webSsoPatch) return;
  const saved = await getSavedServerConfig();
  await saveServerConfig({ ...saved, ...mqttPatch, ...webSsoPatch });
}
