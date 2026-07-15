/**
 * Self-host deployment verification tests.
 *
 * Prerequisites:
 *   docker compose up -d   (in deploy/self-host/)
 *
 * Run:
 *   cd services/fc
 *   FC_E2E=1 node --import tsx --test test/self-host-e2e.test.ts
 *
 * Optional env vars:
 *   FC_E2E_BASE_URL   — default: auto-discovered from docker inspect
 *   FC_E2E_KONG_URL   — default: auto-discovered from docker inspect
 *   FC_E2E_ENV_FILE   — path to self-host .env (default: ../../deploy/self-host/.env)
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const E2E = process.env.FC_E2E === "1";

// ── Container IP discovery ─────────────────────────────────────────────────

function containerIp(name: string): string {
  try {
    return execSync(
      `docker inspect ${name} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
      { stdio: ["pipe", "pipe", "pipe"] }
    ).toString().trim();
  } catch {
    return "";
  }
}

const FC_BASE = (
  process.env.FC_E2E_BASE_URL ?? `http://${containerIp("teamclaw-self-host-fc-1")}:9000`
).replace(/\/$/, "");

const KONG_BASE = (
  process.env.FC_E2E_KONG_URL ?? `http://${containerIp("supabase-kong")}:8000`
).replace(/\/$/, "");

// ── .env parser ────────────────────────────────────────────────────────────

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const result: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

const ENV_FILE =
  process.env.FC_E2E_ENV_FILE ??
  resolve(__dirname, "../../../deploy/self-host/.env");
const env = parseEnvFile(ENV_FILE);
const SERVICE_ROLE_KEY = env.SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY ?? "";

// ── Shared state (populated in before() hooks) ─────────────────────────────

const state = {
  accessToken: "",
  refreshToken: "",
  userId: "",
  teamId: "",
  teamName: "",
  sessionId: "",
};

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function fcFetch(
  path: string,
  opts: RequestInit & { token?: string } = {}
) {
  const { token, headers: extraHeaders, ...rest } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders as Record<string, string> ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${FC_BASE}${path}`, { ...rest, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function goFetch(
  path: string,
  opts: RequestInit & { serviceRole?: boolean; token?: string } = {}
) {
  const { serviceRole, token, headers: extraHeaders, ...rest } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders as Record<string, string> ?? {}),
  };
  if (serviceRole) {
    headers["apikey"] = SERVICE_ROLE_KEY;
    headers["Authorization"] = `Bearer ${SERVICE_ROLE_KEY}`;
  } else if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${KONG_BASE}${path}`, { ...rest, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function isDaemonRunning(): boolean {
  try {
    const out = execSync(
      'docker inspect teamclaw-self-host-amuxd-1 --format "{{.State.Running}}"',
      { stdio: ["pipe", "pipe", "pipe"] }
    )
      .toString()
      .trim();
    return out === "true";
  } catch {
    return false;
  }
}

// ── Global setup / teardown ────────────────────────────────────────────────

const TEST_EMAIL = `e2e-${Date.now()}@selfhost.test`;
const TEST_PASSWORD = `E2ePass-${Date.now()}`;

before(async () => {
  if (!E2E) return;
  assert.ok(SERVICE_ROLE_KEY, "SERVICE_ROLE_KEY must be set (check FC_E2E_ENV_FILE)");
  assert.ok(FC_BASE.includes("://"), `FC_BASE looks invalid: ${FC_BASE}`);
  assert.ok(KONG_BASE.includes("://"), `KONG_BASE looks invalid: ${KONG_BASE}`);

  // Create confirmed test user via GoTrue admin API
  const create = await goFetch("/auth/v1/admin/users", {
    method: "POST",
    serviceRole: true,
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    }),
  });
  assert.equal(
    create.status,
    200,
    `Failed to create test user: ${JSON.stringify(create.body)}`
  );
  state.userId = create.body.id;

  // Sign in with email+password to get a session
  const signin = await goFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    serviceRole: true, // apikey header required by GoTrue
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  assert.equal(
    signin.status,
    200,
    `Failed to sign in: ${JSON.stringify(signin.body)}`
  );
  state.accessToken = signin.body.access_token;
  state.refreshToken = signin.body.refresh_token;
});

after(async () => {
  if (!E2E || !state.userId) return;
  // Delete test user (best-effort)
  await goFetch(`/auth/v1/admin/users/${state.userId}`, {
    method: "DELETE",
    serviceRole: true,
  }).catch(() => {});
});

// ── Suite 1: Auth ──────────────────────────────────────────────────────────

describe("Auth", { skip: !E2E }, () => {
  test("POST /v1/auth/refresh returns new accessToken", async () => {
    const { status, body } = await fcFetch("/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    assert.equal(status, 200, `refresh failed: ${JSON.stringify(body)}`);
    assert.equal(typeof body.accessToken, "string", "accessToken must be a string");
    assert.ok(body.accessToken.length > 0, "accessToken must be non-empty");
    assert.equal(typeof body.refreshToken, "string", "refreshToken must be a string");
    // Update state so subsequent suites use the fresh token
    state.accessToken = body.accessToken;
    state.refreshToken = body.refreshToken;
  });
});

// ── Suite 2: Team lifecycle ────────────────────────────────────────────────

describe("Team lifecycle", { skip: !E2E }, () => {
  state.teamName = `e2e-team-${Date.now()}`;

  test("POST /v1/teams creates a team", async () => {
    const { status, body } = await fcFetch("/v1/teams", {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({ name: state.teamName }),
    });
    // teams.ts returns no explicit statusCode so Hono defaults to 200
    assert.ok(
      status === 200 || status === 201,
      `createTeam failed (${status}): ${JSON.stringify(body)}`
    );
    assert.equal(typeof body.id, "string", "team.id must be a string");
    assert.ok(body.id.length > 0, "team.id must be non-empty");
    state.teamId = body.id;
  });

  test("GET /v1/teams lists the new team", async () => {
    const { status, body } = await fcFetch("/v1/teams", {
      token: state.accessToken,
    });
    assert.equal(status, 200, `listTeams failed: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");
    const found = body.items.some((t: any) => t.id === state.teamId);
    assert.ok(found, `team ${state.teamId} not found in list`);
  });

  test("GET /v1/teams/:id returns correct team", async () => {
    const { status, body } = await fcFetch(`/v1/teams/${state.teamId}`, {
      token: state.accessToken,
    });
    assert.equal(status, 200, `getTeam failed: ${JSON.stringify(body)}`);
    assert.equal(body.id, state.teamId);
    assert.equal(body.name, state.teamName);
  });

  test("POST /v1/teams/:id/invites returns invite token", async () => {
    const { status, body } = await fcFetch(`/v1/teams/${state.teamId}/invites`, {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({ kind: "member", displayName: "E2E Invitee", teamRole: "member" }),
    });
    assert.equal(status, 201, `createInvite failed: ${JSON.stringify(body)}`);
    // invite token may be in body.token or body.inviteToken
    const token = body.token ?? body.inviteToken ?? body.invite_token;
    assert.equal(typeof token, "string", `invite token must be a string, got: ${JSON.stringify(body)}`);
    assert.ok(token.length > 0, "invite token must be non-empty");
  });
});

// ── Suite 3: Session + Messages ────────────────────────────────────────────

describe("Session + Messages", { skip: !E2E }, () => {
  const sessionTitle = `e2e-session-${Date.now()}`;

  test("POST /v1/sessions creates a session", async () => {
    const { status, body } = await fcFetch("/v1/sessions", {
      method: "POST",
      token: state.accessToken,
      body: JSON.stringify({
        teamId: state.teamId,
        title: sessionTitle,
        mode: "solo",
      }),
    });
    assert.equal(status, 201, `createSession failed: ${JSON.stringify(body)}`);
    assert.equal(typeof body.id, "string", "session.id must be a string");
    assert.ok(body.id.length > 0);
    state.sessionId = body.id;
  });

  test("GET /v1/sessions/:id returns the session", async () => {
    const { status, body } = await fcFetch(`/v1/sessions/${state.sessionId}`, {
      token: state.accessToken,
    });
    assert.equal(status, 200, `getSession failed: ${JSON.stringify(body)}`);
    assert.equal(body.id, state.sessionId);
    assert.equal(body.title, sessionTitle);
  });

  test("GET /v1/sessions/:id/messages returns array", async () => {
    const { status, body } = await fcFetch(
      `/v1/sessions/${state.sessionId}/messages`,
      { token: state.accessToken }
    );
    assert.equal(status, 200, `listMessages failed: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");
  });

  test("GET /v1/sync/actor-directory lists daemon actor (daemon-gated)", async (t) => {
    if (!isDaemonRunning()) {
      t.skip("amuxd container not running — skipping daemon actor check");
      return;
    }
    const { status, body } = await fcFetch(
      `/v1/sync/actor-directory?teamId=${encodeURIComponent(state.teamId)}`,
      { token: state.accessToken }
    );
    assert.equal(status, 200, `actorDirectory failed: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");
    const hasDaemon = body.items.some((a: any) => a.clientKind === "daemon");
    assert.ok(hasDaemon, "No daemon actor found in directory — is amuxd joined to this team?");
  });
});

// ── Suite 4: Storage ───────────────────────────────────────────────────────

describe("Storage", { skip: !E2E }, () => {
  test("image-upload.sh round-trips a PNG byte-for-byte", () => {
    const smokeScript = resolve(
      __dirname,
      "../../../deploy/self-host/smoke/image-upload.sh"
    );
    let stdout = "";
    try {
      stdout = execSync(`sh "${smokeScript}"`, {
        cwd: resolve(__dirname, "../../../deploy/self-host"),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      }).toString();
    } catch (err: any) {
      const out = err.stdout?.toString() ?? "";
      const errOut = err.stderr?.toString() ?? "";
      assert.fail(`image-upload.sh failed:\nstdout: ${out}\nstderr: ${errOut}`);
    }
    assert.match(stdout, /PASS/, `image-upload.sh did not print PASS:\n${stdout}`);
  });
});
