import { and, eq, sql } from "drizzle-orm";
import { apps } from "../db/schema/index.js";
import { parseAppPublicHost } from "./apps-public-host.js";

/**
 * Serving deployed apps on `<slug>-<id8>.<APPS_PUBLIC_DOMAIN>`.
 *
 * Two halves, both driven by the request's Host:
 *
 *   * `ask`   — Caddy asks before completing a TLS handshake for a hostname it
 *               has no certificate for. Answering 404 for unknown names is the
 *               only thing standing between on-demand issuance and an open
 *               cert-minting endpoint: anyone can point a request at this box,
 *               and Let's Encrypt's rate limit is per REGISTERED domain, shared
 *               with api/supabase/mqtt on the same name.
 *   * `proxy` — forward the request to that app's Function Compute trigger.
 *
 * The lookup deliberately does NOT go through the request-scoped repository:
 * both halves are unauthenticated by nature (a browser hitting a public page,
 * and Caddy itself), so there is no bearer token to scope RLS with. It reads
 * the control-plane database directly, like the cron and push paths do.
 */
export interface VanityApp {
  id: string;
  slug: string;
  fcEndpoint: string | null;
  fcStatus: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = any;

export type LookupVanityApp = (host: string) => Promise<VanityApp | null>;

/**
 * Of the apps sharing a slug (one per team at most), the one whose id starts
 * with the prefix from the hostname.
 *
 * Two hits means two teams whose slugs AND id prefixes collide — serving either
 * would be a coin flip between different teams' apps, so serve neither.
 */
export function selectByIdPrefix(rows: VanityApp[], idPrefix: string): VanityApp | null {
  const hits = rows.filter((r) => typeof r.id === "string" && r.id.startsWith(idPrefix));
  return hits.length === 1 ? hits[0] : null;
}

/** Postgres backend: read the control-plane tables directly. */
export function makePgVanityLookup(getDb: () => DbLike): LookupVanityApp {
  return async (host: string) => {
    const parsed = parseAppPublicHost(host);
    if (!parsed) return null;
    const rows = await getDb()
      .select({
        id: apps.id,
        slug: apps.slug,
        fcEndpoint: apps.fcEndpoint,
        fcStatus: apps.fcStatus,
      })
      .from(apps)
      .where(and(eq(apps.slug, parsed.slug), sql`${apps.id}::text like ${parsed.idPrefix + "%"}`))
      .limit(2);
    return selectByIdPrefix(rows as VanityApp[], parsed.idPrefix);
  };
}

/**
 * Supabase backend: PostgREST with the service-role key, which is how every
 * other tokenless path here reads the database.
 *
 * Filters on slug alone and matches the id prefix in memory rather than asking
 * PostgREST for `id like '…%'`: `id` is a uuid column, and Postgres has no
 * `uuid ~~ text` operator — that filter fails as a query error, not as an empty
 * result. At most one row per team shares a slug, so the list is tiny.
 */
export function makeSupabaseVanityLookup(getClient: () => any): LookupVanityApp {
  return async (host: string) => {
    const parsed = parseAppPublicHost(host);
    if (!parsed) return null;
    const { data, error } = await getClient()
      .from("apps")
      .select("id, slug, fc_endpoint, fc_status")
      .eq("slug", parsed.slug)
      .limit(50);
    if (error) throw new Error(`vanity app lookup failed: ${error.message}`);
    const rows: VanityApp[] = (data ?? []).map((r: any) => ({
      id: r.id, slug: r.slug, fcEndpoint: r.fc_endpoint ?? null, fcStatus: r.fc_status ?? null,
    }));
    return selectByIdPrefix(rows, parsed.idPrefix);
  };
}

/**
 * The lookup this deployment can actually perform.
 *
 * Chosen per call rather than at wiring time so neither client is constructed
 * on a deployment that never serves a vanity host — and `getDb()` in
 * particular throws outright when DATABASE_URL is unset, which is the normal
 * state of a self-host box running the supabase backend.
 */
export function makeVanityLookup(deps: {
  backendKind: () => string;
  getDb: () => DbLike;
  getServiceRoleClient: () => any;
}): LookupVanityApp {
  return async (host: string) => {
    if (!parseAppPublicHost(host)) return null;
    const impl = deps.backendKind() === "postgres"
      ? makePgVanityLookup(deps.getDb)
      : makeSupabaseVanityLookup(deps.getServiceRoleClient);
    return impl(host);
  };
}

/** A deployed app is servable only once it has a live endpoint to serve from. */
export function isServable(app: VanityApp | null): app is VanityApp & { fcEndpoint: string } {
  return !!app && app.fcStatus === "live" && !!app.fcEndpoint;
}

// Hop-by-hop headers are connection-scoped: forwarding them corrupts the next
// hop's framing (RFC 9110 §7.6.1). `host` is dropped separately because fetch
// derives it from the upstream URL — and FC routes on it, so passing the
// client's Host through would reach the wrong function or none at all.
const HOP_BY_HOP = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];

function strip(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const h of HOP_BY_HOP) out.delete(h);
  return out;
}

/**
 * Proxy one request to the app's FC trigger, streaming both ways.
 *
 * Response headers pass through untouched apart from hop-by-hop ones: the app
 * owns its own content-type, caching and CORS, and second-guessing them here
 * is how a proxy starts breaking the very apps it serves.
 */
export async function proxyToApp(
  request: Request,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  const upstream = new URL(endpoint);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;

  const headers = strip(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const res = await fetchImpl(upstream, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // Node's fetch refuses a streamed body without it, and buffering instead
    // would hold whole uploads in the API's memory.
    ...(hasBody ? { duplex: "half" } : {}),
    // A 302 belongs to the app; following it here would silently rewrite the
    // app's own navigation into a response from a different URL.
    redirect: "manual",
  } as RequestInit);

  return new Response(res.body, { status: res.status, headers: strip(res.headers) });
}
