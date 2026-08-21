/**
 * Pre-auth "choose your server" support. Mirrors iOS `ServerEndpoint` and the
 * desktop Custom server step: self-host users point the app at their own Cloud
 * API; MQTT and the rest are discovered from that base URL.
 */

export type ProbeOutcome =
  | { kind: "reachable" }
  | { kind: "badStatus"; status: number }
  | { kind: "unreachable"; reason: string };

const PROBE_TIMEOUT_MS = 6000;

/**
 * Turns user input into a canonical Cloud API base URL: trims whitespace,
 * defaults the scheme to https, drops trailing slashes, and requires a host.
 * Returns null for input that cannot name a server — a bad value must never be
 * persisted, or it wedges the app at launch.
 */
export function normalizeServerEndpoint(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (!text.includes("://")) {
    text = `https://${text}`;
  }
  while (text.endsWith("/")) {
    text = text.slice(0, -1);
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") return null;
  if (!parsed.hostname) return null;

  // Pasted browser URLs often carry a query or fragment. The client
  // string-concatenates paths onto this base, so strip both.
  parsed.search = "";
  parsed.hash = "";
  let path = parsed.pathname;
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  parsed.pathname = path === "/" ? "" : path;

  // URL#toString keeps an empty path as "" after we clear "/" — good.
  // Prefer no trailing slash on the origin-only form.
  return parsed.toString().replace(/\/$/, "") || null;
}

/**
 * Asks the candidate server for its public config. A 200 from
 * `GET /v1/config/public` is proof enough that a TeamClu Cloud API lives at
 * this base URL; no auth is required.
 */
export async function probeServerEndpoint(
  baseUrl: string,
  args?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<ProbeOutcome> {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (!normalized) return { kind: "unreachable", reason: "empty URL" };

  const fetchImpl = args?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    args?.timeoutMs ?? PROBE_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(`${normalized}/v1/config/public`, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.status === 200) return { kind: "reachable" };
    return { kind: "badStatus", status: response.status };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? "timed out"
        : error instanceof Error
          ? error.message
          : "network error";
    return { kind: "unreachable", reason };
  } finally {
    clearTimeout(timer);
  }
}
