/**
 * Deployed apps are served on `<slug>-<id8>.<APPS_PUBLIC_DOMAIN>`, which makes
 * the request's Host a routing key AND a certificate request. Both halves are
 * reachable by anyone on the internet, so the parsing below is a security
 * boundary, not a convenience: a host that parses is a host Caddy will go ask
 * Let's Encrypt about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { appPublicUrl, appPublicLabel, parseAppPublicHost } from "../src/lib/apps-public-host.js";
import { isServable, proxyToApp } from "../src/lib/apps-vanity.js";

const DOMAIN = "apps.teamclu-dev.ucar.cc";
const APP_ID = "18e4ecad-6189-495b-a873-7fe09179a5f5";
const env = { APPS_PUBLIC_DOMAIN: DOMAIN } as NodeJS.ProcessEnv;

function withDomain<T>(fn: () => T): T {
  const prev = process.env.APPS_PUBLIC_DOMAIN;
  process.env.APPS_PUBLIC_DOMAIN = DOMAIN;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.APPS_PUBLIC_DOMAIN;
    else process.env.APPS_PUBLIC_DOMAIN = prev;
  }
}

function deps(lookup?: any) {
  return {
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
    ...(lookup ? { lookupVanityApp: lookup } : {}),
  } as any;
}

// --- hostname shape --------------------------------------------------------

test("the label carries an id suffix because slugs are only unique per team", () => {
  // apps_team_slug_uniq is (team_id, slug): two teams can both own `website`,
  // and a hostname has no team in it.
  assert.equal(appPublicLabel("website", APP_ID), "website-18e4ecad");
  assert.equal(appPublicUrl("website", APP_ID, env), `https://website-18e4ecad.${DOMAIN}`);
});

test("no apps domain means no public URL at all", () => {
  assert.equal(appPublicUrl("website", APP_ID, {} as NodeJS.ProcessEnv), null);
  assert.equal(parseAppPublicHost(`website-18e4ecad.${DOMAIN}`, {} as NodeJS.ProcessEnv), null);
});

test("parses a vanity host into slug + id prefix, port and case included", () => {
  assert.deepEqual(parseAppPublicHost(`website-18e4ecad.${DOMAIN}`, env), {
    slug: "website", idPrefix: "18e4ecad",
  });
  assert.deepEqual(parseAppPublicHost(`WebSite-18E4ECAD.${DOMAIN}:8443`, env), {
    slug: "website", idPrefix: "18e4ecad",
  });
  // Slugs may contain dashes; only the LAST one separates the id.
  assert.deepEqual(parseAppPublicHost(`my-cool-site-18e4ecad.${DOMAIN}`, env), {
    slug: "my-cool-site", idPrefix: "18e4ecad",
  });
});

test("refuses everything that is not exactly one label under the apps domain", () => {
  const bad = [
    "api.teamclu-dev.ucar.cc",             // the Cloud API's own name
    DOMAIN,                                 // the bare apps domain
    `deep.website-18e4ecad.${DOMAIN}`,      // two levels: no wildcard covers it
    `website.${DOMAIN}`,                    // no id suffix
    `website-.${DOMAIN}`,                   // empty id
    `website-zzzzzzzz.${DOMAIN}`,           // not hex — cannot be a uuid prefix
    `website-18e4eca.${DOMAIN}`,            // 7 chars
    `-18e4ecad.${DOMAIN}`,                  // empty slug
    `website-18e4ecad.evil.com`,            // someone else's domain
    "",
  ];
  for (const host of bad) {
    assert.equal(parseAppPublicHost(host, env), null, `should refuse ${host || "<empty>"}`);
  }
});

// --- Caddy's on-demand TLS gate -------------------------------------------

test("ask says no for hosts that are not apps, without touching the database", async () => {
  let called = 0;
  const app = createApp(deps(async () => { called++; return null; }));
  await withDomain(async () => {
    const res = await app.request("/internal/caddy/ask?domain=evil.example.com");
    assert.equal(res.status, 404);
  });
  assert.equal(called, 0, "a non-app hostname must be rejected on shape alone");
});

test("ask says no for a well-formed host with no app behind it", async () => {
  const app = createApp(deps(async () => null));
  await withDomain(async () => {
    const res = await app.request(`/internal/caddy/ask?domain=ghost-18e4ecad.${DOMAIN}`);
    assert.equal(res.status, 404);
  });
});

test("ask says yes for a real app, even before it has ever deployed", async () => {
  // The certificate is for the hostname, not for the deployment: refusing here
  // would leave a just-created app unable to get one until its first deploy.
  const app = createApp(deps(async () => ({
    id: APP_ID, slug: "website", fcEndpoint: null, fcStatus: null,
  })));
  await withDomain(async () => {
    const res = await app.request(`/internal/caddy/ask?domain=website-18e4ecad.${DOMAIN}`);
    assert.equal(res.status, 200);
  });
});

// --- serving ---------------------------------------------------------------

test("a vanity host with nothing deployed behind it 404s instead of proxying to null", async () => {
  const app = createApp(deps(async () => ({
    id: APP_ID, slug: "website", fcEndpoint: null, fcStatus: "awaiting_build",
  })));
  await withDomain(async () => {
    const res = await app.request("/", { headers: { host: `website-18e4ecad.${DOMAIN}` } });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /not deployed/);
  });
});

test("requests on the API's own host still reach the API", async () => {
  // The middleware runs on every request; only Host decides. Getting this wrong
  // would take the whole Cloud API down.
  const app = createApp(deps(async () => { throw new Error("must not be consulted"); }));
  await withDomain(async () => {
    const res = await app.request("/v1/nope-nope", {
      headers: { host: "api.teamclu-dev.ucar.cc", authorization: "Bearer abc" },
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json() as any).error.code, "not_found");
  });
});

test("isServable requires a live status AND an endpoint", () => {
  assert.equal(isServable(null), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "live", fcEndpoint: null }), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "deploy_error", fcEndpoint: "https://x" }), false);
  assert.equal(isServable({ id: "1", slug: "s", fcStatus: "live", fcEndpoint: "https://x" }), true);
});

// --- the proxy itself ------------------------------------------------------

test("proxy keeps path and query, and sends the UPSTREAM host", async () => {
  // Function Compute routes on Host. Forwarding the client's Host reaches no
  // function at all, which is the failure this asserts against.
  let seen: any = null;
  const fake = (async (url: any, init: any) => {
    seen = { url: String(url), headers: new Headers(init.headers) };
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const req = new Request(`https://website-18e4ecad.${DOMAIN}/blog/post?id=7`, {
    headers: { host: `website-18e4ecad.${DOMAIN}`, "x-test": "1", connection: "keep-alive" },
  });
  await proxyToApp(req, "https://tc-app-x-abc123.cn-shenzhen.fcapp.run", fake);

  assert.equal(seen.url, "https://tc-app-x-abc123.cn-shenzhen.fcapp.run/blog/post?id=7");
  assert.equal(seen.headers.get("host"), null, "client Host must not be forwarded");
  assert.equal(seen.headers.get("connection"), null, "hop-by-hop headers must be dropped");
  assert.equal(seen.headers.get("x-test"), "1", "everything else passes through");
  assert.equal(seen.headers.get("x-forwarded-host"), `website-18e4ecad.${DOMAIN}`);
});

test("proxy passes the app's own status and headers back untouched", async () => {
  const fake = (async () => new Response("<!doctype html>", {
    status: 201,
    headers: { "content-type": "text/html", "access-control-allow-origin": "*", "transfer-encoding": "chunked" },
  })) as unknown as typeof fetch;

  const res = await proxyToApp(new Request(`https://website-18e4ecad.${DOMAIN}/`), "https://up.example", fake);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "text/html");
  // The app owns its CORS; rewriting it here would break the app it serves.
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("transfer-encoding"), null, "hop-by-hop must not survive");
  assert.equal(await res.text(), "<!doctype html>");
});

test("proxy does not follow the app's redirects on its behalf", async () => {
  let init: any = null;
  const fake = (async (_u: any, i: any) => { init = i; return new Response(null, { status: 302, headers: { location: "/login" } }); }) as unknown as typeof fetch;
  const res = await proxyToApp(new Request(`https://website-18e4ecad.${DOMAIN}/`), "https://up.example", fake);
  assert.equal(init.redirect, "manual");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});
