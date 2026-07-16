import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { buildBootstrapConfig } from "../src/lib/routes/config.js";

async function withEnv(overrides: Record<string, any>, fn: () => any) {
  const restore: Record<string, any> = {};
  for (const [key, value] of Object.entries(overrides)) {
    restore[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // Await so env is held in place until the (possibly async) callback fully
    // resolves — otherwise the finally block restores env before an awaited
    // handler reads it.
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("buildBootstrapConfig returns mqtt block when env is set", () => {
  withEnv(
    {
      MQTT_BROKER_URL: "mqtts://mqtt.example.com:8883",
      MQTT_USERNAME: "user-1",
      MQTT_PASSWORD: "secret",
      MQTT_USE_TLS: "true",
      MQTT_PUBLIC_TCP_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      const cfg = buildBootstrapConfig();
      // Credentials are NEVER forwarded to clients — they authenticate to EMQX
      // with username=actor_id, password=<Supabase access_token> (JWT auth).
      assert.deepEqual(cfg, {
        mqtt: {
          url: "mqtts://mqtt.example.com:8883",
          useTls: true,
        },
      });
    },
  );
});

test("buildBootstrapConfig includes tcpUrl when MQTT_PUBLIC_TCP_BROKER_URL is set", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      MQTT_PUBLIC_BROKER_URL: "wss://claw.example.com/mqtt",
      MQTT_PUBLIC_TCP_BROKER_URL: "mqtt://claw.example.com:8080",
      MQTT_USE_TLS: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {
        mqtt: {
          url: "wss://claw.example.com/mqtt",
          tcpUrl: "mqtt://claw.example.com:8080",
        },
      });
    },
  );
});

test("buildBootstrapConfig omits mqtt when broker url is missing", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      MQTT_USERNAME: "user-1",
      MQTT_PASSWORD: "secret",
      MQTT_USE_TLS: "true",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("GET /v1/config/bootstrap requires bearer auth", async () => {
  const response = await handleBusinessApiRequest(
    { httpMethod: "GET", path: "/v1/config/bootstrap", headers: {} },
    { createRepository: () => ({}), createAuthRepository: () => ({}) },
  );
  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, "missing_auth");
});

test("GET /v1/config/bootstrap returns env-derived mqtt config to authed callers", async () => {
  await withEnv(
    {
      MQTT_BROKER_URL: "wss://mqtt.example.com:8884",
      MQTT_PUBLIC_TCP_BROKER_URL: undefined,
      MQTT_USERNAME: undefined,
      MQTT_PASSWORD: undefined,
      MQTT_USE_TLS: undefined,
      WEBSSO_LOGIN_URL: undefined,
    },
    async () => {
      const response = await handleBusinessApiRequest(
        {
          httpMethod: "GET",
          path: "/v1/config/bootstrap",
          headers: { Authorization: "Bearer caller-token" },
        },
        { createRepository: () => ({}), createAuthRepository: () => ({}) },
      );
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body, {
        mqtt: { url: "wss://mqtt.example.com:8884" },
      });
    },
  );
});

test("buildBootstrapConfig returns webSso block when env is set", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: "https://admin.example.test/sign-in",
      WEBSSO_STORAGE_KEY: "sb-test-supa-auth-token",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {
        webSso: {
          loginUrl: "https://admin.example.test/sign-in",
          storageKey: "sb-test-supa-auth-token",
        },
      });
    },
  );
});

test("buildBootstrapConfig omits webSso when login url is missing", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      WEBSSO_LOGIN_URL: undefined,
      WEBSSO_STORAGE_KEY: "sb-test-supa-auth-token",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("GET /v1/config/public returns webSso WITHOUT auth (login-time config)", async () => {
  await withEnv(
    {
      MQTT_BROKER_URL: "mqtts://secret.example.com:8883",
      WEBSSO_LOGIN_URL: "https://admin.example.test/sign-in",
      WEBSSO_STORAGE_KEY: "sb-test-supa-auth-token",
    },
    async () => {
      const response = await handleBusinessApiRequest(
        { httpMethod: "GET", path: "/v1/config/public", headers: {} },
        { createRepository: () => ({}), createAuthRepository: () => ({}) },
      );
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      // webSso is present; the sensitive mqtt block is NEVER in the public config.
      assert.deepEqual(body, {
        webSso: {
          loginUrl: "https://admin.example.test/sign-in",
          storageKey: "sb-test-supa-auth-token",
        },
      });
    },
  );
});
